@echo off
setlocal
cd /d "%~dp0"

echo Creando acceso directo de CineFlix en el Escritorio...

set "TARGET=%~dp0Iniciar CineFlix (Silencioso).vbs"
set "ICON=%~dp0cineflix.ico"
set "DESKTOP=%USERPROFILE%\Desktop\CineFlix.lnk"

powershell -Command "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut('%DESKTOP%'); $s.TargetPath = '%TARGET%'; $s.WorkingDirectory = '%~dp0'; $s.IconLocation = '%ICON%'; $s.Description = 'CineFlix Media Hub'; $s.Save()"

echo Acceso directo creado en tu Escritorio: "%DESKTOP%"
pause
