# release.ps1
# Bumps patch version, packages the extension, moves the .vsix to /dist, and updates README.md

$ErrorActionPreference = "Stop"

$scriptDir       = Split-Path -Parent $PSCommandPath
$extensionRoot   = Split-Path -Parent $scriptDir
$repoRoot        = Split-Path -Parent $extensionRoot
$packageJsonPath = Join-Path $extensionRoot "package.json"
$distDir         = Join-Path $repoRoot "dist"
$readmePath      = Join-Path $repoRoot "README.md"
$repoUrl         = "https://github.com/terryaney/Extensibility.VS.Code.Test.Explorer"

# 1. Read current version
$packageJson    = Get-Content $packageJsonPath -Raw | ConvertFrom-Json
$currentVersion = $packageJson.version

$parts          = $currentVersion -split '\.'
$parts[2]       = [int]$parts[2] + 1
$newVersion     = $parts -join '.'

Write-Host "Version bump: $currentVersion -> $newVersion" -ForegroundColor Cyan

# 2. Update package.json
$packageJsonContent = Get-Content $packageJsonPath -Raw
$packageJsonContent = $packageJsonContent -replace `
    ([regex]::Escape("`"version`": `"$currentVersion`"")), `
    "`"version`": `"$newVersion`""
Set-Content -Path $packageJsonPath -Value $packageJsonContent -NoNewline

# 3. Run vsce package (triggers vscode:prepublish automatically)
Write-Host "Running vsce package..." -ForegroundColor Cyan
$vsixName = "kat-test-explorer-$newVersion.vsix"
$vsixDest = Join-Path $distDir $vsixName

if (-not (Test-Path $distDir)) {
    New-Item -Path $distDir -ItemType Directory -Force | Out-Null
}

Push-Location $extensionRoot
try {
    & npx @vscode/vsce package --allow-missing-repository --no-yarn --no-update-package-json --out $vsixDest
    if ($LASTEXITCODE -ne 0) {
        Write-Error "vsce package failed with exit code $LASTEXITCODE"
        exit $LASTEXITCODE
    }
}
finally {
    Pop-Location
}

# 4. Verify .vsix in /dist
if (-not (Test-Path $vsixDest)) {
    Write-Error "Expected .vsix not found: $vsixDest"
    exit 1
}

Write-Host "Created $vsixName -> dist/" -ForegroundColor Green

# 5. Update README.md
# 5a. Replace every filename reference to the old version with the new version
$readme = Get-Content $readmePath -Raw
$readme = $readme -replace `
    ([regex]::Escape("kat-test-explorer-$currentVersion.vsix")), `
    "kat-test-explorer-$newVersion.vsix"

# 5b. Insert old version at the top of the ## Previous Versions list
$prevEntry = "1. [$currentVersion]($repoUrl/raw/main/dist/kat-test-explorer-$currentVersion.vsix)"

$lines           = $readme -split "`n"
$insertIndex     = -1
for ($i = 0; $i -lt $lines.Length; $i++) {
    if ($lines[$i].TrimEnd() -eq '## Previous Versions') {
        # Insert right after the header (and any immediately following blank line)
        $insertIndex = $i + 1
        if ($insertIndex -lt $lines.Length -and $lines[$insertIndex].Trim() -eq '') {
            $insertIndex++
        }
        break
    }
}

if ($insertIndex -ge 0) {
    $newLines = $lines[0..($insertIndex - 1)] + $prevEntry + $lines[$insertIndex..($lines.Length - 1)]
    $readme   = $newLines -join "`n"
}
else {
    Write-Warning "## Previous Versions section not found in README.md - skipping version list update."
}

Set-Content -Path $readmePath -Value $readme -NoNewline

Write-Host "README.md updated: Getting Started -> $newVersion, Previous Versions <- $currentVersion" -ForegroundColor Green
Write-Host ""
Write-Host "Release $newVersion complete!" -ForegroundColor Green
