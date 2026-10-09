// Before / after sheets to look at: each photo next to its result from one or more runs.
//
//   node scripts/body/sheets.mjs --out <folder> [--crop full|body|arms] [--at 100] [--only a,b] <run folder>[=label]...
//
// The first run's dumps give the body points used for the crops. Sheets are 2400 px wide JPEGs.
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { dumpsIn, options, readDump } from "./lib.mjs";

const o = options();
if (!o.out || !o._.length) {
  console.error("usage: node scripts/body/sheets.mjs --out <folder> [--crop full|body|arms] [--at 100] [--only a,b] <run folder>[=label]...");
  process.exit(2);
}
const runs = o._.map((r) => {
  const [dir, label] = r.split("=");
  return { dir, label: label ?? path.basename(path.resolve(dir)) };
});
const crop = o.crop ?? "body", at = o.at ?? "100";
const only = o.only ? new Set(String(o.only).split(",")) : null;
const names = dumpsIn(path.join(runs[0].dir, "dump")).filter((n) => !only || only.has(n));
fs.mkdirSync(o.out, { recursive: true });

const SHEET_W = 2400, TILE_H = crop === "full" ? 620 : 520, LABEL_H = 26, GAP = 8;
const esc = (s) => s.replace(/[<&>]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]);
const label = (text, width) =>
  Buffer.from(`<svg width="${width}" height="${LABEL_H}"><rect width="100%" height="100%" fill="white"/><text x="6" y="18" font-family="DejaVu Sans, Arial" font-size="15" font-weight="bold" fill="#222">${esc(text)}</text></svg>`);

async function tile(name) {
  const d = readDump(path.join(runs[0].dir, "dump", name));
  const photo = d.meta.photo;
  const { info } = await sharp(photo).rotate().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  const J = d.joints, s = W / d.meta.w;
  const jx = (i) => J[i * 3] * s, jy = (i) => J[i * 3 + 1] * s;
  const sw = Math.max(10, Math.hypot(jx(2) - jx(5), jy(2) - jy(5)));
  let box = [0, 0, W, H];
  const pts = (ids) => ids.filter((i) => J[i * 3 + 2] > 0.3);
  if (crop !== "full") {
    const ids = pts(crop === "arms" ? [2, 3, 4, 5, 6, 7, 8, 11] : [0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    const xs = ids.map(jx), ys = ids.map(jy);
    const m = crop === "arms" ? 0.45 * sw : 0.6 * sw;
    box = [Math.min(...xs) - m, Math.min(...ys) - (crop === "arms" ? 0.3 : 0.9) * sw, Math.max(...xs) + m, Math.max(...ys) + 0.4 * sw];
    box = [Math.max(0, box[0]), Math.max(0, box[1]), Math.min(W, box[2]), Math.min(H, box[3])].map(Math.round);
  }
  if (!box.every(Number.isFinite) || box[2] - box[0] < 8 || box[3] - box[1] < 8) box = [0, 0, W, H];
  const [x0, y0] = [Math.min(box[0], W - 8), Math.min(box[1], H - 8)];
  const cw = Math.min(W - x0, Math.max(8, box[2] - x0)), ch = Math.min(H - y0, Math.max(8, box[3] - y0));
  const tw = Math.max(1, Math.round((cw * TILE_H) / ch));
  const sources = [{ file: photo, label: `Before · ${name}` }, ...runs.map((r) => ({ file: path.join(r.dir, "app", `${name}-${at}.jpg`), label: r.label }))];
  const parts = [];
  for (const [j, src] of sources.entries()) {
    if (!fs.existsSync(src.file)) continue;
    // (one resize per sharp pipeline: first to the photo's size, then crop and scale the tile)
    const full = await sharp(src.file).rotate().resize(W, H, { fit: "fill" }).toBuffer();
    const img = await sharp(full).extract({ left: x0, top: y0, width: cw, height: ch }).resize(tw, TILE_H).toBuffer();
    parts.push({ input: label(src.label, tw), left: j * (tw + 4), top: 0 }, { input: img, left: j * (tw + 4), top: LABEL_H });
  }
  const width = sources.length * (tw + 4) - 4;
  const buf = await sharp({ create: { width, height: TILE_H + LABEL_H, channels: 3, background: "white" } }).composite(parts).jpeg().toBuffer();
  if (width <= SHEET_W) return { width, buf };
  // too wide for a sheet (a wide crop): scale down, keeping the row height
  const fit = await sharp(buf).resize(SHEET_W).toBuffer();
  return { width: SHEET_W, buf: await sharp({ create: { width: SHEET_W, height: TILE_H + LABEL_H, channels: 3, background: "white" } }).composite([{ input: fit, left: 0, top: 0 }]).jpeg().toBuffer() };
}

const tiles = [];
for (const n of names) tiles.push(await tile(n));
const rows = [];
let row = [];
for (const t of tiles) {
  if (row.length && row.reduce((a, r) => a + r.width + 24, 0) + t.width > SHEET_W) (rows.push(row), (row = []));
  row.push(t);
}
if (row.length) rows.push(row);
const rowH = TILE_H + LABEL_H + GAP * 2;
const perSheet = Math.max(1, Math.floor(1900 / rowH));
let k = 0;
for (let p = 0; p < rows.length; p += perSheet) {
  const rs = rows.slice(p, p + perSheet);
  const comp = [];
  rs.forEach((r, i) => {
    let x = 0;
    for (const t of r) {
      comp.push({ input: t.buf, left: x, top: i * rowH + GAP });
      x += t.width + 24;
    }
  });
  const file = path.join(o.out, `sheet${String(++k).padStart(2, "0")}.jpg`);
  await sharp({ create: { width: SHEET_W, height: rs.length * rowH, channels: 3, background: "#ecebef" } }).composite(comp).jpeg({ quality: 86 }).toFile(file);
}
console.log(`${k} sheets in ${o.out}`);
