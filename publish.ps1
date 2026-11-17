# Publishes Pape as a self-contained, single-file x64 executable.
# Usage:  .\publish.ps1            -> Pape.exe (and Versions\Archive\Pape-<version>.exe)
#         .\publish.ps1 -Run       -> publish and launch
#         .\publish.ps1 -Test      -> build and self-check into test\ only (nothing archived)
# Refuses a version that's already in Versions\Archive: raise <Version> in the csproj and VERSION in
# web\app.js first. The build must pass its own self-check (--smoke) before it is kept.
# If Pape is running, it is asked to quit and is started again on the new version.
param([switch]$Run, [switch]$Test)

$ErrorActionPreference = "Stop"
$name = "Pape"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$proj = Join-Path $root "src\$name\$name.csproj"
$out  = Join-Path $root $(if ($Test) { "test" } else { "dist" })
$top  = Join-Path $root "$name.exe"

$version = ([xml](Get-Content $proj)).Project.PropertyGroup.Version | Where-Object { $_ } | Select-Object -First 1
$archive = Join-Path $root "Versions\Archive\$name-$version.exe"
if (-not $Test -and (Test-Path $archive)) { throw "Version $version is already archived. Raise <Version> in the csproj, then publish again." }
$web = Get-Content (Join-Path $root "web\app.js") -Raw
if ($web -notmatch "const VERSION='$([regex]::Escape($version))'") { throw "web\app.js does not say VERSION='$version'. Keep it in step with the csproj." }

# On some PCs the `dotnet` on PATH is the x86 one without an SDK.
$dotnet = "C:\Program Files\dotnet\dotnet.exe"
if (-not (Test-Path $dotnet)) { $dotnet = "dotnet" }

Write-Host "Publishing Pape $version (Release, win-x64, self-contained, single file)..." -ForegroundColor Cyan
if (Test-Path $out) { Remove-Item $out -Recurse -Force }
& $dotnet publish $proj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true `
    -p:IncludeNativeLibrariesForSelfExtract=true -p:EnableCompressionInSingleFile=true -o $out --nologo
if ($LASTEXITCODE -ne 0) { throw "publish failed" }
$exe = Join-Path $out "$name.exe"

Write-Host "Self-check..." -ForegroundColor Cyan
Start-Process $exe "--smoke" -Wait
$report = Get-Content (Join-Path $out "$name-Data\smoke.txt") -Raw
if ($report -notmatch "^PASS") { throw "self-check failed:`n$report" }
Write-Host $report
if ($Test) { Write-Host "Test build: $exe (self-check pictures in $out\$name-Data)" -ForegroundColor Green; return }

# Only the exe is needed; drop symbol/side files and the self-check's data.
Get-ChildItem $out | Where-Object { $_.Name -ne "$name.exe" } | Remove-Item -Recurse -Force

# Pape saves every change as it happens, so asking it to quit loses nothing.
$running = @(Get-Process $name -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $top })
if ($running) {
    & $top --exit
    foreach ($p in $running) { if (-not $p.WaitForExit(15000)) { $p.Kill(); $p.WaitForExit() } }
}

# Every build is kept: the current one at the top level, and a copy per version in Versions\Archive.
New-Item -ItemType Directory -Force (Split-Path $archive) | Out-Null
Copy-Item $exe $archive
Copy-Item $exe $top
$size = [math]::Round((Get-Item $exe).Length / 1MB, 1)
Write-Host "Done: $top ($size MB), archived as $archive" -ForegroundColor Green

# Started through Windows so it outlives this script.
if ($Run -or $running) { [void](Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = "`"$top`" --tray" }) }
