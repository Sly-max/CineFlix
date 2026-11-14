# 🎬 CineFlix - Plataforma de Streaming y Centro de Medios

[![Windows Release](https://img.shields.io/badge/Descargar%20Instalador-Windows%20Setup%20(144%20MB)-0078D6?style=for-the-badge&logo=windows&logoColor=white)](https://github.com/Sly-max/CineFlix/releases/download/v1.0.0/CineFlix-Setup-v1.0.0.exe)
[![GitHub Release](https://img.shields.io/github/v/release/Sly-max/CineFlix?style=for-the-badge&color=green)](https://github.com/Sly-max/CineFlix/releases/tag/v1.0.0)

CineFlix es un centro multimedia cinemático con streaming directo en navegador sin esperas, selección de pistas de audio (Español Latino / Inglés) en vivo, sincronización frame-accurate de subtítulos, carruseles por categoría y guardado de historial de reproducción.

Este repositorio incluye dos ediciones completas listas para producción:

```
CineFlix/
├── 📁 Server Debian/      # Versión completa para servidores Linux (Debian 12 / Ubuntu) con Docker y Systemd
└── 📁 Server Windows/     # Versión nativa para Windows con Icono en Bandeja (System Tray) y doble clic
```

---

## 🐧 1. Server Debian (Recomendado para servidores hogareños / Proxmox / VPS)

* Pila completa con Docker Compose: **Jellyfin, Jellyseerr, Radarr, Sonarr, Prowlarr, Bazarr y qBittorrent**.
* Servicio de sistema `cine-portal.service` con arranque automático al encender.
* Streaming de video a 1080p / 4K UHD con búsqueda rápida en 28 trackers simultáneos.
* Extracción y sincronización de subtítulos PGS a WebVTT con OCR y ajuste de fotogramas clave.

**Instalación rápida:**
```bash
cd "Server Debian"
sudo chmod +x install.sh
sudo ./install.sh
```

---

## 🪟 2. Server Windows (Doble Clic y Listo)

* Ejecución directa sin complicaciones con **`Iniciar CineFlix.bat`**.
* **Icono en la bandeja del sistema (System Tray)** con menú de clic derecho para abrir en navegador, ver IP para Smart TV y cerrar el servidor.
* **FFmpeg Portable** incluido en la carpeta `bin/`.
* Abre automáticamente el navegador en `http://localhost:3000`.

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
