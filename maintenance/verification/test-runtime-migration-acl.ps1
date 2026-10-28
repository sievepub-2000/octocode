param(
    [string]$ScriptPath = (Join-Path $PSScriptRoot '..\migrate-runtime-to-e.ps1'),
    [ValidateSet('None','Root','Special')][string]$Fault = 'None'
)
$ErrorActionPreference = 'Stop'
$fixture = 'E:\Program Files\octocode\test\octocode-migration-'+[guid]::NewGuid().ToString('N')
$installed = Join-Path $fixture 'installed'
$legacy = Join-Path $fixture 'legacy'
New-Item -ItemType Directory -Path $installed,$legacy | Out-Null
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$access = [Security.AccessControl.AccessControlSections]::Access
function Assert($Condition, [string]$Message) { if (!$Condition) { throw $Message } }
function Set-PrivateAccess([string]$Path, [switch]$Directory, [switch]$OwnerRights) {
    $acl = Get-Acl -LiteralPath $Path
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($rule) }
    $inheritance = if ($Directory) { 'ContainerInherit, ObjectInherit' } else { 'None' }
    $principal = if ($OwnerRights) { [Security.Principal.SecurityIdentifier]::new('S-1-3-4') } else { $sid }
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($principal, 'FullControl', $inheritance, 'None', 'Allow'))
    Set-Acl -LiteralPath $Path -AclObject $acl
}
function Snapshot([string]$Root) {
    @(@(Get-Item -LiteralPath $Root -Force) + @(Get-ChildItem -LiteralPath $Root -Force -Recurse) | ForEach-Object {
        $acl = Get-Acl -LiteralPath $_.FullName
        $digest = if ($_.PSIsContainer) { 'directory' } else { (Get-FileHash -LiteralPath $_.FullName).Hash }
        $_.FullName.Substring($Root.Length)+':'+$digest+':'+$acl.Owner+':'+$acl.GetSecurityDescriptorSddlForm($access)
    } | Sort-Object) -join "`n"
}

# Make the source parent differ from the installation parent. The migrated roots
# inherit AU Modify here, which would be lost if E's parent ACL were substituted.
$acl = Get-Acl -LiteralPath $legacy
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($rule) }
foreach ($principal in @($sid, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'), [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) {
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($principal, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow'))
}
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-11'), 'Modify', 'ContainerInherit, ObjectInherit', 'None', 'Allow'))
Set-Acl -LiteralPath $legacy -AclObject $acl
# Reproduce an existing Windows parent whose canonical Allow ACEs are in BA/SY/AU/BU
# order. Managed Set-Acl sorts these by SID, so write this owned fixture's DACL
# through the Windows API to retain the real source's historical order.
if (!('MigrationAclFixture.NativeSecurity' -as [type])) {
    Add-Type @'
using System.Runtime.InteropServices;
namespace MigrationAclFixture {
    public static class NativeSecurity {
        [DllImport("advapi32.dll", EntryPoint="SetFileSecurityW", CharSet=CharSet.Unicode, SetLastError=true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool SetFileSecurity(string path, uint sections, byte[] descriptor);
    }
}
'@
}
$rawParent = [Security.AccessControl.RawSecurityDescriptor]::new('D:P(A;OICI;FA;;;BA)(A;OICI;FA;;;SY)(A;OICI;0x1301bf;;;AU)(A;OICI;0x1200a9;;;BU)')
$parentBinary = [byte[]]::new($rawParent.BinaryLength)
$rawParent.GetBinaryForm($parentBinary, 0)
Assert ([MigrationAclFixture.NativeSecurity]::SetFileSecurity($legacy, [uint32]2147483652, $parentBinary)) 'Could not set the owned fixture parent DACL'
foreach ($name in @('workspace','environments')) {
    $source = Join-Path $legacy $name
    New-Item -ItemType Directory -Path $source,(Join-Path $source 'empty'),(Join-Path $source 'private'),(Join-Path $source 'ordinary') | Out-Null
    Set-Content -LiteralPath (Join-Path $source 'ordinary\inherited.txt') -Value 'owned inherited content'
    Set-Content -LiteralPath (Join-Path $source 'private\secret.txt') -Value 'owned private fixture, no user secret'
    Set-PrivateAccess (Join-Path $source 'private') -Directory -OwnerRights
    Set-Content -LiteralPath (Join-Path $source 'private-file.txt') -Value 'owned protected fixture'
    Set-PrivateAccess (Join-Path $source 'private-file.txt')
    $fileAcl = Get-Acl -LiteralPath (Join-Path $source 'ordinary\inherited.txt')
    $unassignedSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-21-111111111-222222222-333333333-4444')
    $fileAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($unassignedSid, 'Read', 'Allow'))
    $fileAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($unassignedSid, 'WriteData', 'Deny'))
    Set-Acl -LiteralPath (Join-Path $source 'ordinary\inherited.txt') -AclObject $fileAcl
    $directoryAcl = Get-Acl -LiteralPath (Join-Path $source 'ordinary')
    $directoryAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($unassignedSid, 'Read', 'ContainerInherit, ObjectInherit', 'InheritOnly, NoPropagateInherit', 'Allow'))
    Set-Acl -LiteralPath (Join-Path $source 'ordinary') -AclObject $directoryAcl
    New-Item -ItemType Junction -Path (Join-Path $installed $name) -Target $source | Out-Null
}
# A previously migrated data directory must remain physical and untouched.
New-Item -ItemType Directory -Path (Join-Path $installed 'data') | Out-Null
Set-Content -LiteralPath (Join-Path $installed 'data\sentinel.txt') -Value 'already migrated data'
$dataBefore = Snapshot (Join-Path $installed 'data')
$sourceBefore = Snapshot $legacy

# An in-memory source descriptor owned by BA exercises the same unprivileged
# owner boundary as production; no source owner is changed on disk.
$syntax = [Management.Automation.Language.Parser]::ParseFile($ScriptPath, [ref]$null, [ref]$null)
$copy = $syntax.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Copy-AccessOnly' }, $true)
if (!$copy) { throw 'Copy-AccessOnly helper is missing' }
Invoke-Expression $copy.Extent.Text
$normalize = $syntax.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Normalized-AccessRules' }, $true)
if (!$normalize) { throw 'Normalized-AccessRules helper is missing' }
Invoke-Expression $normalize.Extent.Text
$allowBeforeInheritedDeny = [Security.AccessControl.DirectorySecurity]::new()
$allowBeforeInheritedDeny.SetSecurityDescriptorSddlForm('D:(A;;FR;;;AU)(D;ID;FW;;;BU)')
$denyBeforeInheritedAllow = [Security.AccessControl.DirectorySecurity]::new()
$denyBeforeInheritedAllow.SetSecurityDescriptorSddlForm('D:(D;;FW;;;BU)(A;ID;FR;;;AU)')
Assert ((Normalized-AccessRules $allowBeforeInheritedDeny) -cne (Normalized-AccessRules $denyBeforeInheritedAllow)) 'Normalization crossed a Deny/Allow boundary'
foreach ($changed in @('D:(A;;FW;;;AU)(D;ID;FW;;;BU)', 'D:(A;OICIIO;FR;;;AU)(D;ID;FW;;;BU)', 'D:(A;;FR;;;SY)(D;ID;FW;;;BU)')) {
    $different = [Security.AccessControl.DirectorySecurity]::new()
    $different.SetSecurityDescriptorSddlForm($changed)
    Assert ((Normalized-AccessRules $allowBeforeInheritedDeny) -cne (Normalized-AccessRules $different)) 'Normalization lost a mask, propagation flag or SID'
}
$probe = Join-Path $installed 'owner-probe.txt'
Set-Content -LiteralPath $probe -Value 'owned owner-boundary probe'
$ownerBefore = (Get-Acl -LiteralPath $probe).Owner
$sourceAcl = Get-Acl -LiteralPath (Join-Path $legacy 'workspace\private-file.txt')
$sourceAcl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
Copy-AccessOnly $sourceAcl $probe
Assert ((Get-Acl -LiteralPath $probe).Owner -ceq $ownerBefore) 'Access-only copy changed the destination owner'

if ($Fault -ne 'None') {
    $faultyScript = Join-Path $fixture 'fault-injected-migration.ps1'
    $originalText = Get-Content -LiteralPath $ScriptPath -Raw
    $omitted = if ($Fault -eq 'Root') { 'Copy-AccessOnly (Get-Acl -LiteralPath $source) $stage -MaterializeRoot' } else { 'Copy-SpecialAccess $source $stage' }
    Assert ($originalText.Contains($omitted)) 'Fault injection did not find the intended call'
    Set-Content -LiteralPath $faultyScript -Value $originalText.Replace($omitted, '# fixture deliberately omits required access preservation')
    $rejected = $false
    try { & $faultyScript -Apply -InstallRoot $installed -LegacyRoot $legacy -Names workspace,environments }
    catch { if ($_.Exception.Message -notlike '*Migration access verification failed*') { throw }; $rejected = $true }
    Assert $rejected 'ACL corruption did not stop migration'
    Assert ((Snapshot $legacy) -ceq $sourceBefore) 'Rejected migration changed the source'
    Assert ((Snapshot (Join-Path $installed 'data')) -ceq $dataBefore) 'Rejected migration changed already migrated data'
    Assert ((Get-Item -LiteralPath (Join-Path $installed 'workspace') -Force).LinkType -eq 'Junction') 'Rejected migration removed the original junction'
    "PASS: $Fault ACL omission rejected before junction replacement; original and failed staging retained. Fixture: $fixture"
    return
}
& $ScriptPath -Apply -InstallRoot $installed -LegacyRoot $legacy -Names workspace,environments
Assert ((Snapshot $legacy) -ceq $sourceBefore) 'Source contents, ownership or DACL changed'
Assert ((Snapshot (Join-Path $installed 'data')) -ceq $dataBefore) 'Already migrated data changed'
foreach ($name in @('workspace','environments')) {
    $target = Join-Path $installed $name
    Assert (!((Get-Item -LiteralPath $target -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) 'Destination is still a junction'
    Assert ((Get-Acl -LiteralPath $target).AreAccessRulesProtected) 'Root access boundary was not materialized'
    Assert (Test-Path -LiteralPath (Join-Path $target 'empty') -PathType Container) 'Empty directory was lost'
    foreach ($private in @('private','private-file.txt')) {
        $privateAcl = Get-Acl -LiteralPath (Join-Path $target $private)
        Assert $privateAcl.AreAccessRulesProtected 'Private DACL lost protection'
        Assert (@($privateAcl.Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq 'S-1-5-11' }).Count -eq 0) 'Private object inherited AU access'
    }
}
"PASS: two real E fixture migrations; inherited/explicit/protected ACLs, empty directories, owner isolation, content hashes and unchanged sources/data. Retained fixture: $fixture"
