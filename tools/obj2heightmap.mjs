// Converts a grid heightmap OBJ (N×N vertices, x fastest, then z) into
// assets/map/heightmap.bin (Uint16 LE, N×N) + assets/map/heightmap.json (meta).
//
//   node tools/obj2heightmap.mjs path/to/continents.obj
import fs from 'node:fs';
import path from 'node:path';

const src = process.argv[2];
if (!src) {
  console.error('usage: node tools/obj2heightmap.mjs <file.obj>');
  process.exit(1);
}

const xs = [];
const ys = [];
const zs = [];
for (const line of fs.readFileSync(src, 'utf8').split('\n')) {
  if (!line.startsWith('v ')) continue;
  const [, x, y, z] = line.trim().split(/\s+/).map(Number);
  xs.push(x);
  ys.push(y);
  zs.push(z);
}

const size = Math.round(Math.sqrt(ys.length));
if (size * size !== ys.length) throw new Error(`not a square grid: ${ys.length} vertices`);
if (!(xs[1] > xs[0]) || !(zs[size] > zs[0])) throw new Error('unexpected vertex order (need x fastest, then z)');

let min = Infinity;
let max = -Infinity;
for (const y of ys) {
  if (y < min) min = y;
  if (y > max) max = y;
}

const heights = new Uint16Array(size * size);
for (let i = 0; i < ys.length; i++) heights[i] = Math.round(((ys[i] - min) / (max - min)) * 65535);

const outDir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'assets', 'map');
fs.writeFileSync(path.join(outDir, 'heightmap.bin'), Buffer.from(heights.buffer));
const meta = {
  size,
  worldSize: +(xs[size - 1] - xs[0]).toFixed(4),
  minHeight: min,
  maxHeight: max,
};
fs.writeFileSync(path.join(outDir, 'heightmap.json'), JSON.stringify(meta, null, 2) + '\n');
console.log('wrote heightmap', meta);
