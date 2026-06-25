param(
  [Parameter(Mandatory = $false)]
  [string] $OutputPath = "$PSScriptRoot\AgentQueueInstaller.exe",

  [Parameter(Mandatory = $false)]
  [string] $Version = "0.1.0"
)

$ErrorActionPreference = "Stop"

$resolvedOutput = if ([System.IO.Path]::IsPathRooted($OutputPath)) { $OutputPath } else { Join-Path $PSScriptRoot $OutputPath }
$OutputPath = $resolvedOutput

$workDir = Join-Path $env:TEMP "agentqueue-installer-exe"
$staging = Join-Path $workDir "staging"
$sedPath = Join-Path $workDir "agentqueue-installer.sed"
$installerExe = Join-Path $staging "AgentQueueInstaller.exe"

if (Test-Path $workDir) {
  Remove-Item -Recurse -Force -LiteralPath $workDir
}
New-Item -ItemType Directory -Path $staging -Force | Out-Null

$sourceInstall = Join-Path $PSScriptRoot "install.ps1"
Copy-Item -LiteralPath $sourceInstall -Destination (Join-Path $staging "install.ps1") -Force

Set-Content -Path (Join-Path $staging "run-installer.cmd") -Value @'
@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
'@ -NoNewline

Set-Content -Path $sedPath -Value @"
[Version]
Class=IEXPRESS
SEDVersion=3
[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=0
HideExtractAnimation=1
UseLongFileName=1
InsideCompressed=1
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=I
InstallPrompt=
DisplayLicense=
FinishMessage=
TargetName=%TargetName%
FriendlyName=%FriendlyName%
AppLaunched=%AppLaunched%
PostInstallCmd=<None>
AdminQuietInstCmd=
UserQuietInstCmd=
SourceFiles=SourceFiles

[Strings]
TargetName=AgentQueueInstaller.exe
FriendlyName=AgentQueue Installer
AppLaunched=run-installer.cmd
PostInstallCmd=<None>
FILE0=install.ps1
FILE1=run-installer.cmd

[SourceFiles]
SourceFiles0=.
[SourceFiles0]
%FILE0%=
%FILE1%=
"@

Set-Location $staging
iexpress /N $sedPath

if (-not (Test-Path $installerExe)) {
  $deadline = (Get-Date).AddSeconds(5)
  while ((Get-Date) -lt $deadline) {
    if (Test-Path $installerExe) { break }
    Start-Sleep -Milliseconds 250
  }
}

if (-not (Test-Path $installerExe)) {
  throw "IExpress did not create the installer executable at $installerExe."
}

New-Item -ItemType Directory -Path (Split-Path $OutputPath -Parent) -Force | Out-Null
if (([IO.Path]::GetFullPath($installerExe)) -ne ([IO.Path]::GetFullPath($OutputPath))) {
  Copy-Item -LiteralPath $installerExe -Destination $OutputPath -Force
}

Write-Host "Built installer:"
Write-Host "  $OutputPath"
