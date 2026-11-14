@echo off
title CineFlix Hub Launcher
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0CineFlixTray.ps1"
exit
