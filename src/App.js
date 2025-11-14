// Dependencias principales: React, Leaflet, utilidades matemáticas y estilos.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { MapContainer, TileLayer, Marker, Circle, Polyline, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import dayjs from 'dayjs';
import * as satellite from 'satellite.js';
import 'leaflet/dist/leaflet.css';
import './App.css';
import issIconAsset from './assets/iss-icon.svg';
import EarthGlobe from './components/EarthGlobe';

import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';

// Ajustamos el icono por defecto de Leaflet para evitar que falten assets.
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
});

// Constantes de configuración general y parámetros del modelo.
const ISS_API = 'https://api.wheretheiss.at/v1/satellites/25544';
const ISS_REFRESH_INTERVAL_MS = 2 * 60 * 60 * 1000; // refrescamos telemetria cada 2 h
const ORBIT_MINUTES = 92;
const ORBITAL_SPEED_KM_S = 7.66; // respaldo simple
const INITIAL_VIEW = [0, 0];
const PASS_LOOKAHEAD_MINUTES = 1440;
const PASS_STEP_SECONDS = 30;
const PASS_THRESHOLD_KM = 75;
const TLE_SOURCES = [
  { url: 'https://celestrak.org/NORAD/elements/stations.txt', format: 'text' },
  { url: 'https://www.celestrak.com/NORAD/elements/stations.txt', format: 'text' },
  { url: 'https://tle.ivanstanojevic.me/api/tle/25544', format: 'json' },
];
const SIM_STEP_SECONDS = 15;
const SIM_TIME_SCALE = 120; // 1s real = 2min simulados aprox.

// Icono específico para la ISS y el punto objetivo.
const issIcon = L.icon({
  iconUrl: issIconAsset,
  iconRetinaUrl: issIconAsset,
  iconSize: [42, 42],
  iconAnchor: [21, 21],
});

// Calcula distancia en km entre dos coordenadas usando Haversine.
function haversineDistanceKm(origin, target) {
  if (!origin || !target) return null;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(target.lat - origin.lat);
  const dLon = toRad(target.lng - origin.lng);
  const lat1 = toRad(origin.lat);
  const lat2 = toRad(target.lat);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.sin(dLon / 2) * Math.sin(dLon / 2) * Math.cos(lat1) * Math.cos(lat2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Formato amigable para mostrar distancias (km/Mm).
function formatDistance(distanceKm) {
  if (distanceKm == null || !Number.isFinite(distanceKm)) return '--';
  if (distanceKm >= 1000) {
    return `${(distanceKm / 1000).toFixed(1)} Mm`;
  }
  return `${distanceKm.toFixed(0)} km`;
}

// Formatea tiempos estimados en unidades legibles.
function formatEta(ms) {
  if (ms == null || !Number.isFinite(ms)) return '--';
  if (ms < 60 * 1000) return `${Math.max(ms / 1000, 1).toFixed(0)} s`;
  const minutes = ms / 60000;
  if (minutes < 120) return `${minutes.toFixed(1)} min`;
  return `${(minutes / 60).toFixed(1)} h`;
}

// Hook Leaflet personalizado para detectar clics en el mapa.
function MapClickSetter({ onSelect }) {
  useMapEvents({
    click(event) {
      onSelect({ lat: event.latlng.lat, lng: event.latlng.lng, label: 'Punto elegido en el mapa' });
    },
  });
  return null;
}

function App() {
  // Estados principales de la vista: telemetría, objetivo, simulación y errores.
  const [issPosition, setIssPosition] = useState(null);
  const [issHistory, setIssHistory] = useState([]);
  const [targetPoint, setTargetPoint] = useState(null);
  const [error, setError] = useState(null);
  const [tle, setTle] = useState(null);
  const [satrec, setSatrec] = useState(null);
  const [nextPassPrediction, setNextPassPrediction] = useState(null);
  const [isSimPlaying, setIsSimPlaying] = useState(false);
  const [simTimeMs, setSimTimeMs] = useState(null);
  const [simSpeedMultiplier, setSimSpeedMultiplier] = useState(1);

  // Poll periodico a la API publica para obtener la telemetria de referencia (cada 2 h).
  // Descarga y refresca periodicamente los TLE disponibles.
  // Cada vez que cambia el TLE se recalcula el satrec con satellite.js.
  // Explora la orbita futura para estimar la proxima pasada sobre el objetivo.
  // Si hay nueva trayectoria, reiniciamos la reproduccion.
  // Animacion cuadro a cuadro que avanza el tiempo de simulacion.
  useEffect(() => {
    let cancelled = false;

    const fetchIssData = async () => {
      try {
        const response = await fetch(ISS_API);
        if (!response.ok) throw new Error('No se pudo leer la telemetría de la ISS');
        const data = await response.json();
        if (cancelled) return;
        const position = {
          lat: data.latitude,
          lng: data.longitude,
          timestamp: data.timestamp * 1000,
          velocityKmh: data.velocity,
        };
        setIssPosition(position);
        setIssHistory((prev) => {
          const next = [...prev, position];
          return next.slice(-60);
        });
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    };

    fetchIssData();
    const interval = setInterval(fetchIssData, ISS_REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const fetchTle = async () => {
      try {
        let text = null;
        let lastError = null;

        for (const source of TLE_SOURCES) {
          try {
            const response = await fetch(source.url);
            if (!response.ok) throw new Error(`Respuesta ${response.status}`);
            if (source.format === 'json') {
              const data = await response.json();
              if (data?.line1 && data?.line2) {
                const name = data?.name || 'ISS (ZARYA)';
                text = `${name}\n${data.line1}\n${data.line2}`;
              } else {
                throw new Error('JSON sin lineas TLE');
              }
            } else {
              text = await response.text();
            }
            break;
          } catch (err) {
            lastError = err;
          }
        }

        if (!text) {
          const msg = lastError?.message || 'No se pudo descargar el TLE de la ISS';
          throw new Error(`Fuentes TLE inalcanzables (${msg})`);
        }

        if (cancelled) return;
        const lines = text.split('\n').map((line) => line.trim());
        const index = lines.findIndex((line) => line.toUpperCase().startsWith('ISS (ZARYA)'));
        if (index >= 0 && lines[index + 1] && lines[index + 2]) {
          setTle({ line1: lines[index + 1], line2: lines[index + 2], fetchedAt: Date.now() });
          setError(null);
        } else {
          throw new Error('No encontramos el TLE de la ISS');
        }
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    };

    fetchTle();
    const interval = setInterval(fetchTle, 60 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (tle?.line1 && tle?.line2) {
      try {
        setSatrec(satellite.twoline2satrec(tle.line1, tle.line2));
      } catch (err) {
        setError('No pudimos crear el modelo orbital');
      }
    }
  }, [tle]);

  // Distancia actual entre la ISS y el objetivo.
  const distanceKm = useMemo(() => haversineDistanceKm(issPosition, targetPoint), [issPosition, targetPoint]);

  // Calcula el punto sub-satelital en tierra para un instante dado.
  const computeGroundPoint = useCallback((timeMs) => {
    if (!satrec) return null;
    const date = new Date(timeMs);
    const positionAndVelocity = satellite.propagate(satrec, date);
    if (!positionAndVelocity.position) return null;
    const gmst = satellite.gstime(date);
    const geodetic = satellite.eciToGeodetic(positionAndVelocity.position, gmst);
    return {
      lat: satellite.degreesLat(geodetic.latitude),
      lng: satellite.degreesLong(geodetic.longitude),
    };
  }, [satrec]);

  // Evita saltos de 360° limitando la longitud.
  const normalizeLng = useCallback((lng) => {
    if (!Number.isFinite(lng)) return lng;
    let normalized = lng % 360;
    if (normalized > 180) normalized -= 360;
    if (normalized < -180) normalized += 360;
    return normalized;
  }, []);

  useEffect(() => {
    if (!satrec || !targetPoint) {
      setNextPassPrediction(null);
      return;
    }
    const now = Date.now();
    const end = now + PASS_LOOKAHEAD_MINUTES * 60 * 1000;
    let best = { distance: Infinity, time: null };

    for (let t = now; t <= end; t += PASS_STEP_SECONDS * 1000) {
      const groundPoint = computeGroundPoint(t);
      if (!groundPoint) continue;
      const ground = { lat: groundPoint.lat, lng: normalizeLng(groundPoint.lng) };
      const dist = haversineDistanceKm(ground, targetPoint);
      if (dist != null && dist < best.distance) {
        best = { distance: dist, time: t };
      }
      if (dist != null && dist <= PASS_THRESHOLD_KM) {
        setNextPassPrediction({ time: t, distance: dist, thresholdHit: true });
        return;
      }
    }

    if (best.time) {
      setNextPassPrediction({ time: best.time, distance: best.distance, thresholdHit: false });
    } else {
      setNextPassPrediction(null);
    }
  }, [satrec, targetPoint, computeGroundPoint, normalizeLng]);

  // Construye la ruta simulada entre ahora y la próxima pasada.
  // Construye la ruta simulada entre ahora y la próxima pasada.
  const simulationPath = useMemo(() => {
    if (!satrec || !targetPoint || !nextPassPrediction?.time) return null;
    const now = Date.now();
    const end = nextPassPrediction.time;
    if (end <= now) return null;

    const stepMs = SIM_STEP_SECONDS * 1000;
    const path = [];
    const startPoint = computeGroundPoint(now);
    if (startPoint) {
      path.push({ ...startPoint, time: now });
    }

    for (let t = now + stepMs; t <= end + stepMs; t += stepMs) {
      const groundPoint = computeGroundPoint(t);
      if (!groundPoint) continue;
      const ground = { lat: groundPoint.lat, lng: normalizeLng(groundPoint.lng) };
      const distance = haversineDistanceKm(ground, targetPoint);
      path.push({ ...ground, time: t, distance });
      if (distance != null && distance <= PASS_THRESHOLD_KM) break;
    }

    if (path.length < 2) return null;

    const lastPoint = path[path.length - 1];
    if (lastPoint.time < end) {
      const finalPoint = computeGroundPoint(end);
      if (finalPoint) {
        const ground = { lat: finalPoint.lat, lng: normalizeLng(finalPoint.lng) };
        path.push({ ...ground, time: end });
      }
    }

    return path;
  }, [satrec, targetPoint, nextPassPrediction?.time, computeGroundPoint, normalizeLng]);

  useEffect(() => {
    if (simulationPath?.length) {
      setIsSimPlaying(false);
      setSimTimeMs(simulationPath[0].time);
    } else {
      setIsSimPlaying(false);
      setSimTimeMs(null);
    }
  }, [simulationPath]);

  useEffect(() => {
    if (!isSimPlaying || !simulationPath?.length) return undefined;
    let frame;
    let running = true;
    let previous = null;
    const endTime = simulationPath[simulationPath.length - 1].time;
    const speedFactor = SIM_TIME_SCALE * simSpeedMultiplier;

    const step = (timestamp) => {
      if (!running) return;
      if (previous == null) previous = timestamp;
      const delta = timestamp - previous;
      previous = timestamp;

      setSimTimeMs((current) => {
        const base = current ?? simulationPath[0].time;
        const next = base + delta * speedFactor;
        if (next >= endTime) {
          running = false;
          setIsSimPlaying(false);
          return endTime;
        }
        return next;
      });

      if (running) {
        frame = requestAnimationFrame(step);
      }
    };

    frame = requestAnimationFrame(step);
    return () => {
      running = false;
      if (frame) cancelAnimationFrame(frame);
    };
  }, [isSimPlaying, simulationPath, simSpeedMultiplier]);

  // ETA simple suponiendo movimiento uniforme (respaldo).
  const fallbackEtaMinutes = useMemo(() => {
    if (distanceKm == null) return null;
    const seconds = distanceKm / ORBITAL_SPEED_KM_S;
    return seconds / 60;
  }, [distanceKm]);

  // ETA preferido: usa predicción orbital si está disponible.
  const etaMinutes = useMemo(() => {
    if (nextPassPrediction?.time) {
      return (nextPassPrediction.time - Date.now()) / 60000;
    }
    return fallbackEtaMinutes;
  }, [nextPassPrediction, fallbackEtaMinutes]);

  // Conversión de minutos restantes a órbitas.
  const orbitsRemaining = useMemo(() => {
    if (etaMinutes == null) return null;
    return etaMinutes / ORBIT_MINUTES;
  }, [etaMinutes]);

  // Fecha/hora legible para mostrar en el HUD.
  const nextPassTime = useMemo(() => {
    if (nextPassPrediction?.time) {
      return dayjs(nextPassPrediction.time).format('DD MMM YYYY HH:mm:ss');
    }
    if (etaMinutes == null) return null;
    return dayjs().add(etaMinutes, 'minute').format('DD MMM YYYY HH:mm:ss');
  }, [nextPassPrediction, etaMinutes]);

  // Estima la velocidad actual (modelo o telemetría).
  const speedInfo = useMemo(() => {
    if (satrec) {
      const positionAndVelocity = satellite.propagate(satrec, new Date());
      if (positionAndVelocity.velocity) {
        const v = positionAndVelocity.velocity;
        const kmPerSecond = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
        return { kmh: kmPerSecond * 3600, kms: kmPerSecond };
      }
    }
    if (issPosition?.velocityKmh) {
      return { kmh: issPosition.velocityKmh, kms: issPosition.velocityKmh / 3600 };
    }
    return null;
  }, [satrec, issPosition]);

  // Posición interpolada del marcador durante la simulación.
  const simulatedPosition = useMemo(() => {
    if (!simulationPath?.length || simTimeMs == null) return null;
    if (simTimeMs <= simulationPath[0].time) return simulationPath[0];
    for (let i = 0; i < simulationPath.length - 1; i += 1) {
      const current = simulationPath[i];
      const next = simulationPath[i + 1];
      if (simTimeMs >= current.time && simTimeMs <= next.time) {
        const segment = next.time - current.time || 1;
        const ratio = (simTimeMs - current.time) / segment;
        return {
          lat: current.lat + (next.lat - current.lat) * ratio,
          lng: current.lng + (next.lng - current.lng) * ratio,
          time: simTimeMs,
        };
      }
    }
    return simulationPath[simulationPath.length - 1];
  }, [simulationPath, simTimeMs]);

  // Distancia restante dentro de la simulación (HUD derecho).
  const simDistanceRemaining = useMemo(() => {
    if (!targetPoint || !simulatedPosition) return null;
    return haversineDistanceKm(simulatedPosition, targetPoint);
  }, [targetPoint, simulatedPosition]);

  // Progreso normalizado (para la barra de avance).
  const simProgress = useMemo(() => {
    if (!simulationPath?.length || simTimeMs == null) return 0;
    const total = simulationPath[simulationPath.length - 1].time - simulationPath[0].time;
    if (total <= 0) return 0;
    return Math.min(1, Math.max(0, (simTimeMs - simulationPath[0].time) / total));
  }, [simulationPath, simTimeMs]);

  // Tiempo faltante en la simulación, en milisegundos.
  const simEtaMs = useMemo(() => {
    if (!simulationPath?.length || simTimeMs == null) return null;
    const end = simulationPath[simulationPath.length - 1].time;
    return Math.max(end - simTimeMs, 0);
  }, [simulationPath, simTimeMs]);

  // Divide la polilínea para evitar saltos al cruzar el meridiano 180°.
  const simulationSegments = useMemo(() => {
    if (!simulationPath?.length) return null;
    const segments = [];
    let current = [];

    simulationPath.forEach((point, index) => {
      const coords = [point.lat, point.lng];
      if (!current.length) {
        current.push(coords);
      } else {
        const prev = current[current.length - 1];
        const diff = Math.abs(coords[1] - prev[1]);
        if (diff > 180) {
          if (current.length > 1) segments.push(current);
          current = [coords];
        } else {
          current.push(coords);
        }
      }

      if (index === simulationPath.length - 1 && current.length > 1) {
        segments.push(current);
      }
    });

    return segments.length ? segments : null;
  }, [simulationPath]);

  // Utiliza la API de geolocalización para fijar el destino.
  const handleUseMyLocation = () => {
    if (!navigator.geolocation) {
      setError('Tu navegador no soporta geolocalización');
      return;
    }

    navigator.geolocation.getCurrentPosition(
      ({ coords }) =>
        setTargetPoint({
          lat: coords.latitude,
          lng: coords.longitude,
          label: 'Tu ubicación',
        }),
      () => setError('No pudimos obtener tu ubicación'),
      { enableHighAccuracy: true, timeout: 5000 }
    );
  };

  // Indicador de si tenemos una trayectoria válida para controlar.
  const simulationAvailable = Boolean(simulationPath?.length);

  // Alterna entre reproducir o pausar la simulación.
  const handleSimPlayPause = () => {
    if (!simulationAvailable) return;
    setIsSimPlaying((prev) => !prev);
  };

  // Vuelve al inicio de la trayectoria simulada.
  const handleSimReset = () => {
    if (!simulationAvailable) return;
    setIsSimPlaying(false);
    setSimTimeMs(simulationPath[0].time);
  };

  // Cambia la velocidad de reproducción entre 1x y 2x.
  const handleSimSpeedToggle = () => {
    setSimSpeedMultiplier((prev) => (prev === 1 ? 8 : 1));
  };

  return (
    <div className="map-page">
      {/* Bloque principal: mapa 2D con capas y overlays en vivo. */}
      <MapContainer
        center={issPosition ? [issPosition.lat, issPosition.lng] : INITIAL_VIEW}
        zoom={3}
        scrollWheelZoom
        className="map-full"
      >
        <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
        {issPosition && (
          <Marker position={[issPosition.lat, issPosition.lng]} icon={issIcon}>
            <span className="marker-label">ISS</span>
          </Marker>
        )}
        {targetPoint && (
          <>
            <Marker position={[targetPoint.lat, targetPoint.lng]} icon={issIcon}>
              <span className="marker-label">Objetivo</span>
            </Marker>
            <Circle center={[targetPoint.lat, targetPoint.lng]} radius={500000} pathOptions={{ color: '#fb923c', weight: 1 }} />
          </>
        )}
        {issHistory.length > 1 && (
          <Polyline
            positions={issHistory.map((point) => [point.lat, point.lng])}
            pathOptions={{ color: '#22d3ee', weight: 2, opacity: 0.7 }}
          />
        )}
        {simulationSegments &&
          simulationSegments.map((segment, index) => (
            <Polyline
              key={`sim-segment-${index}`}
              positions={segment}
              pathOptions={{ color: '#a855f7', weight: 2, opacity: 0.75, dashArray: '8 6' }}
            />
          ))}
        {simulatedPosition && (
          <Circle
            center={[simulatedPosition.lat, simulatedPosition.lng]}
            radius={200000}
            pathOptions={{ color: '#a855f7', fillColor: '#a855f7', fillOpacity: 0.15, weight: 1 }}
          />
        )}
        <MapClickSetter onSelect={(coords) => setTargetPoint(coords)} />
      </MapContainer>
      {/* Visualización 3D complementaria con la misma data. */}
      <EarthGlobe
        issPosition={issPosition}
        targetPoint={targetPoint}
        simulationPath={simulationPath}
        simulatedPosition={simulatedPosition}
        isSimPlaying={isSimPlaying}
      />

      {/* HUD superior izquierdo: telemetría básica. */}
      <div className="hud hud--top-left">
        <div>
          <div className="panel-label">Posición ISS</div>
          <div className="panel-value">
            {issPosition ? `${issPosition.lat.toFixed(2)}°, ${issPosition.lng.toFixed(2)}°` : 'Cargando'}
          </div>
        </div>
        <div>
          <div className="panel-label">Última actualización</div>
          <div className="panel-value">{issPosition ? dayjs(issPosition.timestamp).format('HH:mm:ss') : '--:--:--'}</div>
        </div>
        <div>
          <div className="panel-label">Velocidad</div>
          <div className="panel-value">
            {speedInfo ? `${speedInfo.kmh.toFixed(0)} km/h (${speedInfo.kms.toFixed(2)} km/s)` : '--'}
          </div>
        </div>
      </div>

      {/* HUD superior derecho: selección de objetivo y controles. */}
      <div className="hud hud--top-right">
        <button className="primary" onClick={handleUseMyLocation}>
          Usar mi ubicación
        </button>
        <button className="secondary" onClick={() => setTargetPoint(null)}>
          Limpiar objetivo
        </button>
        <div className="panel-helper">También puedes hacer clic en el mapa para definir el punto.</div>
        {targetPoint && !simulationAvailable && (
          <div className="panel-helper">Calculando trayectoria orbital...</div>
        )}
        {simulationAvailable && (
          <div className="sim-panel-inline">
            <div className="panel-label">Simulación al objetivo</div>
            <div className="sim-panel__metrics">
              <span>{formatDistance(simDistanceRemaining)}</span>
              <span>{formatEta(simEtaMs)}</span>
            </div>
            <div className="sim-progress">
              <div className="sim-progress__bar" style={{ width: `${(simProgress * 100).toFixed(1)}%` }} />
            </div>
            <div className="sim-controls">
              <button className="tertiary" onClick={handleSimPlayPause}>
                {isSimPlaying ? 'Pausar' : 'Play'}
              </button>
              <button className="tertiary" onClick={handleSimReset} disabled={simProgress === 0 && !isSimPlaying}>
                Reiniciar
              </button>
              <button className="tertiary" onClick={handleSimSpeedToggle}>
                {simSpeedMultiplier === 1 ? 'x1' : 'x2'}
              </button>
            </div>
            <div className="panel-helper">
              {isSimPlaying ? 'Reproduciendo' : 'Pausado'} · ETA sim {formatEta(simEtaMs)}
            </div>
          </div>
        )}
      </div>

      {/* HUD inferior: resumen de distancias y ETA. */}
      <div className="hud hud--bottom">
        <div>
          <div className="panel-label">Punto objetivo</div>
          <div className="panel-value">
            {targetPoint ? `${targetPoint.lat.toFixed(2)}°, ${targetPoint.lng.toFixed(2)}°` : 'Sin objetivo'}
          </div>
        </div>
        <div>
          <div className="panel-label">Distancia ISS → Punto</div>
          <div className="panel-value">{formatDistance(distanceKm)}</div>
        </div>
        <div>
          <div className="panel-label">Próximo paso estimado</div>
          <div className="panel-value">{nextPassTime || '--'}</div>
          {nextPassPrediction && !nextPassPrediction.thresholdHit && (
            <div className="panel-helper">
              Distancia mínima esperada ≈ {formatDistance(nextPassPrediction.distance)}
            </div>
          )}
        </div>
        <div>
          <div className="panel-label">Órbitas restantes</div>
          <div className="panel-value">
            {orbitsRemaining == null ? '--' : orbitsRemaining < 1 ? orbitsRemaining.toFixed(2) : orbitsRemaining.toFixed(1)}
          </div>
          <div className="panel-helper">Período orbital medio: {ORBIT_MINUTES} min</div>
        </div>
        <div className="eta-pill">
          <div className="panel-label">ETA aprox.</div>
          <div className="panel-value">
            {etaMinutes == null ? '--' : `${etaMinutes < 120 ? etaMinutes.toFixed(1) : (etaMinutes / 60).toFixed(1)} ${
              etaMinutes < 120 ? 'min' : 'h'
            }`}
          </div>
        </div>
      </div>

      {/* Banner general para mostrar cualquier error de red/modelo. */}
      {error && <div className="error-banner">{error}</div>}
    </div>
  );
}

export default App;
