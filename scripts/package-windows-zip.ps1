# Create a Colosseum Windows RC portable zip from a source checkout.
# Usage: powershell -ExecutionPolicy Bypass -File scripts\package-windows-zip.ps1

param(
    [string]$OutputDir = "release",
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Package = Get-Content (Join-Path $ProjectRoot "package.json") -Raw | ConvertFrom-Json
$Name = "$($Package.name)-$($Package.version)-windows-rc"
$StagingRoot = Join-Path ([System.IO.Path]::GetTempPath()) $Name
$OutRoot = Join-Path $ProjectRoot $OutputDir
$ZipPath = Join-Path $OutRoot "$Name.zip"

function Write-Info { param([string]$Message) Write-Host "[colosseum-package] $Message" -ForegroundColor Cyan }

if (-not $SkipBuild) {
    Push-Location $ProjectRoot
    try {
        npm ci
        if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
        npm run build
        if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }
        npm run smoke
        if ($LASTEXITCODE -ne 0) { throw "npm run smoke failed" }
    } finally {
        Pop-Location
    }
}

Remove-Item -Recurse -Force $StagingRoot -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $StagingRoot | Out-Null

$Exclude = @(".git", "node_modules", "release", "colosseum-state", ".env")
Get-ChildItem $ProjectRoot -Force | Where-Object { $Exclude -notcontains $_.Name } | ForEach-Object {
    Copy-Item -Recurse -Force $_.FullName -Destination $StagingRoot
}

New-Item -ItemType Directory -Force -Path $OutRoot | Out-Null
Remove-Item -Force $ZipPath -ErrorAction SilentlyContinue
Compress-Archive -Path (Join-Path $StagingRoot "*") -DestinationPath $ZipPath -Force
Remove-Item -Recurse -Force $StagingRoot

Write-Info "Wrote $ZipPath"
