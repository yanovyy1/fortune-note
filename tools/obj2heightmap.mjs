// Bakes a terrain OBJ (any mesh, looked at from above: x/z footprint, y up) into
// assets/map/heightmap.bin (Uint16 LE, N×N, x fastest, then z) + assets/map/heightmap.json (meta).
// Every grid point takes the height of the topmost face above it.
//
//   node tools/obj2heightmap.mjs path/to/terrain.obj [size=512]
import fs from 'node:fs';
import path from 'node:path';

const src = process.argv[2];
const size = Number(process.argv[3] ?? 512);
if (!src || !Number.isInteger(size) || size < 2) {
  console.error('usage: node tools/obj2heightmap.mjs <file.obj> [size]');
  process.exit(1);
}

const verts = [];
const faces = [];
for (const line of fs.readFileSync(src, 'utf8').split('\n')) {
  if (line.startsWith('v ')) {
    const [, x, y, z] = line.trim().split(/\s+/).map(Number);
    verts.push(x, y, z);
  } else if (line.startsWith('f ')) {
    const idx = line.trim().split(/\s+/).slice(1).map((s) => {
      const i = parseInt(s, 10);
      return i < 0 ? verts.length / 3 + i : i - 1;
    });
    // fan-triangulate quads and n-gons
    for (let k = 1; k + 1 < idx.length; k++) faces.push(idx[0], idx[k], idx[k + 1]);
  }
}

let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
let min = Infinity, max = -Infinity;
for (let i = 0; i < verts.length; i += 3) {
  minX = Math.min(minX, verts[i]);
  maxX = Math.max(maxX, verts[i]);
  min = Math.min(min, verts[i + 1]);
  max = Math.max(max, verts[i + 1]);
  minZ = Math.min(minZ, verts[i + 2]);
  maxZ = Math.max(maxZ, verts[i + 2]);
}
const worldSize = Math.max(maxX - minX, maxZ - minZ);
const step = worldSize / (size - 1);
const toGrid = (v, lo) => (v - lo) / step;

const grid = new Float32Array(size * size).fill(-Infinity);
for (let f = 0; f < faces.length; f += 3) {
  const a = faces[f] * 3, b = faces[f + 1] * 3, c = faces[f + 2] * 3;
  const ax = toGrid(verts[a], minX), az = toGrid(verts[a + 2], minZ), ay = verts[a + 1];
  const bx = toGrid(verts[b], minX), bz = toGrid(verts[b + 2], minZ), by = verts[b + 1];
  const cx = toGrid(verts[c], minX), cz = toGrid(verts[c + 2], minZ), cy = verts[c + 1];
  const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
  if (Math.abs(det) < 1e-12) continue; // vertical or degenerate in plan view
  const x0 = Math.max(0, Math.ceil(Math.min(ax, bx, cx)));
  const x1 = Math.min(size - 1, Math.floor(Math.max(ax, bx, cx)));
  const z0 = Math.max(0, Math.ceil(Math.min(az, bz, cz)));
  const z1 = Math.min(size - 1, Math.floor(Math.max(az, bz, cz)));
  for (let z = z0; z <= z1; z++) {
    for (let x = x0; x <= x1; x++) {
      const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / det;
      const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / det;
      const l3 = 1 - l1 - l2;
      if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
      const y = l1 * ay + l2 * by + l3 * cy;
      const i = z * size + x;
      if (y > grid[i]) grid[i] = y;
    }
  }
}

// grid points no face covered (mesh holes, ragged edges) take the lowest height
let holes = 0;
const heights = new Uint16Array(size * size);
for (let i = 0; i < grid.length; i++) {
  if (grid[i] === -Infinity) holes++;
  const y = grid[i] === -Infinity ? min : grid[i];
  heights[i] = Math.round(((y - min) / (max - min)) * 65535);
}

const outDir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'assets', 'map');
fs.writeFileSync(path.join(outDir, 'heightmap.bin'), Buffer.from(heights.buffer));
const meta = {
  size,
  worldSize: +worldSize.toFixed(4),
  minHeight: min,
  maxHeight: max,
};
fs.writeFileSync(path.join(outDir, 'heightmap.json'), JSON.stringify(meta, null, 2) + '\n');
console.log('wrote heightmap', meta, `${holes} uncovered points`);
