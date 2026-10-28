import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';

const LAYER_TYPES = [
  { key: 'kingdom', label: 'Kingdoms', icon: '<path d="M4 21V10l3-3 3 3v11M12 21V6l3-3 3 3v15M4 10h6M12 6h8"/>' },
  { key: 'castle', label: 'Castles', icon: '<path d="M4 21V11l3-2v3l3-2v3l3-2v3l3-2v9Z"/><path d="M4 21h16"/>' },
  { key: 'ruins', label: 'Ruins', icon: '<path d="M3 21h18M6 21V9l6-5 6 5v12" stroke-dasharray="2 2"/>' },
  { key: 'settlement', label: 'Settlements', icon: '<path d="M12 21V9M8 13l4-4 4 4M9 17l3-3 3 3"/>' },
  { key: 'water', label: 'Water', icon: '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11Z"/>' },
  { key: 'place', label: 'Places', icon: '<path d="M12 21s-7-5.5-7-11a7 7 0 0 1 14 0c0 5.5-7 11-7 11Z"/><circle cx="12" cy="10" r="2.5"/>' },
];

// camera: distance range and tilt (angle from straight down) at each end of it;
// the far end is fitted to the viewport so narrow screens can see all continents
const MIN_DIST = 1.2;
let maxDist = 15;
const TILT_FAR = 0.3;
const TILT_NEAR = 1.0;
const SEA_COLOR = '#0f1c29';
const WATER_COLOR = '#14263a';
const FOG_COLOR = '#04070b';

const hiddenTypes = new Set();
const markers = []; // { loc, el, world: Vector3 }
let locationsIndex = [];
let openPopup = null; // marker entry
let heightmap = null; // { size, worldSize, heights: Float32Array (already scaled) }
let tween = null;

let renderer;
let scene;
let camera;
let controls;

function iconSvg(inner, size = 14) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${inner}</svg>`;
}

// ---------- coordinates ----------

// data uses image coordinates (0,0 = top-left, y grows downward) in MAP_CONFIG units;
// the terrain spans [-worldSize/2, worldSize/2] on x and z, with z growing "down" the image.
function toWorldXZ(x, y) {
  const ws = heightmap.worldSize;
  return [(x / MAP_CONFIG.width - 0.5) * ws, (y / MAP_CONFIG.height - 0.5) * ws];
}

function toMapXY(wx, wz) {
  const ws = heightmap.worldSize;
  return [(wx / ws + 0.5) * MAP_CONFIG.width, (wz / ws + 0.5) * MAP_CONFIG.height];
}

function rawHeight(ix, iz) {
  return heightmap.heights[iz * heightmap.size + ix];
}

function heightAt(wx, wz) {
  const { size, worldSize } = heightmap;
  const fx = THREE.MathUtils.clamp((wx / worldSize + 0.5) * (size - 1), 0, size - 1);
  const fz = THREE.MathUtils.clamp((wz / worldSize + 0.5) * (size - 1), 0, size - 1);
  const x0 = Math.floor(fx);
  const z0 = Math.floor(fz);
  const x1 = Math.min(x0 + 1, size - 1);
  const z1 = Math.min(z0 + 1, size - 1);
  const tx = fx - x0;
  const tz = fz - z0;
  const top = rawHeight(x0, z0) * (1 - tx) + rawHeight(x1, z0) * tx;
  const bottom = rawHeight(x0, z1) * (1 - tx) + rawHeight(x1, z1) * tx;
  return top * (1 - tz) + bottom * tz;
}

// ---------- scene ----------

async function loadHeightmap() {
  const [meta, buf] = await Promise.all([
    fetch(MAP_CONFIG.heightmapMeta).then((r) => r.json()),
    fetch(MAP_CONFIG.heightmap).then((r) => r.arrayBuffer()),
  ]);
  const data = new Uint16Array(buf);
  const n = meta.size;
  const range = meta.maxHeight - meta.minHeight;

  // upsample 2× and smooth, so the coastlines don't show the source grid as stair steps
  const size = n * 2 - 1;
  let heights = new Float32Array(size * size);
  for (let z = 0; z < size; z++) {
    for (let x = 0; x < size; x++) {
      const x0 = x >> 1;
      const z0 = z >> 1;
      const x1 = Math.min(x0 + (x & 1), n - 1);
      const z1 = Math.min(z0 + (z & 1), n - 1);
      const avg = (data[z0 * n + x0] + data[z0 * n + x1] + data[z1 * n + x0] + data[z1 * n + x1]) / 4;
      heights[z * size + x] = (meta.minHeight + (avg / 65535) * range) * MAP_CONFIG.heightScale;
    }
  }
  for (let pass = 0; pass < 2; pass++) {
    const out = new Float32Array(heights.length);
    for (let z = 0; z < size; z++) {
      for (let x = 0; x < size; x++) {
        let sum = 0;
        let count = 0;
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            const zz = z + dz;
            if (xx < 0 || zz < 0 || xx >= size || zz >= size) continue;
            sum += heights[zz * size + xx];
            count++;
          }
        }
        out[z * size + x] = sum / count;
      }
    }
    heights = out;
  }

  heightmap = { size, worldSize: meta.worldSize, heights };
}


async function loadTexture() {
  // the SVG is rasterized here instead of shipping a baked PNG, so it stays the single source
  const img = new Image();
  img.src = MAP_CONFIG.src;
  await img.decode();

  const size = Math.min(4096, renderer.capabilities.maxTextureSize);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  // the SVG sea is transparent: paint a sea floor under it
  ctx.fillStyle = SEA_COLOR;
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(img, 0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return texture;
}

function buildTerrain(texture) {
  const { size, worldSize } = heightmap;
  // PlaneGeometry rows run from z = -ws/2 after the rotation, matching the heightmap row order
  const geometry = new THREE.PlaneGeometry(worldSize, worldSize, size - 1, size - 1);
  geometry.rotateX(-Math.PI / 2);
  const pos = geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, rawHeight(i % size, Math.floor(i / size)));
  }
  geometry.computeVertexNormals();

  // radial alpha fade, so the square edges of the map dissolve into the page background;
  // it starts outside the outermost land
  const fadeCanvas = document.createElement('canvas');
  fadeCanvas.width = 512;
  fadeCanvas.height = 512;
  const fctx = fadeCanvas.getContext('2d');
  const fadeGradient = fctx.createRadialGradient(256, 256, 512 * 0.42, 256, 256, 512 * 0.5);
  fadeGradient.addColorStop(0, '#fff');
  fadeGradient.addColorStop(1, '#000');
  fctx.fillStyle = fadeGradient;
  fctx.fillRect(0, 0, 512, 512);
  const fade = new THREE.CanvasTexture(fadeCanvas);

  const terrain = new THREE.Mesh(
    geometry,
    new THREE.MeshLambertMaterial({ map: texture, alphaMap: fade, transparent: true }),
  );
  scene.add(terrain);

  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(worldSize, worldSize).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({
      color: WATER_COLOR,
      alphaMap: fade,
      transparent: true,
      opacity: 0.8,
      roughness: 0.4,
      metalness: 0.15,
      depthWrite: false,
    }),
  );
  water.position.y = 0.001;
  water.renderOrder = 1;
  scene.add(water);
}

function tiltFor(dist) {
  const t = THREE.MathUtils.clamp((maxDist - dist) / (maxDist - MIN_DIST), 0, 1);
  return THREE.MathUtils.lerp(TILT_FAR, TILT_NEAR, t * t * (3 - 2 * t));
}

function initScene() {
  const container = document.getElementById('map');
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.fog = new THREE.Fog(FOG_COLOR, 10, 30);

  camera = new THREE.PerspectiveCamera(40, container.clientWidth / container.clientHeight, 0.05, 100);

  scene.add(new THREE.AmbientLight('#fff8ec', 1.05));
  const sun = new THREE.DirectionalLight('#fff4e0', 0.6);
  sun.position.set(-4, 6, -3);
  scene.add(sun);

  controls = new MapControls(camera, renderer.domElement);
  controls.enableRotate = false;
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.minDistance = MIN_DIST;
  controls.zoomToCursor = true;

  const startDist = fitDistance();
  maxDist = startDist * 1.15;
  controls.maxDistance = maxDist;
  const tilt = tiltFor(startDist);
  camera.position.set(0, Math.cos(tilt) * startDist, Math.sin(tilt) * startDist);
  controls.target.set(0, 0, 0);
  controls.update();

  window.addEventListener('resize', () => {
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
    maxDist = fitDistance() * 1.15;
    controls.maxDistance = maxDist;
  });

  // a click (not a drag) on empty map closes the card
  let down = null;
  renderer.domElement.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) < 5) closePopup();
    down = null;
  });
}

// distance at which the land (roughly 8.2 × 8.4 world units, plus room for the icon rail)
// fits the viewport
function fitDistance() {
  const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  return Math.max(4.2 / tanHalf, 4.8 / (tanHalf * camera.aspect));
}

function cameraDistance() {
  return camera.position.distanceTo(controls.target);
}

// keep the camera at the zoom-dependent tilt, looking north, with the target on the map
function constrainCamera() {
  const half = heightmap.worldSize / 2;
  const t = controls.target;
  const clampedX = THREE.MathUtils.clamp(t.x, -half, half);
  const clampedZ = THREE.MathUtils.clamp(t.z, -half, half);
  t.set(clampedX, 0, clampedZ);

  const dist = cameraDistance();
  const tilt = tiltFor(dist);
  camera.position.set(t.x, Math.cos(tilt) * dist, t.z + Math.sin(tilt) * dist);
  camera.lookAt(t);

  scene.fog.near = dist * 1.1;
  scene.fog.far = dist * 2.6;
}

function flyTo(wx, wz, dist, duration = 700) {
  tween = {
    fromTarget: controls.target.clone(),
    toTarget: new THREE.Vector3(wx, 0, wz),
    fromDist: cameraDistance(),
    toDist: THREE.MathUtils.clamp(dist, MIN_DIST, maxDist),
    start: performance.now(),
    duration,
  };
}

function stepTween(now) {
  if (!tween) return;
  const k = Math.min((now - tween.start) / tween.duration, 1);
  const e = 1 - Math.pow(1 - k, 3);
  controls.target.lerpVectors(tween.fromTarget, tween.toTarget, e);
  const dist = THREE.MathUtils.lerp(tween.fromDist, tween.toDist, e);
  const dir = camera.position.clone().sub(controls.target).normalize();
  camera.position.copy(controls.target).addScaledVector(dir, dist);
  if (k === 1) tween = null;
}

// ---------- markers & popup ----------

function popupHtml(loc) {
  const typeLabel = (LAYER_TYPES.find((t) => t.key === loc.type) || {}).label || loc.type;
  const meta = [];
  if (loc.region) meta.push(`<div><b>Region:</b> ${loc.region}</div>`);
  if (loc.era) meta.push(`<div><b>Era:</b> ${loc.era}</div>`);
  return `
    <div class="loc-card">
      <span class="badge">${typeLabel}</span>
      <h3>${loc.name}</h3>
      <p>${loc.description || ''}</p>
      ${meta.length ? `<p style="margin-top:8px;">${meta.join(' ')}</p>` : ''}
    </div>
  `;
}

function markerHtml(loc, typeIcon) {
  return `
    <div class="marker-wrap">
      <div class="marker-badge">${iconSvg(typeIcon || '', 16)}</div>
      <div class="marker-label">${loc.name}</div>
    </div>
  `;
}

function showPopup(entry) {
  openPopup = entry;
  const popup = document.getElementById('loc-popup');
  popup.querySelector('.loc-popup-body').innerHTML = popupHtml(entry.loc);
  popup.hidden = false;
}

function closePopup() {
  openPopup = null;
  document.getElementById('loc-popup').hidden = true;
}

function renderLocations(locations) {
  locationsIndex = locations;
  const container = document.getElementById('markers');
  locations.forEach((loc) => {
    const type = LAYER_TYPES.find((t) => t.key === loc.type);
    const el = document.createElement('div');
    el.className = 'marker';
    el.innerHTML = markerHtml(loc, type && type.icon);
    const [wx, wz] = toWorldXZ(loc.x, loc.y);
    const entry = { loc, el, world: new THREE.Vector3(wx, Math.max(heightAt(wx, wz), 0), wz) };
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      showPopup(entry);
    });
    container.appendChild(el);
    markers.push(entry);
  });
}

const projected = new THREE.Vector3();

function updateOverlays() {
  const w = renderer.domElement.clientWidth;
  const h = renderer.domElement.clientHeight;

  markers.forEach((m) => {
    projected.copy(m.world).project(camera);
    const visible = !hiddenTypes.has(m.loc.type) && projected.z < 1;
    m.el.style.display = visible ? '' : 'none';
    if (!visible) return;
    const x = (projected.x + 1) / 2 * w;
    const y = (1 - projected.y) / 2 * h;
    m.el.style.transform = `translate(${x - 65}px, ${y - 19}px)`;
    m.el.style.zIndex = String(Math.round((1 - projected.z) * 1e6));
  });

  if (openPopup) {
    const popup = document.getElementById('loc-popup');
    if (hiddenTypes.has(openPopup.loc.type)) {
      closePopup();
      return;
    }
    projected.copy(openPopup.world).project(camera);
    const x = (projected.x + 1) / 2 * w;
    const y = (1 - projected.y) / 2 * h;
    const pw = popup.offsetWidth;
    const ph = popup.offsetHeight;
    const left = THREE.MathUtils.clamp(x - pw / 2, 8, Math.max(8, w - pw - 8));
    const top = Math.max(8, y - 28 - ph);
    popup.style.transform = `translate(${left}px, ${top}px)`;
  }
}

function updateStatusBar() {
  const [x, y] = toMapXY(controls.target.x, controls.target.z);
  document.getElementById('status-coords').textContent = `${Math.round(x)}, ${Math.round(y)}`;
  document.getElementById('status-zoom').textContent = `Z${Math.log2(maxDist / cameraDistance()).toFixed(1)}`;
}

function animate(now) {
  stepTween(now);
  controls.update();
  constrainCamera();
  renderer.render(scene, camera);
  updateOverlays();
  updateStatusBar();
  requestAnimationFrame(animate);
}

// ---------- UI ----------

function buildLayerRows() {
  const rows = document.getElementById('layer-rows');
  LAYER_TYPES.forEach((t) => {
    const row = document.createElement('div');
    row.className = 'layer-row active';
    row.dataset.key = t.key;
    row.innerHTML = `
      <div class="swatch">${iconSvg(t.icon, 12)}</div>
      <span class="label">${t.label}</span>
    `;
    row.addEventListener('click', () => {
      const active = row.classList.toggle('active');
      if (active) hiddenTypes.delete(t.key);
      else hiddenTypes.add(t.key);
    });
    rows.appendChild(row);
  });
}

function setPanel(panel) {
  document.getElementById('search-overlay').classList.toggle('open', panel === 'search');
  document.getElementById('layers-panel').classList.toggle('open', panel === 'layers');
  document.getElementById('btn-search').classList.toggle('active', panel === 'search');
  document.getElementById('btn-layers').classList.toggle('active', panel === 'layers');
  if (panel === 'search') document.getElementById('search-input').focus();
}

function initSearch() {
  const input = document.getElementById('search-input');
  const results = document.getElementById('search-results');

  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    results.innerHTML = '';
    if (!q) return;
    const matches = locationsIndex.filter((l) => l.name.toLowerCase().includes(q)).slice(0, 8);
    matches.forEach((loc) => {
      const typeLabel = (LAYER_TYPES.find((t) => t.key === loc.type) || {}).label || loc.type;
      const item = document.createElement('div');
      item.className = 'search-result-item';
      item.innerHTML = `${loc.name}<span class="type">${typeLabel}</span>`;
      item.addEventListener('click', () => {
        if (hiddenTypes.has(loc.type)) {
          hiddenTypes.delete(loc.type);
          const row = document.querySelector(`.layer-row[data-key="${loc.type}"]`);
          if (row) row.classList.add('active');
        }
        const entry = markers.find((m) => m.loc.id === loc.id);
        flyTo(entry.world.x, entry.world.z, Math.min(cameraDistance(), 4));
        showPopup(entry);
        results.innerHTML = '';
        input.value = '';
        setPanel(null);
      });
      results.appendChild(item);
    });
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-overlay') && !e.target.closest('#btn-search')) {
      results.innerHTML = '';
    }
  });
}

function initSplash() {
  document.getElementById('btn-begin').addEventListener('click', () => {
    document.getElementById('splash').classList.add('hidden');
  });
}

function initControls() {
  const zoomBy = (factor) => flyTo(controls.target.x, controls.target.z, cameraDistance() * factor, 300);
  document.getElementById('zoom-in').addEventListener('click', () => zoomBy(0.6));
  document.getElementById('zoom-out').addEventListener('click', () => zoomBy(1 / 0.6));

  document.getElementById('btn-search').addEventListener('click', () => {
    const isOpen = document.getElementById('search-overlay').classList.contains('open');
    setPanel(isOpen ? null : 'search');
  });
  document.getElementById('btn-layers').addEventListener('click', () => {
    const isOpen = document.getElementById('layers-panel').classList.contains('open');
    setPanel(isOpen ? null : 'layers');
  });
  document.getElementById('btn-fullscreen').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen();
  });
  document.querySelector('.loc-popup-close').addEventListener('click', closePopup);

  setPanel('layers');
}

async function main() {
  buildLayerRows();
  initSplash();
  initControls();
  initSearch();
  initScene();

  try {
    await loadHeightmap();
    buildTerrain(await loadTexture());
  } catch (err) {
    console.error(err);
    document.getElementById('map-placeholder').hidden = false;
    return;
  }

  const locations = await fetch('data/locations.json')
    .then((res) => res.json())
    .catch(() => []);
  renderLocations(locations);
  requestAnimationFrame(animate);
}

main();
