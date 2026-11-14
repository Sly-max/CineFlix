# =======================================================
# CineFlix Hub - Windows System Tray Runner
# =======================================================
[CmdletBinding()]
param()

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Ensure single instance
$mutex = New-Object System.Threading.Mutex($true, "CineFlixWindowsAppMutex", [ref]$isNew)
if (-not $isNew) {
    [System.Windows.Forms.MessageBox]::Show("CineFlix ya se encuentra en ejecución en tu bandeja del sistema (abajo a la derecha).", "CineFlix", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information)
    exit
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $scriptDir

# Check Node.js
$nodeCmd = Get-Command "node" -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    [System.Windows.Forms.MessageBox]::Show("Node.js no fue detectado en tu sistema.`n`nPor favor descarga e instala Node.js LTS desde: https://nodejs.org", "CineFlix - Node.js requerido", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Warning)
    exit
}

$port = 3000
$url = "http://localhost:$port"

# Start Node.js server as hidden background process
$serverScript = Join-Path $scriptDir "server.js"
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $nodeCmd.Source
$psi.Arguments = "`"$serverScript`""
$psi.WorkingDirectory = $scriptDir
$psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
$psi.CreateNoWindow = $true
$psi.UseShellExecute = $false

$global:serverProcess = [System.Diagnostics.Process]::Start($psi)

# Create System Tray NotifyIcon
$notify = New-Object System.Windows.Forms.NotifyIcon
$iconPath = Join-Path $scriptDir "cineflix.ico"
if (Test-Path $iconPath) {
    $notify.Icon = New-Object System.Drawing.Icon $iconPath
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
    Start-Process $url
})

$copyIpItem = $contextMenu.Items.Add("📋 Copiar enlace para Smart TV / Celular")
$copyIpItem.Add_Click({
    $localIp = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" -and $_.IPAddress -like "192.168.*" } | Select-Object -First 1).IPAddress
    if ($localIp) {
        $networkUrl = "http://${localIp}:$port"
        [System.Windows.Forms.Clipboard]::SetText($networkUrl)
        $notify.ShowBalloonTip(3000, "CineFlix - Enlace Copiado", "Pegalo en el navegador de tu Smart TV o Celular:`n$networkUrl", [System.Windows.Forms.ToolTipIcon]::Info)
    } else {
        [System.Windows.Forms.Clipboard]::SetText($url)
    }
})

$restartItem = $contextMenu.Items.Add("🔄 Reiniciar Servidor")
$restartItem.Add_Click({
    try {
        if (-not $global:serverProcess.HasExited) { $global:serverProcess.Kill() }
    } catch {}
    Start-Sleep -Milliseconds 500
    $global:serverProcess = [System.Diagnostics.Process]::Start($psi)
    $notify.ShowBalloonTip(2000, "CineFlix", "Servidor reiniciado con éxito.", [System.Windows.Forms.ToolTipIcon]::Info)
})

$sep1 = New-Object System.Windows.Forms.ToolStripSeparator
$contextMenu.Items.Add($sep1) | Out-Null

$exitItem = $contextMenu.Items.Add("❌ Cerrar CineFlix")
$exitItem.Add_Click({
    $notify.Visible = $false
    try {
        if (-not $global:serverProcess.HasExited) { $global:serverProcess.Kill() }
    } catch {}
    [System.Windows.Forms.Application]::Exit()
})

$notify.ContextMenuStrip = $contextMenu

# Double click opens browser
$notify.Add_DoubleClick({
    Start-Process $url
})

# Wait for server to respond and open browser
[System.Threading.ThreadPool]::QueueUserWorkItem({
    $started = $false
    for ($i = 0; $i -lt 30; $i++) {
        try {
            $tcp = New-Object System.Net.Sockets.TcpClient
            $tcp.Connect("127.0.0.1", $port)
            $tcp.Close()
            $started = $true
            break
        } catch {
            Start-Sleep -Milliseconds 250
        }
    }
    
    # Open default browser directly
    Start-Process $url
    
    # Show balloon notification
    $notify.ShowBalloonTip(3000, "CineFlix Hub Listo", "CineFlix está activo en $url`nPuedes cerrarlo con clic derecho en este icono.", [System.Windows.Forms.ToolTipIcon]::Info)
}) | Out-Null

# Run Windows message loop
[System.Windows.Forms.Application]::Run()
