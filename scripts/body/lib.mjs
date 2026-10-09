// Shared helpers for the body-shaping regression tools (see README.md here).
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Strength at 100% per area (must match FULL in src/effects/body/field.ts; read from it). */
export async function loadField(file = "field") {
  const out = path.join(ROOT, `node_modules/.cache/body-tools/${file}.mjs`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const r = spawnSync(path.join(ROOT, "node_modules/.bin/rolldown"), [path.join(ROOT, `src/effects/body/${file}.ts`), "--platform", "node", "--format", "esm", "-o", out, "--log-level", "warn"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`bundling ${file}.ts failed:\n${r.stderr}${r.stdout}`);
  return import(`${pathToFileURL(out).href}?t=${Date.now()}`);
}

/** Command-line options: --name value, --flag. */
export function options(argv = process.argv.slice(2)) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) o[a.slice(2)] = true;
      else o[a.slice(2)] = argv[++i];
    } else o._.push(a);
  }
  return o;
}

/** Photo files from arguments that are files or folders. */
export function photoList(items) {
  const exts = /\.(jpe?g|png|webp)$/i;
  return items.flatMap((p) => (fs.statSync(p).isDirectory() ? fs.readdirSync(p).filter((f) => exts.test(f)).sort().map((f) => path.join(p, f)) : [p]));
}

export const nameOf = (file) => path.basename(file).replace(/\.\w+$/, "");

// ---------------------------------------------------------------- dumps

const TYPES = { f32: Float32Array, u8: Uint8Array, u8c: Uint8ClampedArray };

/** Write one photo's dump: meta.json and one binary file per array. */
export function writeDump(dir, meta, arrays) {
  fs.mkdirSync(dir, { recursive: true });
  const files = {};
  for (const [k, a] of Object.entries(arrays)) {
    const t = a instanceof Float32Array ? "f32" : a instanceof Uint8ClampedArray ? "u8c" : "u8";
    fs.writeFileSync(path.join(dir, `${k}.${t}`), Buffer.from(a.buffer, a.byteOffset, a.byteLength));
    files[k] = t;
  }
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ ...meta, files }, null, 1));
}

/** Read one photo's dump back: { meta, ...arrays }. */
export function readDump(dir) {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
  const out = { meta };
  for (const [k, t] of Object.entries(meta.files)) {
    const b = fs.readFileSync(path.join(dir, `${k}.${t}`));
    const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    out[k] = new TYPES[t](ab);
  }
  return out;
}

/** Dump folders under `root` (one per photo). */
export const dumpsIn = (root) =>
  fs.existsSync(root) ? fs.readdirSync(root).filter((d) => fs.existsSync(path.join(root, d, "meta.json"))).sort() : [];

// ---------------------------------------------------------------- the warp, like the GPU shader (no backdrop)

/**
 * Apply fields (unit fields at w x h, interleaved dx dy) with strengths `k` to an RGB image (W x H x 3):
 * every output pixel reads the image at p + movement(p), mirrored back inside at the edges.
 */
export function warpRGB(img, W, H, fields, k, w, h) {
  const out = Buffer.alloc(W * H * 3);
  const kx = W / w, ky = H / h;
  const mirror = (v, n) => (v < 0 ? -v : v > n - 1 ? 2 * (n - 1) - v : v);
  for (let y = 0; y < H; y++) {
    const fy = Math.min(Math.max((y + 0.5) / ky - 0.5, 0), h - 1);
    const y0 = Math.floor(fy), y1 = Math.min(y0 + 1, h - 1), ty = fy - y0;
    for (let x = 0; x < W; x++) {
      const fx = Math.min(Math.max((x + 0.5) / kx - 0.5, 0), w - 1);
      const x0 = Math.floor(fx), x1 = Math.min(x0 + 1, w - 1), tx = fx - x0;
      let dx = 0, dy = 0;
      for (let j = 0; j < fields.length; j++) {
        const f = fields[j], s = k[j];
        if (!s) continue;
        const a = (y0 * w + x0) * 2, b = (y0 * w + x1) * 2, c = (y1 * w + x0) * 2, d = (y1 * w + x1) * 2;
        dx += s * ((f[a] + (f[b] - f[a]) * tx) * (1 - ty) + (f[c] + (f[d] - f[c]) * tx) * ty);
        dy += s * ((f[a + 1] + (f[b + 1] - f[a + 1]) * tx) * (1 - ty) + (f[c + 1] + (f[d + 1] - f[c + 1]) * tx) * ty);
      }
      const sx = Math.min(Math.max(mirror(x + dx * kx, W), 0), W - 1);
      const sy = Math.min(Math.max(mirror(y + dy * ky, H), 0), H - 1);
      const X0 = Math.floor(sx), Y0 = Math.floor(sy), X1 = Math.min(X0 + 1, W - 1), Y1 = Math.min(Y0 + 1, H - 1);
      const u = sx - X0, v = sy - Y0, o = (y * W + x) * 3;
      for (let c = 0; c < 3; c++) {
        const p = img[(Y0 * W + X0) * 3 + c], q = img[(Y0 * W + X1) * 3 + c];
        const r = img[(Y1 * W + X0) * 3 + c], t = img[(Y1 * W + X1) * 3 + c];
        out[o + c] = (p + (q - p) * u) * (1 - v) + (r + (t - r) * u) * v;
      }
    }
  }
  return out;
}
