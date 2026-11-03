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

async function loadMapImage() {
  // the SVG is rasterized in the browser instead of shipping baked PNGs, so it stays the single source
  const img = new Image();
  img.src = MAP_CONFIG.src;
  await img.decode();
  return img;
}

function drawMap(img, size, filter = 'none', background = null) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, size, size);
  }
  ctx.filter = filter;
  ctx.drawImage(img, 0, 0, size, size);
  return canvas;
}

async function loadHeightmap(img) {
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

  // the sculpt dips below the sea where the texture paints land (the basin in the east is open
  // to the ocean through narrow channels, so it can't be told apart by flood fill): squeeze
  // those heights into a thin band above the water, keeping their relative shape
  const mask = drawMap(img, size).getContext('2d').getImageData(0, 0, size, size).data;
  const sea = MAP_CONFIG.seaLevel * MAP_CONFIG.heightScale;
  const floor = meta.minHeight * MAP_CONFIG.heightScale;
  const band = 0.02 * MAP_CONFIG.heightScale;
  for (let i = 0; i < heights.length; i++) {
    if (mask[i * 4 + 3] < 128 || heights[i] >= sea + band) continue;
    heights[i] = sea + band * (0.25 + 0.75 * (heights[i] - floor) / (sea + band - floor));
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


function loadTextures(img) {
  const toTexture = (canvas) => {
    const texture = new THREE.CanvasTexture(canvas);
    // the shader works on raw sRGB values
    texture.colorSpace = THREE.NoColorSpace;
    texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return texture;
  };
  const size = Math.min(4096, renderer.capabilities.maxTextureSize);
  return {
    // only the regional colour of the painted map is kept, the relief comes from the mesh;
    // land the SVG doesn't cover gets a neutral lowland colour
    biome: toTexture(drawMap(img, 1024, 'blur(12px)', '#8a8b5c')),
    detail: toTexture(drawMap(img, size)),
    // land silhouette spread outwards: its alpha tells how close the sea is to a coast
    coast: toTexture(drawMap(img, 512, 'blur(14px)')),
  };
}

// radial alpha fade, so the square edges of the map dissolve into the page background;
// it starts outside the outermost land
function radialFade() {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(256, 256, 512 * 0.42, 256, 256, 512 * 0.5);
  gradient.addColorStop(0, '#fff');
  gradient.addColorStop(1, '#000');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 512, 512);
  return new THREE.CanvasTexture(canvas);
}

const TERRAIN_VERTEX = /* glsl */ `
  #include <fog_pars_vertex>
  varying vec3 vPos;
  varying vec3 vNormal;
  varying vec2 vUv;
  void main() {
    vPos = position;
    vNormal = normal;
    vUv = uv;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

// Stylized painted-map look: colour comes from height, slope and the blurred SVG (regional
// tint), lit with exaggerated relief, warm light and cool shadows. Works in sRGB throughout.
const TERRAIN_FRAGMENT = /* glsl */ `
  #include <fog_pars_fragment>
  uniform sampler2D uBiome;
  uniform sampler2D uDetail;
  uniform sampler2D uCoast;
  uniform float uSea;
  uniform float uPeak;
  uniform float uRelief;
  uniform vec3 uSun;
  varying vec3 vPos;
  varying vec3 vNormal;
  varying vec2 vUv;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 5; i++) {
      v += a * noise(p);
      p = p * 2.03 + 17.1;
      a *= 0.5;
    }
    return v;
  }

  const vec3 FOREST = vec3(0.24, 0.33, 0.17);
  const vec3 SAND = vec3(0.80, 0.72, 0.54);
  const vec3 ROCK = vec3(0.47, 0.40, 0.34);
  const vec3 ROCK_DARK = vec3(0.27, 0.22, 0.19);
  const vec3 SNOW = vec3(0.91, 0.93, 0.95);
  const vec3 SHALLOW = vec3(0.23, 0.44, 0.47);
  const vec3 MID = vec3(0.10, 0.22, 0.29);
  const vec3 DEEP = vec3(0.04, 0.08, 0.13);
  const vec3 LAKE = vec3(0.22, 0.42, 0.50);

  void main() {
    vec2 p = vPos.xz;
    float h = vPos.y;
    vec3 n0 = normalize(vNormal);
    float slope = length(n0.xz) / max(n0.y, 0.05);

    // brush-scale wobble of the shading normal, stronger on rock
    float e = 0.01;
    float b0 = fbm(p * 9.0);
    vec2 brush = vec2(fbm((p + vec2(e, 0.0)) * 9.0) - b0, fbm((p + vec2(0.0, e)) * 9.0) - b0) / e;
    float rock = smoothstep(0.35, 0.9, slope + (b0 - 0.5) * 0.4);
    vec3 n = normalize(vec3(n0.x * uRelief, n0.y, n0.z * uRelief) + vec3(brush.x, 0.0, brush.y) * (0.015 + 0.05 * rock));

    float diff = dot(n, uSun);
    vec3 light = mix(vec3(0.38, 0.42, 0.58), vec3(1.10, 1.02, 0.88), smoothstep(-0.15, 0.85, diff));

    float above = h - uSea;
    vec3 col;
    if (above < 0.0) {
      // the sea floor is nearly flat, so depth is read from the distance to the coast instead
      float depth = -above;
      float nearCoast = texture2D(uCoast, vUv).a + (fbm(p * 3.0) - 0.5) * 0.15;
      col = mix(DEEP, MID, smoothstep(0.0, 0.35, nearCoast));
      col = mix(col, SHALLOW, 0.75 * smoothstep(0.4, 0.85, nearCoast) * smoothstep(0.03, 0.0, depth));
      col *= mix(vec3(0.75, 0.8, 0.9), vec3(1.05), smoothstep(-0.2, 0.9, diff));
      // surf along the coast
      float foam = smoothstep(0.006, 0.0, depth) * smoothstep(0.35, 0.65, fbm(p * 40.0));
      col = mix(col, vec3(0.62, 0.74, 0.74), foam * 0.6);
    } else {
      vec3 biome = texture2D(uBiome, vUv).rgb;
      // pull the painted tint towards a richer, slightly darker palette
      float grey = dot(biome, vec3(0.333));
      vec3 base = mix(vec3(grey), biome, 1.5);
      float variation = fbm(p * 14.0);
      base *= 0.82 + 0.36 * variation;
      // forest patches where the land is green
      float green = smoothstep(0.0, 0.06, biome.g - max(biome.r, biome.b) * 0.92);
      float forest = smoothstep(0.5, 0.62, fbm(p * 5.0 + 3.7)) * green * (1.0 - rock);
      base = mix(base, FOREST * (0.85 + 0.3 * variation), forest * 0.75);

      float beach = 1.0 - smoothstep(0.002, 0.008, above + (variation - 0.5) * 0.006);
      base = mix(base, SAND, beach * (1.0 - rock) * 0.8);

      float strata = fbm(p * 7.0 + h * 25.0);
      vec3 rockCol = mix(ROCK_DARK, ROCK, smoothstep(0.25, 0.75, strata));
      col = mix(base, rockCol, rock);

      float snow = smoothstep(uPeak * 0.4, uPeak * 0.6, h + (b0 - 0.5) * uPeak * 0.3) * (1.0 - rock * 0.5);
      col = mix(col, SNOW, snow);

      // lakes and rivers painted in the SVG
      vec4 detail = texture2D(uDetail, vUv);
      float lake = smoothstep(0.05, 0.14, detail.b - max(detail.r, detail.g)) * detail.a;
      col = mix(col, LAKE * (0.9 + 0.2 * variation), lake);

      col *= light;
      // ridges catch a little extra light
      col += vec3(1.0, 0.9, 0.75) * pow(max(diff, 0.0), 6.0) * 0.12 * smoothstep(0.2, 0.6, slope);
    }

    float fade = 1.0 - smoothstep(0.42, 0.5, length(vUv - 0.5));
    gl_FragColor = vec4(col, fade);
    #include <fog_fragment>
  }
`;

function terrainMaterial(textures) {
  const material = new THREE.ShaderMaterial({
    vertexShader: TERRAIN_VERTEX,
    fragmentShader: TERRAIN_FRAGMENT,
    transparent: true,
    fog: true,
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uBiome: { value: null },
        uDetail: { value: null },
        uCoast: { value: null },
        uSea: { value: MAP_CONFIG.seaLevel * MAP_CONFIG.heightScale },
        uPeak: { value: heightmap.heights.reduce((a, b) => Math.max(a, b)) },
        uRelief: { value: 3.0 },
        uSun: { value: new THREE.Vector3(-0.55, 0.7, -0.45).normalize() },
      },
    ]),
  });
  // set after the merge, which would clone the textures
  material.uniforms.uBiome.value = textures.biome;
  material.uniforms.uDetail.value = textures.detail;
  material.uniforms.uCoast.value = textures.coast;
  return material;
}

function buildTerrain(textures) {
  const { size, worldSize } = heightmap;
  // PlaneGeometry rows run from z = -ws/2 after the rotation, matching the heightmap row order
  const geometry = new THREE.PlaneGeometry(worldSize, worldSize, size - 1, size - 1);
  geometry.rotateX(-Math.PI / 2);
  const pos = geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, rawHeight(i % size, Math.floor(i / size)));
  }
  geometry.computeVertexNormals();

  const terrain = new THREE.Mesh(geometry, terrainMaterial(textures));
  scene.add(terrain);

  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(worldSize, worldSize).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({
      color: WATER_COLOR,
      alphaMap: radialFade(),
      transparent: true,
      // the terrain shader paints the shallows and the deep sea, the water only adds sheen
      opacity: 0.2,
      roughness: 0.4,
      metalness: 0.15,
      depthWrite: false,
    }),
  );
  water.position.y = MAP_CONFIG.seaLevel * MAP_CONFIG.heightScale + 0.001;
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
    const img = await loadMapImage();
    await loadHeightmap(img);
    buildTerrain(loadTextures(img));
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
