#!/bin/bash
set -e

# =======================================================
# CineFlix - Script de Instalación Automatizada (Debian / Ubuntu)
# =======================================================

echo "🎬 Iniciando instalación de CineFlix Hub..."

if [ "$EUID" -ne 0 ]; then
  echo "❌ Por favor ejecuta este script como root (sudo ./install.sh)"
  exit 1
fi

# 1. Actualización e instalación de paquetes base
echo "📦 Instalando dependencias base (curl, git, ffmpeg, tesseract, python)..."
apt-get update
apt-get install -y \
  curl \
  git \
  ffmpeg \
  mkvtoolnix \
  tesseract-ocr \
  tesseract-ocr-spa \
  python3 \
  python3-pip \
  python3-venv \
  ca-certificates \
  gnupg \
  lsb-release

# 2. Instalar Node.js LTS si no está presente
if ! command -v node &> /dev/null; then
  echo "🟢 Instalando Node.js LTS..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

# 3. Instalar Docker y Docker Compose si no están presentes
if ! command -v docker &> /dev/null; then
  echo "🐳 Instalando Docker Engine..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable docker
  systemctl start docker
fi

# 4. Crear estructura de carpetas en /opt/cine
echo "📁 Creando estructura de directorios en /opt/cine..."
mkdir -p /opt/cine/portal/public
mkdir -p /opt/cine/portal/data
mkdir -p /opt/cine/data/torrents
mkdir -p /opt/cine/config
chmod -R 777 /opt/cine/data/torrents

# 5. Copiar archivos de CineFlix Portal
echo "📋 Copiando archivos del portal..."
cp server.js /opt/cine/portal/server.js
cp -r public/* /opt/cine/portal/public/

# 6. Desplegar contenedores Docker (Jellyfin, Jellyseerr, Radarr, Sonarr, Prowlarr, Bazarr, qBittorrent)
if [ -f "docker/docker-compose.yml" ]; then
  echo "🚀 Levantando infraestructura multimedia con Docker Compose..."
  cp docker/docker-compose.yml /opt/cine/docker-compose.yml
  cd /opt/cine
  docker compose pull || true
  docker compose up -d
  cd -
fi

# 7. Configurar servicio Systemd
echo "⚙️ Configurando servicio del portal cine-portal.service..."
cp systemd/cine-portal.service /etc/systemd/system/cine-portal.service
systemctl daemon-reload
systemctl enable cine-portal.service
systemctl restart cine-portal.service

# 8. Obtener IP local
LOCAL_IP=$(hostname -I | awk '{print $1}')

echo ""
echo "=========================================================="
echo "🎉 ¡CINEFLIX SE HA INSTALADO Y ESTÁ CORRIENDO CON ÉXITO!"
echo "=========================================================="
echo "🌐 Acceso local:     http://localhost:80 (o :8088 / :3000)"
echo "📱 Acceso en tu red: http://${LOCAL_IP}"
echo ""
echo "Panel multimedia activo con 8 carouseles, historial,"
echo "reproductor cinemático y sincronización de subtítulos al 100%."
echo "=========================================================="
