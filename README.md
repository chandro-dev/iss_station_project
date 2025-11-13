
# 🛰️ ISS Tracker – React App

Monitoreo en tiempo real de la Estación Espacial Internacional

Este proyecto es una aplicación web creada con **Create React App** que permite visualizar en tiempo real la **posición actual de la Estación Espacial Internacional (ISS)** utilizando datos de la API pública de Where The ISS At.

La app actualiza los datos automáticamente cada pocos segundos y muestra información básica como:

* Latitud
* Longitud
* Altitud (km)
* Velocidad (km/h)
* Hora de actualización

El objetivo es servir como base para futuros desarrollos más avanzados, como predicción de trayectorias, visualización en mapas 2D/3D, gráficas históricas o integración con AWS.

---

## 🚀 Tecnologías utilizadas

* **React.js**
* **JavaScript moderno (ES2020+)**
* **fetch API**
* **API pública: WhereTheISS.at**
  `https://api.wheretheiss.at/v1/satellites/25544`

---

## 📦 Scripts disponibles

En el directorio del proyecto puedes ejecutar:

### `npm start`

Inicia la app en modo desarrollo.
Abrir: **[http://localhost:3000](http://localhost:3000)**

### `npm test`

Ejecuta pruebas en modo interactivo.

### `npm run build`

Genera una versión optimizada de la app lista para producción en la carpeta `build/`.

### `npm run eject`

❗ **No recomendado a menos que sepas lo que haces.**
Expone toda la configuración interna de CRA para personalización avanzada.

---

## 📡 ¿Cómo funciona la App?

Cada 5 segundos la aplicación ejecuta una petición GET hacia:

```
https://api.wheretheiss.at/v1/satellites/25544
```

Y actualiza la vista con la información de la ISS.
Esto permite simular un monitoreo real sin necesidad de backend propio.

---

## 📁 Estructura principal del proyecto

```
src/
 ├── App.js     -  # Lógica principal del tracker
 ├── index.js       # Punto de entrada del proyecto
 ├── styles.css     # Estilos opcionales
 └── ...
```

---

## 🔮 Próximas mejoras (Roadmap)

Este proyecto está diseñado para escalar.
Ideas futuras:

* 🌍 **Agregar un mapa interactivo** (Leaflet o Mapbox)
* 🧭 **Mostrar la órbita futura** usando TLE + SGP4
* 🕒 **Histórico de posiciones** en una base de datos
* ☁️ **Migrar a AWS** con:

  * API Gateway
  * Lambda
  * DynamoDB
  * Amplify Hosting
* 🛰 **Visualización 3D de la ISS** con Three.js
* 🔔 **Notificaciones cuando pase cerca de tu ubicación**

---

## 📖 Aprendizaje recomendado

* React Hooks (useState, useEffect)
* Consumo de APIs con fetch
* Geolocalización y mapas web
* Conceptos básicos de órbita satelital (TLE, SGP4)

---

## 🤝 Contribución

Pull requests y sugerencias son bienvenidas.
Este proyecto está pensado tanto para práctica como para futura expansión a un sistema más complejo de monitoreo satelital.

---

## 📄 Licencia

MIT License.
