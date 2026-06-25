param(
    [Parameter(Mandatory = $false)]
    [string] $Version = "0.1.0",

    [Parameter(Mandatory = $false)]
    [string] $InstallPath = "$env:LOCALAPPDATA\AgentQueue",

    [switch] $Launch
)

$ErrorActionPreference = "Stop"

$tag = if ($Version -like "v*") { $Version } else { "v$Version" }
$archiveUrl = "https://github.com/pa911-eric/AgentQueue/archive/refs/tags/$tag.zip"
$zipPath = Join-Path $env:TEMP ("agentqueue-$tag.zip")
$extractPath = Join-Path $env:TEMP ("agentqueue-$tag")
$versionWithoutV = $tag.TrimStart("v")
$repoRoot = Join-Path $extractPath "AgentQueue-$versionWithoutV"
$alternateRepoRoot = Join-Path $extractPath "AgentQueue-$tag"

Write-Host "Downloading $tag ..."
Invoke-WebRequest -UseBasicParsing -Uri $archiveUrl -OutFile $zipPath

if (Test-Path $extractPath) {
  Remove-Item -Recurse -Force -LiteralPath $extractPath
}

Expand-Archive -LiteralPath $zipPath -DestinationPath $extractPath -Force

if (-not (Test-Path $repoRoot)) {
  if (Test-Path $alternateRepoRoot) {
    Write-Host "Detected v-prefixed archive root: $alternateRepoRoot"
    $repoRoot = $alternateRepoRoot
  } else {
    throw "Could not find extracted AgentQueue source at $repoRoot or $alternateRepoRoot."
  }
}

if (Test-Path $InstallPath) {
  Write-Host "Replacing existing installation at $InstallPath ..."
  Remove-Item -Recurse -Force -LiteralPath $InstallPath
}

New-Item -ItemType Directory -Path $InstallPath | Out-Null
Copy-Item -Path (Join-Path $repoRoot "*") -Destination $InstallPath -Recurse -Force

Write-Host "Installed to:"
Write-Host "  $InstallPath"
Write-Host ""
Write-Host "Run:"
Write-Host "  $InstallPath\start-dashboard.cmd"

if ($Launch) {
  Start-Process (Join-Path $InstallPath "start-dashboard.cmd")
}
