import { useCallback, useEffect, useMemo, useState } from 'react';
import { MapContainer, TileLayer, Marker, Circle, Polyline, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import dayjs from 'dayjs';
import * as satellite from 'satellite.js';
import 'leaflet/dist/leaflet.css';
import './App.css';
import issIconAsset from './assets/iss-icon.svg';

import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
});

const ISS_API = 'https://api.wheretheiss.at/v1/satellites/25544';
const POLL_INTERVAL_MS = 5000;
const ORBIT_MINUTES = 92;
const ORBITAL_SPEED_KM_S = 7.66; // respaldo simple
const INITIAL_VIEW = [0, 0];
const PASS_LOOKAHEAD_MINUTES = 360;
const PASS_STEP_SECONDS = 30;
const PASS_THRESHOLD_KM = 75;
const TLE_SOURCE = 'https://celestrak.org/NORAD/elements/stations.txt';

const issIcon = L.icon({
  iconUrl: issIconAsset,
  iconRetinaUrl: issIconAsset,
  iconSize: [42, 42],
  iconAnchor: [21, 21],
});

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

function formatDistance(distanceKm) {
  if (distanceKm == null || !Number.isFinite(distanceKm)) return '--';
  if (distanceKm >= 1000) {
    return `${(distanceKm / 1000).toFixed(1)} Mm`;
  }
  return `${distanceKm.toFixed(0)} km`;
}

function MapClickSetter({ onSelect }) {
  useMapEvents({
    click(event) {
      onSelect({ lat: event.latlng.lat, lng: event.latlng.lng, label: 'Punto elegido en el mapa' });
    },
  });
  return null;
}

function App() {
  const [issPosition, setIssPosition] = useState(null);
  const [issHistory, setIssHistory] = useState([]);
  const [targetPoint, setTargetPoint] = useState(null);
  const [error, setError] = useState(null);
  const [tle, setTle] = useState(null);
  const [satrec, setSatrec] = useState(null);
  const [nextPassPrediction, setNextPassPrediction] = useState(null);

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
    const interval = setInterval(fetchIssData, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const fetchTle = async () => {
      try {
        const response = await fetch(TLE_SOURCE);
        if (!response.ok) throw new Error('No se pudo descargar el TLE de la ISS');
        const text = await response.text();
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

  const distanceKm = useMemo(() => haversineDistanceKm(issPosition, targetPoint), [issPosition, targetPoint]);

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
      const dist = haversineDistanceKm(groundPoint, targetPoint);
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
  }, [satrec, targetPoint, issPosition?.timestamp, computeGroundPoint]);

  const fallbackEtaMinutes = useMemo(() => {
    if (distanceKm == null) return null;
    const seconds = distanceKm / ORBITAL_SPEED_KM_S;
    return seconds / 60;
  }, [distanceKm]);

  const etaMinutes = useMemo(() => {
    if (nextPassPrediction?.time) {
      return (nextPassPrediction.time - Date.now()) / 60000;
    }
    return fallbackEtaMinutes;
  }, [nextPassPrediction, fallbackEtaMinutes]);

  const orbitsRemaining = useMemo(() => {
    if (etaMinutes == null) return null;
    return etaMinutes / ORBIT_MINUTES;
  }, [etaMinutes]);

  const nextPassTime = useMemo(() => {
    if (nextPassPrediction?.time) {
      return dayjs(nextPassPrediction.time).format('DD MMM YYYY HH:mm:ss');
    }
    if (etaMinutes == null) return null;
    return dayjs().add(etaMinutes, 'minute').format('DD MMM YYYY HH:mm:ss');
  }, [nextPassPrediction, etaMinutes]);

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

  return (
    <div className="map-page">
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
        <MapClickSetter onSelect={(coords) => setTargetPoint(coords)} />
      </MapContainer>

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

      <div className="hud hud--top-right">
        <button className="primary" onClick={handleUseMyLocation}>
          Usar mi ubicación
        </button>
        <button className="secondary" onClick={() => setTargetPoint(null)}>
          Limpiar objetivo
        </button>
        <div className="panel-helper">También puedes hacer clic en el mapa para definir el punto.</div>
      </div>

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

      {error && <div className="error-banner">{error}</div>}
    </div>
  );
}

export default App;
