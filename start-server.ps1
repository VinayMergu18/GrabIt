# GrabIt Server Launcher (PowerShell)
# Run: Right-click → Run with PowerShell, or: pwsh -File start-server.ps1

$ErrorActionPreference = "Continue"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverDir = Join-Path $scriptDir "server"

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  GrabIt Server v3.0" -ForegroundColor White
Write-Host "  http://127.0.0.1:7272" -ForegroundColor Gray
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Check Node.js
$nodeVer = node --version 2>$null
if (-not $nodeVer) {
    Write-Host "[ERROR] Node.js not found." -ForegroundColor Red
    Write-Host "  Download from: https://nodejs.org" -ForegroundColor Yellow
    Read-Host "Press Enter to exit"
    exit 1
}
Write-Host "[OK] Node.js $nodeVer" -ForegroundColor Green

# Check yt-dlp
$ytdlp = Get-Command yt-dlp -ErrorAction SilentlyContinue
if ($ytdlp) {
    Write-Host "[OK] yt-dlp found at $($ytdlp.Source)" -ForegroundColor Green
} else {
    Write-Host "[WARNING] yt-dlp not found. Download: https://github.com/yt-dlp/yt-dlp/releases" -ForegroundColor Yellow
    Write-Host "  Place yt-dlp.exe in $serverDir or add to PATH" -ForegroundColor Gray
}

# Check gallery-dl
$gdl = Get-Command gallery-dl -ErrorAction SilentlyContinue
if ($gdl) {
    Write-Host "[OK] gallery-dl found" -ForegroundColor Green
} else {
    Write-Host "[WARNING] gallery-dl not found. Install: pip install gallery-dl" -ForegroundColor Yellow
    Write-Host "  Instagram carousels will use yt-dlp fallback" -ForegroundColor Gray
}

Write-Host ""

# Install node modules if needed
Set-Location $serverDir
if (-not (Test-Path "node_modules")) {
    Write-Host "[Setup] Installing Node.js dependencies..." -ForegroundColor Cyan
    npm install
    Write-Host ""
}

Write-Host "Server starting. Keep this window open." -ForegroundColor White
Write-Host "Press Ctrl+C to stop." -ForegroundColor Gray
Write-Host ""

# Start server and restart on crash
while ($true) {
    node index.js
    $exit = $LASTEXITCODE
    if ($exit -eq 0) { break }
    Write-Host "[Server crashed with code $exit] Restarting in 3 seconds..." -ForegroundColor Yellow
    Start-Sleep 3
}
