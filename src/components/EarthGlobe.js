import { Canvas, useFrame } from '@react-three/fiber';
import { Line, OrbitControls, Stars } from '@react-three/drei';
import { useMemo, useRef } from 'react';

const EARTH_RADIUS = 1;
const ISS_RADIUS = 1.15;
const TARGET_RADIUS = 1.03;

// Projects a latitude/longitude tuple onto a sphere of the provided radius.
function latLngToCartesian(lat, lng, radius = EARTH_RADIUS) {
  if (typeof lat !== 'number' || typeof lng !== 'number') return [0, 0, 0];
  const latRad = (lat * Math.PI) / 180;
  const lonRad = (lng * Math.PI) / 180;
  const x = radius * Math.cos(latRad) * Math.cos(lonRad);
  const y = radius * Math.sin(latRad);
  const z = radius * Math.cos(latRad) * Math.sin(lonRad);
  return [x, y, z];
}

// Simple Earth model that slowly rotates to hint at the passage of time.
function Earth() {
  const earthRef = useRef();

  useFrame((_, delta) => {
    if (earthRef.current) {
      earthRef.current.rotation.y += delta * 0.05;
    }
  });

  return (
    <group ref={earthRef}>
      <mesh>
        <sphereGeometry args={[EARTH_RADIUS, 64, 64]} />
        <meshStandardMaterial color="#1e3a8a" roughness={0.8} metalness={0.05} />
      </mesh>
      <mesh>
        <sphereGeometry args={[EARTH_RADIUS + 0.01, 64, 64]} />
        <meshBasicMaterial color="#22d3ee" wireframe opacity={0.15} transparent />
      </mesh>
    </group>
  );
}

// Generic glowing sphere used for ISS, targets, and live markers.
function Marker({ lat, lng, radius, color, size = 0.04 }) {
  const position = useMemo(() => latLngToCartesian(lat, lng, radius), [lat, lng, radius]);
  return (
    <mesh position={position}>
      <sphereGeometry args={[size, 16, 16]} />
      <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.9} />
    </mesh>
  );
}

// Flat circular ring highlighting the nominal ISS orbital altitude.
function OrbitRing() {
  const positions = useMemo(() => {
    const segments = 128;
    const pts = [];
    for (let i = 0; i <= segments; i += 1) {
      const theta = (i / segments) * Math.PI * 2;
      pts.push(Math.cos(theta) * ISS_RADIUS, 0, Math.sin(theta) * ISS_RADIUS);
    }
    return new Float32Array(pts);
  }, []);

  return (
    <lineLoop>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" count={positions.length / 3} array={positions} itemSize={3} />
      </bufferGeometry>
      <lineBasicMaterial color="#fbbf24" linewidth={2} transparent opacity={0.2} />
    </lineLoop>
  );
}

// Converts a set of lat/lng pairs into a 3D polyline representing the simulated track.
function Trajectory({ path }) {
  const points = useMemo(() => {
    if (!path?.length) return null;
    const lastIndex = Math.max(path.length - 1, 1);
    return path.map((point, index) => {
      const radius = ISS_RADIUS - ((ISS_RADIUS - TARGET_RADIUS) * index) / lastIndex;
      return latLngToCartesian(point.lat, point.lng, radius);
    });
  }, [path]);

  if (!points) return null;

  return <Line points={points} color="#a855f7" lineWidth={2} transparent opacity={0.85} />;
}

// Formats coordinates with sign indicators for quick inspection.
function formatCoord(value) {
  if (typeof value !== 'number') return '--';
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}°`;
}

export default function EarthGlobe({ issPosition, targetPoint, simulationPath, simulatedPosition, isSimPlaying }) {
  const activePosition = simulatedPosition || issPosition;
  const showLiveMarker =
    issPosition &&
    simulatedPosition &&
    (Math.abs(issPosition.lat - simulatedPosition.lat) > 0.1 ||
      Math.abs(issPosition.lng - simulatedPosition.lng) > 0.1);

  return (
    <div className="globe-panel">
      <Canvas camera={{ position: [0, 0, 3.2], fov: 60 }}>
        <ambientLight intensity={0.5} />
        <directionalLight position={[4, 2, 2]} intensity={1.2} />
        <Stars radius={40} depth={20} count={800} factor={4} fade speed={1} />
        <Earth />
        <OrbitRing />
        {simulationPath && <Trajectory path={simulationPath} />}
        {targetPoint && (
          <Marker lat={targetPoint.lat} lng={targetPoint.lng} radius={TARGET_RADIUS} color="#22d3ee" size={0.035} />
        )}
        {activePosition && <Marker lat={activePosition.lat} lng={activePosition.lng} radius={ISS_RADIUS} color="#f97316" size={0.05} />}
        {showLiveMarker && (
          <Marker lat={issPosition.lat} lng={issPosition.lng} radius={ISS_RADIUS - 0.02} color="#38bdf8" size={0.03} />
        )}
        <OrbitControls enablePan={false} minDistance={2} maxDistance={6} />
      </Canvas>
      <div className="globe-panel__label">
        Vista 3D
        <span className="globe-panel__status">
          {activePosition ? `${formatCoord(activePosition.lat)}, ${formatCoord(activePosition.lng)}` : 'Localizando ISS...'}
        </span>
        {simulationPath && <span className="globe-panel__badge">{isSimPlaying ? 'Simulando' : 'Sim listo'}</span>}
      </div>
      <div className="globe-panel__legend">
        {simulationPath && (
          <>
            <span className="legend-dot legend-dot--sim" />
            Trayectoria simulada
          </>
        )}
        {showLiveMarker && (
          <>
            <span className="legend-dot legend-dot--live" />
            Posición en vivo
          </>
        )}
        <span className="legend-dot legend-dot--iss" />
        ISS simulada
        {targetPoint && (
          <>
            <span className="legend-dot legend-dot--target" />
            Objetivo
          </>
        )}
      </div>
    </div>
  );
}
