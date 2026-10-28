param(
    [switch]$Apply,
    [string]$InstallRoot = 'E:\Program Files\octocode',
    [string]$LegacyRoot = 'D:\gpt-workspace\octocode\runtime',
    [ValidateSet('data', 'workspace', 'environments')][string[]]$Names = @('data', 'workspace', 'environments')
)
$ErrorActionPreference = 'Stop'
$install = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
$legacy = [IO.Path]::GetFullPath($LegacyRoot).TrimEnd('\')
$fixture = $install -match '^E:\\Program Files\\octocode\\test\\octocode-migration-[a-f0-9]{32}\\installed$'
if (($install -ine 'E:\Program Files\octocode' -or $legacy -ine 'D:\gpt-workspace\octocode\runtime') -and
    (!$fixture -or $legacy -ine (Join-Path (Split-Path $install -Parent) 'legacy'))) { throw 'Migration roots must be the formal installation or one owned E test fixture' }
if (!$Names.Count -or @($Names | Select-Object -Unique).Count -ne $Names.Count) { throw 'Select each migration directory at most once' }
foreach ($root in @($install, $legacy)) {
    $cursor = $root
    while ($cursor) {
        $entry = Get-Item -LiteralPath $cursor -Force
        if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Migration roots and their parents must be physical directories' }
        $cursor = [IO.Path]::GetDirectoryName($cursor)
    }
}
foreach ($name in $names) {
    $entry = Get-Item -LiteralPath (Join-Path $install $name) -Force
    $expected = Join-Path $legacy $name
    if ($entry.LinkType -ne 'Junction' -or ([string]@($entry.Target)[0]).Replace('\\?\', '').TrimEnd('\') -ine $expected) {
        throw "Migration requires the known legacy junction: $name"
    }
    if ((Get-Item -LiteralPath $expected -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Legacy storage must be physical' }
}
if (!$Apply) { "Validated $($Names.Count) selected legacy junction(s). Apply requires all installed processes to exit."; return }
function Assert-Stopped {
 $running = @(Get-CimInstance Win32_Process | Where-Object {
    # Independently staged test runtimes live outside all three migrated trees.
    $_.ExecutablePath -and (($_.ExecutablePath.StartsWith($install+'\', [StringComparison]::OrdinalIgnoreCase) -and
        !$_.ExecutablePath.StartsWith($install+'\test\', [StringComparison]::OrdinalIgnoreCase)) -or
        $_.ExecutablePath.StartsWith($legacy+'\', [StringComparison]::OrdinalIgnoreCase))
})
 if ($running.Count) { throw 'Save work and exit OctoCode and its owned tasks before migration' }
}
Assert-Stopped

function Manifest([string]$Root) {
    $records = [Collections.Generic.List[string]]::new()
    $pending = [Collections.Generic.Stack[string]]::new()
    $pending.Push($Root)
    while ($pending.Count) {
        foreach ($entry in Get-ChildItem -LiteralPath $pending.Pop() -Force) {
            $relative = $entry.FullName.Substring($Root.Length)
            if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                $records.Add('link:'+$relative+':'+(@($entry.Target)-join '|'))
            } elseif ($entry.PSIsContainer) {
                $records.Add('directory:'+$relative)
                $pending.Push($entry.FullName)
            } else {
                $records.Add('file:'+$relative+':'+$entry.Length+':'+(Get-FileHash -LiteralPath $entry.FullName).Hash)
            }
        }
    }
    @($records | Sort-Object)
}

function Copy-AccessOnly([Security.AccessControl.FileSystemSecurity]$SourceAcl, [string]$Target, [switch]$MaterializeRoot) {
    $accessSection = [Security.AccessControl.AccessControlSections]::Access
    $descriptor = [Security.AccessControl.RawSecurityDescriptor]::new($SourceAcl.GetSecurityDescriptorBinaryForm(), 0)
    if ($MaterializeRoot) {
        # Inherited ACEs from D's parent cannot remain inherited from E's different parent.
        # Pin their existing order, masks and propagation flags at this one new boundary.
        foreach ($ace in $descriptor.DiscretionaryAcl) {
            $ace.AceFlags = $ace.AceFlags -band (-bnot [Security.AccessControl.AceFlags]::Inherited)
        }
        $descriptor.SetFlags($descriptor.ControlFlags -bor [Security.AccessControl.ControlFlags]::DiscretionaryAclProtected)
    }
    $binary = [byte[]]::new($descriptor.BinaryLength)
    $descriptor.GetBinaryForm($binary, 0)
    $targetAcl = Get-Acl -LiteralPath $Target
    # Deliberately never copy owner, primary group or SACL (which require restore/security privileges).
    $targetAcl.SetSecurityDescriptorBinaryForm($binary, $accessSection)
    Set-Acl -LiteralPath $Target -AclObject $targetAcl
}

function Normalized-AccessRules([Security.AccessControl.FileSystemSecurity]$Acl) {
    $groups = [Collections.Generic.List[string]]::new()
    $run = [Collections.Generic.List[string]]::new()
    $lastType = $null
    foreach ($rule in $Acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        $type = [int]$rule.AccessControlType
        if ($null -ne $lastType -and $type -ne $lastType) {
            $groups.Add((@($run | Sort-Object) -join '|'))
            $run.Clear()
        }
        $run.Add($rule.IdentityReference.Value+':'+$type+':'+[int]$rule.FileSystemRights+':'+[int]$rule.InheritanceFlags+':'+[int]$rule.PropagationFlags)
        $lastType = $type
    }
    if ($run.Count) { $groups.Add((@($run | Sort-Object) -join '|')) }
    # Windows can reorder a contiguous Allow (or Deny) run when inheritance is
    # materialized. Those operations commute. Never sort across a type boundary:
    # an Allow before an inherited Deny must remain before that Deny.
    $groups -join '||'
}

function Access-Manifest([string]$Root, [ref]$ExactSnapshot, [ref]$SpecialPaths) {
    $records = [Collections.Generic.List[string]]::new()
    $exact = [Collections.Generic.List[string]]::new()
    $special = [Collections.Generic.List[string]]::new()
    $pending = [Collections.Generic.Stack[string]]::new()
    $pending.Push($Root)
    while ($pending.Count) {
        $path = $pending.Pop()
        $entry = Get-Item -LiteralPath $path -Force
        if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            # Get-Acl follows links; do not read or change an unrelated target's security.
            throw "Migration requires a separate link-security review: $path"
        }
        $acl = Get-Acl -LiteralPath $path
        if (!$acl.AreAccessRulesCanonical) { throw "Noncanonical source or staging ACL: $path" }
        $relative = $path.Substring($Root.Length)
        if ($null -ne $ExactSnapshot) {
            $exact.Add($relative+':'+$acl.Owner+':'+$acl.Group+':'+$acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access))
        }
        if ($null -ne $SpecialPaths -and $relative -and
            ($acl.AreAccessRulesProtected -or $acl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]).Count)) {
            $special.Add($relative)
        }
        # The root is deliberately protected after materializing its old inherited rules.
        # Every child must preserve its actual inheritance-protection setting.
        $protected = if (!$relative) { $true } else { $acl.AreAccessRulesProtected }
        $rules = Normalized-AccessRules $acl
        # Preserve Deny/Allow boundaries, every duplicate ACE, mask and propagation flag.
        $records.Add('acl:'+$relative+':'+[int]$protected+':'+$rules)
        if ($entry.PSIsContainer) {
            foreach ($child in Get-ChildItem -LiteralPath $path -Force) { $pending.Push($child.FullName) }
        }
    }
    if ($null -ne $ExactSnapshot) { $ExactSnapshot.Value = @($exact | Sort-Object) -join "`n" }
    if ($null -ne $SpecialPaths) { $SpecialPaths.Value = @($special | Sort-Object { $_.Length }, { $_ }) }
    @($records | Sort-Object)
}

function Copy-SpecialAccess([string]$Source, [string]$Target, [string[]]$RelativePaths) {
    # The source manifest already found these paths and ordered parents before children.
    foreach ($relative in $RelativePaths) {
        $entry = Get-Item -LiteralPath ($Source+$relative) -Force
        if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Link security was not approved by the source access manifest' }
        Copy-AccessOnly (Get-Acl -LiteralPath $entry.FullName) ($Target+$relative)
    }
}

foreach ($name in $names) {
    $source = Join-Path $legacy $name
    $destination = Join-Path $install $name
    $stage = Join-Path $install ($name+'.migration-'+[guid]::NewGuid().ToString('N'))
    if (![IO.Path]::GetFullPath($stage).StartsWith($install+'\', [StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $stage)) {
        throw 'Migration stage is not a new directory inside the installation'
    }
    New-Item -ItemType Directory -Path $stage | Out-Null
    $accessSection = [Security.AccessControl.AccessControlSections]::Access
    $sourceRootAcl = (Get-Acl -LiteralPath $source).GetSecurityDescriptorSddlForm($accessSection)
    $exactAccessBefore = $null
    $specialAccess = $null
    Write-Output "Reading source access rules without changing ownership: $name"
    $accessBefore = (Access-Manifest $source ([ref]$exactAccessBefore) ([ref]$specialAccess)) -join "`n"
    Copy-AccessOnly (Get-Acl -LiteralPath $source) $stage -MaterializeRoot
    Write-Output "Hashing the stopped source directory: $name"
    $before = (Manifest $source) -join "`n"
    $copyOutput = @(& robocopy.exe $source $stage /E /COPY:DAT /DCOPY:DAT /SL /SJ /R:1 /W:1 /NP /NFL /NDL /NJH /NJS)
    if ($LASTEXITCODE -gt 7) {
        Write-Output $copyOutput
        throw "Copy failed for $name; original and staging files retained"
    }
    Write-Output "Preserving explicit and protected child access rules: $name"
    Copy-SpecialAccess $source $stage $specialAccess
    Write-Output "Copied $name; comparing every file and link against the stopped source"
    if ($before -cne ((Manifest $stage) -join "`n") -or $before -cne ((Manifest $source) -join "`n")) {
        throw "Migration verification failed for $name; original and staging files retained"
    }
    $exactAccessAfter = $null
    Write-Output "Comparing all source and staging access rules: $name"
    $accessAfter = (Access-Manifest $source ([ref]$exactAccessAfter)) -join "`n"
    $stageAccess = (Access-Manifest $stage) -join "`n"
    $rootProtected = (Get-Acl -LiteralPath $stage).AreAccessRulesProtected
    if (!$rootProtected -or $accessBefore -cne $stageAccess -or
        $accessBefore -cne $accessAfter -or $exactAccessBefore -cne $exactAccessAfter -or
        $sourceRootAcl -cne (Get-Acl -LiteralPath $source).GetSecurityDescriptorSddlForm($accessSection)) {
        $reason = 'source access rules, owner or group changed during migration'
        if (!$rootProtected) { $reason = 'staging root DACL is not protected' }
        elseif ($accessBefore -cne $stageAccess) {
            $first = Compare-Object ($accessBefore -split "`n") ($stageAccess -split "`n") -CaseSensitive | Select-Object -First 1
            $relative = [regex]::Match($first.InputObject, '^acl:([^:]*):').Groups[1].Value
            if (!$relative) { $relative = '<root>' }
            $reason = "staging ACL differs at $relative"
        }
        throw "Migration access verification failed for $name ($reason); original and staging files retained at $stage"
    }
    # Remove only the known junction; the source remains available until acceptance.
    Assert-Stopped
    $entry = Get-Item -LiteralPath $destination -Force
    if ($entry.LinkType -ne 'Junction' -or ([string]@($entry.Target)[0]).Replace('\\?\', '').TrimEnd('\') -ine $source) {
        throw 'Migration junction changed during verification'
    }
    [IO.Directory]::Delete($destination)
    try {
        Move-Item -LiteralPath $stage -Destination $destination
    } catch {
        if (!(Test-Path -LiteralPath $destination)) { New-Item -ItemType Junction -Path $destination -Target $source | Out-Null }
        throw
    }
    Write-Output "Migrated and verified $name to a physical E directory. Legacy source retained pending acceptance."
}
