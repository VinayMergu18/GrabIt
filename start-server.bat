@echo off
title GrabIt Server
cd /d "%~dp0server"

:: Check if node is available
where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found. Please install Node.js from https://nodejs.org
    pause
    exit /b 1
)

:: Check if yt-dlp is available
where yt-dlp >nul 2>&1
if errorlevel 1 (
    echo [WARNING] yt-dlp not found in PATH.
    echo   Download from: https://github.com/yt-dlp/yt-dlp/releases
    echo   Place yt-dlp.exe in a folder on your PATH, or in the server folder.
    echo.
)

:: Check if gallery-dl is available
where gallery-dl >nul 2>&1
if errorlevel 1 (
    echo [WARNING] gallery-dl not found. Instagram carousel downloads may be limited.
    echo   Download from: https://github.com/mikf/gallery-dl/releases
    echo.
)

:: Install dependencies if needed
if not exist "node_modules" (
    echo [Setup] Installing dependencies...
    npm install
)

echo.
echo ========================================
echo   GrabIt Server v3.0
echo   http://127.0.0.1:7272
echo ========================================
echo.
echo Server is running. Keep this window open.
echo Press Ctrl+C to stop.
echo.

node index.js
pause
