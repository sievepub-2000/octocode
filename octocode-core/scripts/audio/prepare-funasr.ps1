[CmdletBinding()]
param(
 [string]$EnvironmentsRoot=$env:OCTOCODE_ENVIRONMENTS,
 [string]$CacheDirectory,
 [switch]$VerifyOnly
)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
if (!$EnvironmentsRoot) {throw 'Set OCTOCODE_ENVIRONMENTS or pass -EnvironmentsRoot for the installed product.'}
$target=Join-Path ([IO.Path]::GetFullPath($EnvironmentsRoot)) 'funasr'
$artifacts=@(
 @{name='funasr-windows-x64.zip';url='https://github.com/modelscope/FunASR/releases/download/runtime-llamacpp-v0.2.6/funasr-llamacpp-windows-x64.zip';hash='f6a73a548413ba9fbaf2145263ea66ec53cbdad1fb11790dbeeee493e339492e'},
 @{name='sensevoice-small-q8.gguf';url='https://huggingface.co/FunAudioLLM/SenseVoiceSmall-GGUF/resolve/main/sensevoice-small-q8.gguf';hash='4ae45c94422de949b387e2e0fb10d7e14e4c42c69db30c3444ecc7d4b844b7c5'},
 @{name='fsmn-vad.gguf';url='https://huggingface.co/FunAudioLLM/fsmn-vad-GGUF/resolve/main/fsmn-vad.gguf';hash='1270f2559c495f4e7b6e739541151027d360761a3fda43fc147034f5719f5479'}
)
if (!$VerifyOnly) {
 if (!$CacheDirectory) {$CacheDirectory=Join-Path $env:TEMP 'octocode-funasr-0.2.6'}
 $cache=[IO.Path]::GetFullPath($CacheDirectory)
 New-Item -ItemType Directory -Force -Path $cache | Out-Null
 foreach($artifact in $artifacts) {
  $file=Join-Path $cache $artifact.name
  if (!(Test-Path -LiteralPath $file)) {Invoke-WebRequest -UseBasicParsing -Uri $artifact.url -OutFile $file}
  if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $artifact.hash) {throw "Hash mismatch: $($artifact.name); remove the invalid cached file and retry."}
 }
 New-Item -ItemType Directory -Force -Path (Join-Path $target 'models') | Out-Null
 $unpacked=Join-Path $cache 'runtime-verified'
 Expand-Archive -LiteralPath (Join-Path $cache 'funasr-windows-x64.zip') -DestinationPath $unpacked -Force
 $executables=@(Get-ChildItem -LiteralPath $unpacked -Recurse -File -Filter 'llama-funasr-sensevoice.exe')
 if($executables.Count -ne 1){throw 'Unexpected FunASR archive layout.'}
 Copy-Item -LiteralPath $executables[0].FullName -Destination (Join-Path $target 'llama-funasr-sensevoice.exe') -Force
 foreach($artifact in $artifacts | Select-Object -Skip 1) {Copy-Item -LiteralPath (Join-Path $cache $artifact.name) -Destination (Join-Path $target ('models\'+$artifact.name)) -Force}
 foreach($name in @('NOTICE.txt','LICENSE-FunASR.txt','LICENSE-Models.txt')) {Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $target $name) -Force}
}
foreach($artifact in $artifacts | Select-Object -Skip 1) {
 $file=Join-Path $target ('models\'+$artifact.name)
 if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $artifact.hash) {throw "Model verification failed: $file"}
}
if (!(Test-Path -LiteralPath (Join-Path $target 'llama-funasr-sensevoice.exe') -PathType Leaf)) {throw 'Missing FunASR executable.'}
if ((Get-FileHash -LiteralPath (Join-Path $target 'llama-funasr-sensevoice.exe') -Algorithm SHA256).Hash -ne 'e92b69bc3b0d395dc611572566f91abcf5318ef7a54b27dcdf445bd231ded426') {throw 'FunASR executable verification failed.'}
@{provider='funasr-local';runtime='0.2.6';model='sensevoice-small-q8.gguf';directory=(Join-Path $target 'models');verified=$true} | ConvertTo-Json
