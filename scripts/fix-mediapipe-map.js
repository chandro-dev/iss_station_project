const fs = require('fs');
const path = require('path');

const mapPath = path.join(
  __dirname,
  '..',
  'node_modules',
  '@mediapipe',
  'tasks-vision',
  'vision_bundle_mjs.js.map'
);

const mapDir = path.dirname(mapPath);
const stubMap = {
  version: 3,
  file: 'vision_bundle.mjs',
  sources: [],
  names: [],
  mappings: '',
};

try {
  if (!fs.existsSync(mapDir)) {
    console.warn('[fix-mediapipe-map] tasks-vision directory no encontrado, se omite el parche.');
    process.exit(0);
  }

  if (!fs.existsSync(mapPath)) {
    fs.writeFileSync(mapPath, `${JSON.stringify(stubMap, null, 2)}\n`, 'utf8');
    console.log('[fix-mediapipe-map] Mapa stub creado para vision_bundle_mjs.js');
  }
} catch (error) {
  console.warn('[fix-mediapipe-map] No se pudo generar el source map:', error.message);
}
