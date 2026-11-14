# 🎬 CineFlix Hub - Edición Servidor Debian / Linux

Servidor multimedia todo-en-uno para Debian 12 / Ubuntu 22.04+ con streaming de video directo en navegador, soporte de audio multi-pista en vivo, sincronización frame-accurate de subtítulos en español y catálogo cinemático.

---

## 🚀 Instalación en 1 Solo Paso

En tu servidor Debian o Ubuntu con permisos de administrador:

```bash
git clone https://github.com/Sly-max/CineFlix.git
cd "CineFlix/Server Debian"
sudo chmod +x install.sh
sudo ./install.sh
```

El script se encargará automáticamente de:
1. Instalar dependencias del sistema: `FFmpeg`, `Node.js`, `Docker`, `Tesseract OCR` y utilidades de extracción.
2. Levantar la pila de microservicios con Docker Compose (Jellyfin, Jellyseerr, Radarr, Sonarr, Prowlarr, Bazarr, qBittorrent).
3. Configurar y arrancar el servicio `cine-portal.service` para inicio automático con el sistema.

---

## 🌐 Acceso al Portal

Una vez completada la instalación:
* **Desde el propio servidor:** `http://localhost`
* **Desde cualquier Smart TV, PC o celular en tu red Wi-Fi:** `http://<IP_DEL_SERVIDOR>` (ej: `http://192.168.1.205`)

---

## 📂 Estructura de Carpetas

* `/opt/cine/portal/`: Código del servidor y frontend web.
* `/opt/cine/data/torrents/`: Archivos descargados y en streaming.
* `/opt/cine/config/`: Configuraciones de los microservicios.

---

## 🛠️ Comandos Útiles

```bash
# Ver estado del servidor CineFlix
sudo systemctl status cine-portal.service

# Reiniciar el servidor
sudo systemctl restart cine-portal.service

# Ver logs en vivo
sudo journalctl -u cine-portal.service -f
```
