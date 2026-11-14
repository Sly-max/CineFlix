# 🎬 CineFlix - Plataforma de Streaming y Centro de Medios

[![Windows Release](https://img.shields.io/badge/Descargar%20Instalador-Windows%20Setup%20v1.1.0-0078D6?style=for-the-badge&logo=windows&logoColor=white)](https://github.com/Sly-max/CineFlix/releases/download/v1.1.0/CineFlix-Setup-v1.1.0.exe)
[![GitHub Release](https://img.shields.io/github/v/release/Sly-max/CineFlix?style=for-the-badge&color=green)](https://github.com/Sly-max/CineFlix/releases/latest)

CineFlix es un centro multimedia cinemático con streaming directo en navegador sin esperas, selección de pistas de audio (Español Latino / Inglés) en vivo, sincronización frame-accurate de subtítulos, carruseles por categoría y guardado de historial de reproducción.

Este repositorio incluye dos ediciones completamente **independientes** listas para producción:

```
CineFlix/
├── 📁 Server Debian/      # Respaldo completo para servidores Linux (Debian 12 / Proxmox) con Docker y Systemd
└── 📁 Server Windows/     # Versión nativa para Windows 100% Autónoma e Independiente (Instalador .exe)
```

---

## 🪟 1. Server Windows (100% Autónomo - Doble Clic y Listo)

* **Instalador Oficial Todo-en-Uno:** Descargá y ejecutá [`CineFlix-Setup-v1.1.0.exe`](https://github.com/Sly-max/CineFlix/releases/download/v1.1.0/CineFlix-Setup-v1.1.0.exe).
* **100% Independiente:** No requiere Docker, no requiere Proxmox, no requiere instalar Node.js ni configurar nada.
* **Catálogo Global Cinemeta:** Tendencias, películas, series y detalles directamente desde la nube.
* **Motor de Torrents Integrado:** Descarga y hace streaming secuencial en vivo en tu disco local.
* **FFmpeg Portable Incrustado:** Sincronización milimétrica de subtítulos de cine y cambio de audio en vivo.
* **Icono en la Bandeja (System Tray):** Corre en segundo plano y abre automáticamente el navegador en `http://localhost:3000`. Clic derecho para abrir, copiar enlace para Smart TV o cerrar.

---

## 🐧 2. Server Debian (Respaldo para Servidores Hogareños / Proxmox / VPS)

* Pila completa con Docker Compose: **Jellyfin, Jellyseerr, Radarr, Sonarr, Prowlarr, Bazarr y qBittorrent**.
* Servicio de sistema `cine-portal.service` con arranque automático al encender el servidor.
* Ideal como respaldo para restaurar o migrar tu máquina virtual en 1 solo paso.

**Restauración rápida en cualquier máquina Debian:**
```bash
git clone https://github.com/Sly-max/CineFlix.git
cd "CineFlix/Server Debian"
chmod +x install.sh
sudo ./install.sh
```

---

## 🌟 Características Principales

* **🎬 8 Carruseles Cinemáticos:** Estrenos de Cine, Nuevas Temporadas, Obras Maestras (Mejor Calificados), Anime, Ciencia Ficción, Acción y Catálogo Completo.
* **⏱️ Continuar Viendo (Historial en Vivo):** Recuerda el minuto exacto donde dejaste cada película o serie con portadas oficiales en alta definición.
* **🎙️ Audio Multi-Pista en Vivo:** Selector instantáneo entre Español Latino e Inglés con transcodificación en tiempo real.
* **💬 Subtítulos de Cine:** Tipografía translúcida de cine sin bandas negras con sincronización milimétrica palabra por palabra.
* **⚡ Descarga Secuencial & Streaming Instantáneo:** Mirá cualquier película mientras se descarga sin esperar al 100%.

---

## 📄 Licencia

Desarrollado para uso personal y familiar. Licencia MIT.
