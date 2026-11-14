# =======================================================
# CineFlix Hub - Windows Tray Runner & 1-Click Auto-Setup
# =======================================================
[CmdletBinding()]
param()

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $scriptDir

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# 1. Single Instance Check (Mutex)
$isNew = $false
$global:cineMutex = New-Object System.Threading.Mutex($true, "CineFlixWindowsAppMutex", [ref]$isNew)
if (-not $isNew) {
    try { Start-Process "http://localhost:3000" } catch {}
    exit
}

$global:isExiting = $false

# 2. Check & Auto-Install Node.js
$nodeCmd = Get-Command "node" -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    $commonNodePaths = @(
        "$env:ProgramFiles\nodejs\node.exe",
        "${env:ProgramFiles(x86)}\nodejs\node.exe",
        "$env:LOCALAPPDATA\Programs\nodejs\node.exe"
    )
    foreach ($p in $commonNodePaths) {
        if (Test-Path $p) {
            $nodeCmd = [PSCustomObject]@{ Source = $p; Path = $p }
            $env:Path = (Split-Path -Parent $p) + ";" + $env:Path
            break
        }
    }
}

if (-not $nodeCmd) {
    $wingetCmd = Get-Command "winget" -ErrorAction SilentlyContinue
    if ($wingetCmd) {
        [System.Windows.Forms.MessageBox]::Show(
            "CineFlix requiere Node.js para funcionar.`n`nSe instalará automáticamente ahora mismo. Presiona Aceptar para continuar.",
            "CineFlix - Instalación Automática",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Information
        )
        Start-Process -FilePath "winget" -ArgumentList "install --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements" -Wait -NoNewWindow
        
        $p = "$env:ProgramFiles\nodejs\node.exe"
        if (Test-Path $p) {
            $nodeCmd = [PSCustomObject]@{ Source = $p; Path = $p }
            $env:Path = "$env:ProgramFiles\nodejs;" + $env:Path
        }
    }
}

if (-not $nodeCmd) {
    [System.Windows.Forms.MessageBox]::Show(
        "No se pudo inicializar Node.js automáticamente.`n`nPor favor instala Node.js desde: https://nodejs.org",
        "CineFlix - Error",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error
    )
    exit
}

$nodeExePath = if ($nodeCmd.Path) { $nodeCmd.Path } elseif ($nodeCmd.Source) { $nodeCmd.Source } else { "node.exe" }

# 3. Check & Auto-Setup FFmpeg / FFprobe in bin/
$binDir = Join-Path $scriptDir "bin"
if (-not (Test-Path $binDir)) {
    New-Item -ItemType Directory -Path $binDir -Force | Out-Null
}
$ffmpegExe = Join-Path $binDir "ffmpeg.exe"
$ffprobeExe = Join-Path $binDir "ffprobe.exe"

if ((-not (Test-Path $ffmpegExe)) -or (-not (Test-Path $ffprobeExe))) {
    $wingetPackages = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages"
    $cachedFfmpeg = Get-ChildItem -Path $wingetPackages -Filter "ffmpeg.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    $cachedFfprobe = Get-ChildItem -Path $wingetPackages -Filter "ffprobe.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1

    if ($cachedFfmpeg -and $cachedFfprobe) {
        Copy-Item -Path $cachedFfmpeg.FullName -Destination $ffmpegExe -Force
        Copy-Item -Path $cachedFfprobe.FullName -Destination $ffprobeExe -Force
    } else {
        $sysFfmpeg = Get-Command "ffmpeg" -ErrorAction SilentlyContinue
        $sysFfprobe = Get-Command "ffprobe" -ErrorAction SilentlyContinue
        if ($sysFfmpeg -and $sysFfprobe) {
            Copy-Item -Path $sysFfmpeg.Source -Destination $ffmpegExe -Force
            Copy-Item -Path $sysFfprobe.Source -Destination $ffprobeExe -Force
        } else {
            $wingetCmd = Get-Command "winget" -ErrorAction SilentlyContinue
            if ($wingetCmd) {
                Start-Process -FilePath "winget" -ArgumentList "install --id Gyan.FFmpeg --silent --accept-package-agreements --accept-source-agreements" -Wait -NoNewWindow
                $cachedFfmpeg = Get-ChildItem -Path $wingetPackages -Filter "ffmpeg.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
                $cachedFfprobe = Get-ChildItem -Path $wingetPackages -Filter "ffprobe.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
                if ($cachedFfmpeg -and $cachedFfprobe) {
                    Copy-Item -Path $cachedFfmpeg.FullName -Destination $ffmpegExe -Force
                    Copy-Item -Path $cachedFfprobe.FullName -Destination $ffprobeExe -Force
                }
            }
        }
    }
}

# 4. Auto-Create Desktop Shortcut if missing
try {
    $desktopPath = [Environment]::GetFolderPath("Desktop")
    $shortcutPath = Join-Path $desktopPath "CineFlix.lnk"
    if (-not (Test-Path $shortcutPath)) {
        $wsh = New-Object -ComObject WScript.Shell
        $sc = $wsh.CreateShortcut($shortcutPath)
        $sc.TargetPath = Join-Path $scriptDir "Iniciar CineFlix (Silencioso).vbs"
        $sc.WorkingDirectory = $scriptDir
        $sc.Description = "CineFlix Hub - Centro Multimedia"
        $iconFile = Join-Path $scriptDir "cineflix.ico"
        if (Test-Path $iconFile) {
            $sc.IconLocation = "$iconFile,0"
        }
        $sc.Save()
    }
} catch {}

# 5. Start Node.js Server in Background
$port = 3000
$url = "http://localhost:$port"
$serverScript = Join-Path $scriptDir "server.js"

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $nodeExePath
$psi.Arguments = "`"$serverScript`""
$psi.WorkingDirectory = $scriptDir
$psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
$psi.UseShellExecute = $true

$global:serverProcess = [System.Diagnostics.Process]::Start($psi)

# 6. Setup Application Context & System Tray NotifyIcon
$appContext = New-Object System.Windows.Forms.ApplicationContext
$notify = New-Object System.Windows.Forms.NotifyIcon
$iconPath = Join-Path $scriptDir "cineflix.ico"
if (Test-Path $iconPath) {
    try { $notify.Icon = New-Object System.Drawing.Icon $iconPath } catch { $notify.Icon = [System.Drawing.SystemIcons]::Application }
} else {
    $notify.Icon = [System.Drawing.SystemIcons]::Application
}
$notify.Text = "CineFlix Hub - Activo en $url"
$notify.Visible = $true

# Context Menu (Right Click)
$contextMenu = New-Object System.Windows.Forms.ContextMenuStrip

$headerItem = $contextMenu.Items.Add("🎬 CineFlix Hub (Activo)")
$headerItem.Font = New-Object System.Drawing.Font($headerItem.Font, [System.Drawing.FontStyle]::Bold)
$headerItem.Enabled = $false

$sep0 = New-Object System.Windows.Forms.ToolStripSeparator
$contextMenu.Items.Add($sep0) | Out-Null

$openItem = $contextMenu.Items.Add("🌐 Abrir CineFlix en el navegador")
$openItem.Add_Click({
    try { Start-Process $url } catch {}
})

$copyIpItem = $contextMenu.Items.Add("📋 Copiar enlace para Smart TV / Celular")
$copyIpItem.Add_Click({
    try {
        $localIp = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" -and $_.IPAddress -like "192.168.*" } | Select-Object -First 1).IPAddress
        if ($localIp) {
            $networkUrl = "http://${localIp}:$port"
            [System.Windows.Forms.Clipboard]::SetText($networkUrl)
            $notify.ShowBalloonTip(3000, "CineFlix - Enlace Copiado", "Pegalo en el navegador de tu Smart TV o Celular:`n$networkUrl", [System.Windows.Forms.ToolTipIcon]::Info)
        } else {
            [System.Windows.Forms.Clipboard]::SetText($url)
        }
    } catch {}
})

$restartItem = $contextMenu.Items.Add("🔄 Reiniciar Servidor")
$restartItem.Add_Click({
    try {
        if (-not $global:serverProcess.HasExited) { $global:serverProcess.Kill() }
    } catch {}
    Start-Sleep -Milliseconds 500
    try {
        $global:serverProcess = [System.Diagnostics.Process]::Start($psi)
        $notify.ShowBalloonTip(2000, "CineFlix", "Servidor reiniciado con éxito.", [System.Windows.Forms.ToolTipIcon]::Info)
    } catch {}
})

$sep1 = New-Object System.Windows.Forms.ToolStripSeparator
$contextMenu.Items.Add($sep1) | Out-Null

$exitItem = $contextMenu.Items.Add("❌ Cerrar CineFlix")
$exitItem.Add_Click({
    $global:isExiting = $true
    $notify.Visible = $false
    $notify.Dispose()
    try {
        if (-not $global:serverProcess.HasExited) { $global:serverProcess.Kill() }
    } catch {}
    try {
        if ($global:cineMutex) {
            $global:cineMutex.ReleaseMutex()
            $global:cineMutex.Dispose()
        }
    } catch {}
    $appContext.ExitThread()
})

$notify.ContextMenuStrip = $contextMenu

# Double click tray icon opens browser
$notify.Add_DoubleClick({
    try { Start-Process $url } catch {}
})

# 7. Check server ready timer (UI thread)
$checkTimer = New-Object System.Windows.Forms.Timer
$checkTimer.Interval = 250
$attempts = 0
$checkTimer.Add_Tick({
    $attempts++
    $connected = $false
    try {
        $tcp = New-Object System.Net.Sockets.TcpClient
        $tcp.Connect("127.0.0.1", $port)
        $tcp.Close()
        $connected = $true
    } catch {}

    if ($connected -or ($attempts -ge 30)) {
        $checkTimer.Stop()
        try { Start-Process $url } catch {}
        try { $notify.ShowBalloonTip(3000, "CineFlix Hub Listo", "CineFlix está activo en $url`nPuedes cerrarlo con clic derecho en este icono.", [System.Windows.Forms.ToolTipIcon]::Info) } catch {}
    }
})
$checkTimer.Start()

# 8. Server Watchdog
$watchdogTimer = New-Object System.Windows.Forms.Timer
$watchdogTimer.Interval = 5000
$watchdogTimer.Add_Tick({
    try {
        if ($global:serverProcess.HasExited -and (-not $global:isExiting)) {
            $global:serverProcess = [System.Diagnostics.Process]::Start($psi)
        }
    } catch {}
})
$watchdogTimer.Start()

# 9. Start Windows Message Loop
[System.Windows.Forms.Application]::Run($appContext)
