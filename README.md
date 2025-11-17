# ISS Mission Support Suite

Aplicación web que combina datos orbitales reales, simulaciones aceleradas y visualización 2D/3D para comprender cómo se mueve la Estación Espacial Internacional (ISS) respecto a cualquier punto de la Tierra.

---

## Qué hace el proyecto

1. **Sincronización inicial**  
   - Descarga una telemetría desde `https://api.wheretheiss.at/v1/satellites/25544`.  
   - Obtiene las últimas líneas TLE desde tres fuentes (Celestrak x2 e Ivan Stanojevic).  
   - Convierte las TLE en un modelo orbital (`satrec`) usando `satellite.js`.

2. **Predicción y simulación**  
   - Calcula distancias ISS ↔ objetivo mediante Haversine.  
   - Recorre la órbita futura y refina una ventana de ±240 s para encontrar el instante exacto en el que la ISS cruza el punto elegido (5 km por defecto, configurable).  
   - Construye una trayectoria simulada en pasos de 15 s y la anima con controles `Play`, `Pause`, `Reset` y velocidad `x1/x2`.

3. **Visualización**  
   - Mapa Leaflet con la posición actual, historial, trayecto simulado segmentado, objetivos definibles por clic o geolocalización y overlays de ETA.  
   - Globo 3D (Three.js) sincronizado con las mismas coordenadas para observar la órbita completa.  
   - HUDs que muestran: velocidad instantánea, última actualización, orbits restantes, ETA aproximado y datos del objetivo.

4. **Refresco controlado**  
   - Solo vuelve a pedir telemetría cada 2 h para mantener la precisión sin interrumpir la simulación en curso.

---

## Librerías y por qué se usan

| Librería | Uso principal |
|----------|---------------|
| **React 19** | Gestión de estado con hooks (`useState`, `useEffect`, `useMemo`, `useCallback`) para toda la lógica de simulación y UI. |
| **React Leaflet + Leaflet** | Mapa 2D interactivo, capas para historial, objetivos, círculos de proximidad y polilíneas segmentadas. |
| **React Three Fiber + Three.js + @react-three/drei** | Globo 3D que muestra la ruta de la ISS desde un punto de vista espacial. |
| **satellite.js** | Conversión de TLE → satrec → coordenadas geodésicas, velocidad orbital, propagación a futuro. |
| **dayjs** | Formato de fechas/hora para HUDs. |
| **Fetch API (nativa)** | Obtener telemetría de WhereTheISS y TLEs remotos sin dependencias extra. |

Dependencias auxiliares de CRA (`react-scripts`, testing-library, web-vitals) se mantienen para scripts de desarrollo y pruebas.

---

## Flujo operacional

```
Al montar App.js
 ├─ Fetch WhereTheISS → setIssPosition / setIssHistory
 ├─ Descargar TLE (3 fuentes) → setTle → setSatrec
 └─ Cada 2h repetir los pasos anteriores

Al seleccionar un objetivo
 ├─ useMemo(distance, ETA fallback)
 ├─ useEffect(nextPassPrediction) → barrido de la órbita futura
 └─ useMemo(simulationPath) → animación frame-by-frame con SIM_TIME_SCALE * multiplier
```

Todo se pinta simultáneamente en:

- `MapContainer` (Leaflet) con `Marker`, `Circle`, `Polyline` y `MapClickSetter`.
- `EarthGlobe` (Three.js) para vista 3D.
- Tres HUDs que muestran telemetría, controles y métricas.

---

## Scripts disponibles

```bash
npm install        # instala dependencias y ejecuta scripts/fix-mediapipe-map.js
npm start          # entorno de desarrollo en http://localhost:3000
npm test           # pruebas de CRA
npm run build      # empaqueta para producción en /build
```

> `postinstall` ejecuta `scripts/fix-mediapipe-map.js` para crear un source map dummy requerido por `@mediapipe/tasks-vision`, eliminando el warning de `source-map-loader`.

---

## Funcionamiento interno clave

- **Distancias**: Haversine con radio terrestre 6371 km.  
- **Normalización**: longitudes envueltas a [-180, 180] para evitar saltos visuales.  
- **Velocidad**: magnitud del vector devuelto por `satellite.propagate`; si falta, se usa la telemetría.  
- **Próximo pase**: bucle en pasos de 30 s hasta 24 h hacia adelante; cuando `dist <= PASS_THRESHOLD_KM` se marca ETA preciso.  
- **Simulación**: vector de puntos cada 15 s → interpolación lineal → `requestAnimationFrame` con factor `SIM_TIME_SCALE * simSpeedMultiplier`.  
- **HUD**: métricas derivadas (`orbitsRemaining`, `nextPassTime`, `simEtaMs`, `simProgress`).

---



## Licencia

Proyecto bajo licencia **MIT**. Contribuciones y mejoras a la física o a la UI/UX son bienvenidas.
