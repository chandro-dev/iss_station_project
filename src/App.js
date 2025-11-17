// Core dependencies: React hooks, Leaflet primitives, orbital math helpers, and styling.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

// Replace Leaflet's default marker assets to avoid missing-file warnings in bundlers.
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
});

// Global configuration for telemetry refresh, orbital modeling, and UI timings.
const ISS_API = 'https://api.wheretheiss.at/v1/satellites/25544';
const ISS_REFRESH_INTERVAL_MS = 2 * 60 * 60 * 1000; // refresh live telemetry every ~2 h
const LIVE_UPDATE_INTERVAL_MS = 1000; // update synthetic position from TLE once per second
const HISTORY_SAMPLE_INTERVAL_MS = 10000; // keep one history sample every 10 s to tame memory usage
const ORBIT_MINUTES = 92;
const ORBITAL_SPEED_KM_S = 7.66; // fallback when no instantaneous velocity is available
const INITIAL_VIEW = [0, 0];
const PASS_LOOKAHEAD_MINUTES = 1440;
const PASS_COARSE_STEP_SECONDS = 30; // coarse sampling window used to detect a potential pass
const PASS_REFINE_STEP_SECONDS = 1; // fine-grained step for final timing accuracy
const PASS_REFINE_WINDOW_SECONDS = 240; // +/- window explored around the coarse pass hit
const PASS_THRESHOLD_COARSE_KM = 75;
const PASS_THRESHOLD_DEFAULT_KM = 5;
const TLE_SOURCES = [
  { url: 'https://celestrak.org/NORAD/elements/stations.txt', format: 'text' },
  { url: 'https://www.celestrak.com/NORAD/elements/stations.txt', format: 'text' },
  { url: 'https://tle.ivanstanojevic.me/api/tle/25544', format: 'json' },
];
const SIM_STEP_SECONDS = 15;
const SIM_TIME_SCALE = 120; // 1 real second represents roughly 2 simulated minutes

// Shared ISS icon used for the live marker and the selected objective.
const issIcon = L.icon({
  iconUrl: issIconAsset,
  iconRetinaUrl: issIconAsset,
  iconSize: [42, 42],
  iconAnchor: [21, 21],
});

// Computes the great-circle distance in kilometers between two coordinates (Haversine).
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

// Returns a compact, human-friendly distance string (km or megameters).
function formatDistance(distanceKm) {
  if (distanceKm == null || !Number.isFinite(distanceKm)) return '--';
  if (distanceKm >= 1000) {
    return `${(distanceKm / 1000).toFixed(1)} Mm`;
  }
  return `${distanceKm.toFixed(0)} km`;
}

// Formats ETA values choosing seconds/minutes/hours depending on magnitude.
function formatEta(ms) {
  if (ms == null || !Number.isFinite(ms)) return '--';
  if (ms < 60 * 1000) return `${Math.max(ms / 1000, 1).toFixed(0)} s`;
  const minutes = ms / 60000;
  if (minutes < 120) return `${minutes.toFixed(1)} min`;
  return `${(minutes / 60).toFixed(1)} h`;
}

// Custom Leaflet hook that captures click events and exposes the selected lat/lng.
function MapClickSetter({ onSelect }) {
  useMapEvents({
    click(event) {
      onSelect({ lat: event.latlng.lat, lng: event.latlng.lng, label: 'Punto elegido en el mapa' });
    },
  });
  return null;
}

function App() {
  // Primary UI and simulation state: live telemetry, user target, orbital model, and animation controls.
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
  const [passThresholdKm, setPassThresholdKm] = useState(PASS_THRESHOLD_DEFAULT_KM);
  const lastHistoryUpdateRef = useRef(0);

  // Background effects overview:
  // 1. Periodically poll the public API for ISS reference telemetry (~every 2h).
  // 2. Refresh TLE sources hourly to keep the orbital solution current.
  // 3. Recompute the satrec structure every time a new TLE is available.
  // 4. Project the orbit forward to predict the next pass over the selected target.
  // 5. Reset the simulation when a new trajectory is generated.
  // 6. Advance the animation frame-by-frame using requestAnimationFrame.
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
          return next.slice(-120);
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

  // Real-time distance between the ISS ground track and the user-selected target.
  const distanceKm = useMemo(() => haversineDistanceKm(issPosition, targetPoint), [issPosition, targetPoint]);
  const passThresholdMeters = useMemo(() => passThresholdKm * 1000, [passThresholdKm]);

  // Normalizes longitude within [-180, 180] to avoid map wrap artifacts.
  const normalizeLng = useCallback((lng) => {
    if (!Number.isFinite(lng)) return lng;
    let normalized = lng % 360;
    if (normalized > 180) normalized -= 360;
    if (normalized < -180) normalized += 360;
    return normalized;
  }, []);

  // Computes the sub-satellite point (lat/lng) for a given timestamp based on the current TLE.
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

  // Returns both geodetic coordinates and instantaneous velocity derived from the satrec model.
  const computeIssState = useCallback(
    (timeMs) => {
      if (!satrec) return null;
      const date = new Date(timeMs);
      const positionAndVelocity = satellite.propagate(satrec, date);
      if (!positionAndVelocity.position) return null;
      const gmst = satellite.gstime(date);
      const geodetic = satellite.eciToGeodetic(positionAndVelocity.position, gmst);
      const lat = satellite.degreesLat(geodetic.latitude);
      const lng = normalizeLng(satellite.degreesLong(geodetic.longitude));
      let velocityKmh = null;
      if (positionAndVelocity.velocity) {
        const v = positionAndVelocity.velocity;
        const kmPerSecond = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
        velocityKmh = kmPerSecond * 3600;
      }
      return {
        lat,
        lng,
        timestamp: timeMs,
        velocityKmh,
      };
    },
    [satrec, normalizeLng]
  );

  // Synthesizes a "live" position from the TLE to keep the scene moving between telemetry refreshes.
  useEffect(() => {
    if (!satrec) return undefined;
    let cancelled = false;

    const updateFromTle = () => {
      if (cancelled) return;
      const now = Date.now();
      const state = computeIssState(now);
      if (!state) return;
      setIssPosition(state);
      if (now - lastHistoryUpdateRef.current >= HISTORY_SAMPLE_INTERVAL_MS) {
        lastHistoryUpdateRef.current = now;
        setIssHistory((prev) => {
          const next = [...prev, state];
          return next.slice(-120);
        });
      }
    };

    updateFromTle();
    const interval = setInterval(updateFromTle, LIVE_UPDATE_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [satrec, computeIssState]);

  useEffect(() => {
    if (!satrec || !targetPoint) {
      setNextPassPrediction(null);
      return;
    }
    const now = Date.now();
    const end = now + PASS_LOOKAHEAD_MINUTES * 60 * 1000;
    const coarseStepMs = PASS_COARSE_STEP_SECONDS * 1000;
    const refineStepMs = PASS_REFINE_STEP_SECONDS * 1000;
    const refineWindowMs = PASS_REFINE_WINDOW_SECONDS * 1000;
    let best = { distance: Infinity, time: null };
    let refineWindow = null;

    const evaluatePoint = (timeMs) => {
      const groundPoint = computeGroundPoint(timeMs);
      if (!groundPoint) return null;
      const ground = { lat: groundPoint.lat, lng: normalizeLng(groundPoint.lng) };
      const dist = haversineDistanceKm(ground, targetPoint);
      if (dist != null && dist < best.distance) {
        best = { distance: dist, time: timeMs };
      }
      return dist;
    };

    for (let t = now; t <= end; t += coarseStepMs) {
      const dist = evaluatePoint(t);
      if (dist != null && dist <= PASS_THRESHOLD_COARSE_KM) {
        refineWindow = {
          start: Math.max(now, t - refineWindowMs),
          end: Math.min(end, t + refineWindowMs),
        };
        break;
      }
    }

    if (refineWindow) {
      let bestRefined = { distance: Infinity, time: null };
      for (let t = refineWindow.start; t <= refineWindow.end; t += refineStepMs) {
        const dist = evaluatePoint(t);
        if (dist != null && dist < bestRefined.distance) {
          bestRefined = { distance: dist, time: t };
        }
        if (dist != null && dist <= passThresholdKm) {
          setNextPassPrediction({ time: t, distance: dist, thresholdHit: true });
          return;
        }
      }
      if (bestRefined.time) {
        setNextPassPrediction({
          time: bestRefined.time,
          distance: bestRefined.distance,
          thresholdHit: bestRefined.distance <= passThresholdKm,
        });
        return;
      }
    }

    if (best.time) {
      setNextPassPrediction({ time: best.time, distance: best.distance, thresholdHit: false });
    } else {
      setNextPassPrediction(null);
    }
  }, [satrec, targetPoint, computeGroundPoint, normalizeLng, passThresholdKm]);

  // Builds the simulated ground track between "now" and the predicted pass.
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
      if (distance != null && distance <= passThresholdKm) break;
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
  }, [satrec, targetPoint, nextPassPrediction?.time, computeGroundPoint, normalizeLng, passThresholdKm]);

  // Whenever a new path is generated, start the animation from the first timestamp.
  useEffect(() => {
    if (simulationPath?.length) {
      setIsSimPlaying(false);
      setSimTimeMs(simulationPath[0].time);
    } else {
      setIsSimPlaying(false);
      setSimTimeMs(null);
    }
  }, [simulationPath]);

  // requestAnimationFrame loop that advances the simulated clock respecting the current speed multiplier.
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

  // Fallback ETA assuming constant orbital speed when no precise prediction exists.
  const fallbackEtaMinutes = useMemo(() => {
    if (distanceKm == null) return null;
    const seconds = distanceKm / ORBITAL_SPEED_KM_S;
    return seconds / 60;
  }, [distanceKm]);

  // Preferred ETA sourced from the refined pass prediction.
  const etaMinutes = useMemo(() => {
    if (nextPassPrediction?.time) {
      return (nextPassPrediction.time - Date.now()) / 60000;
    }
    return fallbackEtaMinutes;
  }, [nextPassPrediction, fallbackEtaMinutes]);

  // Remaining orbits derived from the ETA estimate.
  const orbitsRemaining = useMemo(() => {
    if (etaMinutes == null) return null;
    return etaMinutes / ORBIT_MINUTES;
  }, [etaMinutes]);

  // Human-readable timestamp displayed in the HUD for the next pass.
  const nextPassTime = useMemo(() => {
    if (nextPassPrediction?.time) {
      return dayjs(nextPassPrediction.time).format('DD MMM YYYY HH:mm:ss');
    }
    if (etaMinutes == null) return null;
    return dayjs().add(etaMinutes, 'minute').format('DD MMM YYYY HH:mm:ss');
  }, [nextPassPrediction, etaMinutes]);

  // Instantaneous velocity derived from SGP4 (or telemetry as a last resort).
  const speedInfo = useMemo(() => {
    if (issPosition?.velocityKmh) {
      return { kmh: issPosition.velocityKmh, kms: issPosition.velocityKmh / 3600 };
    }
    const fallback = computeIssState(Date.now());
    if (fallback?.velocityKmh) {
      return { kmh: fallback.velocityKmh, kms: fallback.velocityKmh / 3600 };
    }
    return null;
  }, [issPosition, computeIssState]);

  // Interpolated position of the simulated marker between known samples.
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

  // Remaining distance to the objective based on the simulated track.
  const simDistanceRemaining = useMemo(() => {
    if (!targetPoint || !simulatedPosition) return null;
    return haversineDistanceKm(simulatedPosition, targetPoint);
  }, [targetPoint, simulatedPosition]);

  // Normalized 0-1 progress value used by the simulation progress bar.
  const simProgress = useMemo(() => {
    if (!simulationPath?.length || simTimeMs == null) return 0;
    const total = simulationPath[simulationPath.length - 1].time - simulationPath[0].time;
    if (total <= 0) return 0;
    return Math.min(1, Math.max(0, (simTimeMs - simulationPath[0].time) / total));
  }, [simulationPath, simTimeMs]);

  // Remaining simulated time in milliseconds.
  const simEtaMs = useMemo(() => {
    if (!simulationPath?.length || simTimeMs == null) return null;
    const end = simulationPath[simulationPath.length - 1].time;
    return Math.max(end - simTimeMs, 0);
  }, [simulationPath, simTimeMs]);

  // Splits polylines when crossing +/-180° to prevent Leaflet from drawing long wraparound lines.
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

  // Requests browser geolocation and uses that point as the active target.
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

  // Indicates if a full simulation path is available for controls to act upon.
  const simulationAvailable = Boolean(simulationPath?.length);

  // Toggles the playback state of the simulation.
  const handleSimPlayPause = () => {
    if (!simulationAvailable) return;
    setIsSimPlaying((prev) => !prev);
  };

  // Resets playback to the first simulated timestamp.
  const handleSimReset = () => {
    if (!simulationAvailable) return;
    setIsSimPlaying(false);
    setSimTimeMs(simulationPath[0].time);
  };

  // Switches between 1x and 2x playback speed multipliers.
  const handleSimSpeedToggle = () => {
    setSimSpeedMultiplier((prev) => (prev === 1 ? 8 : 1));
  };

  return (
    <div className="map-page">
      {/* Main 2D map with live telemetry overlays and interaction handlers. */}
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
            <Circle center={[targetPoint.lat, targetPoint.lng]} radius={passThresholdMeters} pathOptions={{ color: '#fb923c', weight: 1 }} />
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
      {/* Companion 3D visualization built with Three.js for additional context. */}
      <EarthGlobe
        issPosition={issPosition}
        targetPoint={targetPoint}
        simulationPath={simulationPath}
        simulatedPosition={simulatedPosition}
        isSimPlaying={isSimPlaying}
      />

      {/* Upper-left HUD: live telemetry snapshot. */}
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

      {/* Upper-right HUD: target selection, geolocation, and simulation controls. */}
      <div className="hud hud--top-right">
        <button className="primary" onClick={handleUseMyLocation}>
          Usar mi ubicación
        </button>
        <button className="secondary" onClick={() => setTargetPoint(null)}>
          Limpiar objetivo
        </button>
        <label className="panel-label" htmlFor="precision-slider">
          Precisión objetivo ({passThresholdKm.toFixed(0)} km)
        </label>
        <input
          id="precision-slider"
          type="range"
          min="25"
          max="500"
          step="5"
          value={passThresholdKm}
          onChange={(event) => setPassThresholdKm(Number(event.target.value))}
        />
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

      {/* Lower HUD: consolidated orbital metrics and ETA readouts. */}
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

      {/* Error banner for any networking/modeling failures. */}
      {error && <div className="error-banner">{error}</div>}
    </div>
  );
}

export default App;
