@echo off
title Instalador de FFmpeg para CineFlix
echo ========================================================
echo   Instalador Automatico de FFmpeg para CineFlix Windows
echo ========================================================
echo.

where ffmpeg >nul 2>nul
if %errorlevel% equ 0 (
    echo [OK] FFmpeg ya esta instalado y listo para usar en tu sistema!
    echo.
    pause
    exit /b 0
)

if exist "%~dp0bin\ffmpeg.exe" (
    echo [OK] FFmpeg portable ya existe en la carpeta bin\
    echo.
    pause
    exit /b 0
)

echo [INFO] Descargando e instalando FFmpeg automaticamente con winget...
winget install Gyan.FFmpeg --accept-source-agreements --accept-package-agreements --silent

echo.
echo [LISTO] FFmpeg ha sido instalado correctamente.
echo Ya puedes iniciar CineFlix con "Iniciar CineFlix.bat".
echo.
pause
