# Build the .NET Worker and copy to extension dist folder
# This script is run during extension packaging

$ErrorActionPreference = "Stop"

Write-Host "Building .NET TestExplorer Worker..." -ForegroundColor Cyan

# Get script directory and project root
$scriptDir = Split-Path -Parent $PSCommandPath
$extensionRoot = Split-Path -Parent $scriptDir
$workerProject = Join-Path $extensionRoot "..\worker\TestExplorer.Worker\TestExplorer.Worker.csproj"
$outputDir = Join-Path $extensionRoot "dist\worker"

# Verify worker project exists
if (-not (Test-Path $workerProject)) {
    Write-Error "Worker project not found at: $workerProject"
    exit 1
}

# Clean output directory
if (Test-Path $outputDir) {
    Write-Host "Cleaning output directory: $outputDir"
    Remove-Item -Path $outputDir -Recurse -Force
}

# Create output directory
New-Item -Path $outputDir -ItemType Directory -Force | Out-Null

try {
    # Build and publish the worker
    Write-Host "Publishing worker to: $outputDir"
    Push-Location (Split-Path -Parent $workerProject)
    
    $publishArgs = @(
        "publish",
        "-c", "Release",
        "-o", $outputDir,
        "--self-contained", "false",
        "/p:DebugType=None",
        "/p:DebugSymbols=false"
    )
    
    & dotnet @publishArgs 2>&1 | ForEach-Object { Write-Host $_ }
    
    if ($LASTEXITCODE -ne 0) {
        Write-Error "dotnet publish failed with exit code $LASTEXITCODE"
        Pop-Location
        exit $LASTEXITCODE
    }
    
    Pop-Location
    
    Write-Host "Worker built successfully!" -ForegroundColor Green
    Write-Host "Output location: $outputDir" -ForegroundColor Green
    
    exit 0
}
catch {
    Write-Error "Failed to build worker: $_"
    Pop-Location
    exit 1
}
