# 🎬 CineFlix Hub - Edición Windows

Versión nativa de CineFlix para Windows con icono en la barra de tareas (Bandeja del Sistema), menú de clic derecho y apertura directa en el navegador.

---

## ⚡ Cómo Ejecutar (Doble Clic y Listo)

1. Hacé doble clic en **`Iniciar CineFlix.bat`** (o en **`Iniciar CineFlix (Silencioso).vbs`** para que no abra ninguna ventana negra).
2. Verás el icono de **CineFlix (🎬)** en tu bandeja del sistema (abajo a la derecha, junto al reloj).
3. Automáticamente se abrirá tu navegador predeterminado en **`http://localhost:3000`**.

---

## 🖱️ Controles de la Bandeja (Clic Derecho)

Al hacer clic derecho sobre el icono de CineFlix en la barra de tareas podrás:
* **🎬 Abrir CineFlix en el navegador**: Acceso directo instantáneo.
* **📋 Copiar enlace para Smart TV / Celular**: Copia la dirección IP local (ej. `http://192.168.1.X:3000`) para ver películas en tu televisor o teléfono en la misma red Wi-Fi.
* **🔄 Reiniciar Servidor**: Reinicia el proceso en segundo plano.
* **❌ Cerrar CineFlix**: Cierra el servidor completamente y oculta el icono.

*También podés hacer doble clic sobre el icono en cualquier momento para abrir el reproductor.*

---

## 📌 Crear Acceso Directo en el Escritorio

Hacé doble clic en **`Crear Acceso Directo.bat`** y se creará automáticamente un ícono de CineFlix en tu Escritorio de Windows.

---

## 📦 Herramientas Incluidas

* **FFmpeg Portable:** Incluido en la carpeta `bin/` para transcodificación y streaming instantáneo sin necesidad de configurar variables de entorno.
* **Requisitos:** Requiere tener instalado **Node.js LTS** (https://nodejs.org).
