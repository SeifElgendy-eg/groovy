// Measure how the slimming changes each photo, from dumps (run-app.mjs or fields.mjs), and compare
// with a baseline.
//
//   node scripts/body/metrics.mjs --runs <folder> [--baseline <report.json>] [--save <report.json>]
//
// Per photo, at 100% (the strengths the app uses):
//   swell   share of the arm (inside, away from its edge) magnified by more than 25%
//   squash  share of the arm shrunk to less than 55%
//   bend    how much the arm's picture is sheared, degrees (98th percentile)
//   hand    how unevenly a hand moves (spread of its movement / its size): >0.25 bends or tears it
//   folds   pixels where the picture folds over itself (should be 0)
//   waist, hip  how much narrower they get (%), and the waist-to-hip ratio before -> after
// With --baseline, photos that got worse beyond small margins are listed and the exit code is 1.
import fs from "node:fs";
import path from "node:path";
import { dumpsIn, loadField, options, readDump } from "./lib.mjs";

const o = options();
if (!o.runs) {
  console.error("usage: node scripts/body/metrics.mjs --runs <folder> [--baseline <report.json>] [--save <report.json>]");
  process.exit(2);
}
const field = await loadField();
const LIMITS = { swell: 0.03, squash: 0.03, bend: 15, hand: 0.25, folds: 0 };
const MARGIN = { swell: 0.02, squash: 0.02, bend: 3, hand: 0.08, folds: 10, whr: 0.03 };

function measure(d) {
  const { w, h } = d.meta;
  // the strength the app uses at 100%: the build, and the photo's cap (when the run has one)
  const build = d.meta.build * (d.meta.cap ?? 1);
  const n = w * h;
  const J = d.joints;
  const k = [field.FULL.arms * build, field.FULL.torso * build, d.meta.legs === false ? 0 : field.FULL.legs * build];
  const dx = new Float32Array(n), dy = new Float32Array(n);
  [d.arms, d.torso, d.legs].forEach((f, j) => {
    for (let i = 0; i < n; i++) {
      dx[i] += k[j] * f[2 * i];
      dy[i] += k[j] * f[2 * i + 1];
    }
  });
  const P = d.person, L = d.labels;
  const sw = Math.max(4, Math.hypot(J[6] - J[15], J[7] - J[16]));
  // derivatives of the backward map (central differences, one-sided at the borders)
  const der = (a, i, x, y, axis) => {
    if (axis === 0) return x === 0 ? a[i + 1] - a[i] : x === w - 1 ? a[i] - a[i - 1] : (a[i + 1] - a[i - 1]) / 2;
    return y === 0 ? a[i + w] - a[i] : y === h - 1 ? a[i] - a[i - w] : (a[i + w] - a[i - w]) / 2;
  };
  const det = new Float32Array(n), ang = new Float32Array(n);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const a11 = 1 + der(dx, i, x, y, 0), a12 = der(dx, i, x, y, 1), a21 = der(dy, i, x, y, 0), a22 = 1 + der(dy, i, x, y, 1);
      det[i] = a11 * a22 - a12 * a21;
      ang[i] = (Math.abs(Math.atan2(a21, a11) - Math.atan2(-a12, a22)) * 180) / Math.PI;
    }
  // the arm away from its edge (the edge is where the arm meets the moved background)
  const armM = new Uint8Array(n);
  for (let i = 0; i < n; i++) armM[i] = P[i] > 0.5 && L[i] >= 2 && L[i] <= 9 ? 1 : 0;
  const armD = field.distanceTransform(armM, w, h);
  const inner = Math.max(1, 0.02 * sw);
  let armN = 0, sw_ = 0, sq = 0;
  const angs = [];
  for (let i = 0; i < n; i++) {
    if (armD[i] <= inner) continue;
    armN++;
    if (det[i] < 0.8) sw_++;
    if (det[i] > 1.8) sq++;
    angs.push(ang[i]);
  }
  angs.sort((a, b) => a - b);
  // hands
  let hand = 0;
  for (const id of [10, 11]) {
    let c = 0, mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity;
    for (let i = 0; i < n; i++)
      if (P[i] > 0.5 && L[i] === id) {
        c++;
        mnx = Math.min(mnx, dx[i]);
        mxx = Math.max(mxx, dx[i]);
        mny = Math.min(mny, dy[i]);
        mxy = Math.max(mxy, dy[i]);
      }
    if (c >= 20) hand = Math.max(hand, Math.max(mxx - mnx, mxy - mny) / Math.sqrt(c));
  }
  // folds near the person
  const notP = new Uint8Array(n);
  for (let i = 0; i < n; i++) notP[i] = P[i] > 0.5 ? 0 : 1;
  const pD = field.distanceTransform(Uint8Array.from(notP, (v) => 1 - v), w, h); // distance from the person
  let folds = 0;
  for (let i = 0; i < n; i++) if (det[i] < 0 && pD[i] < 0.3 * sw) folds++;
  // waist and hips: widths of the body (without the arms) before and after
  const body = new Uint8Array(n);
  for (let i = 0; i < n; i++) body[i] = P[i] > 0.5 && !(L[i] >= 2 && L[i] <= 11) ? 1 : 0;
  const after = (x, y) => {
    const i = y * w + x;
    const sx = Math.round(x + dx[i]), sy = Math.round(y + dy[i]);
    return sx >= 0 && sy >= 0 && sx < w && sy < h ? body[sy * w + sx] : 0;
  };
  const width = (y, moved) => {
    let a = -1, b = -1;
    for (let x = 0; x < w; x++)
      if (moved ? after(x, y) : body[y * w + x]) {
        if (a < 0) a = x;
        b = x;
      }
    return a < 0 ? 0 : b - a + 1;
  };
  const ny = (J[7] + J[16]) / 2, hy = (J[25] + J[34]) / 2, ky = (J[28] + J[37]) / 2, tl = hy - ny;
  let wy = -1, wmin = Infinity;
  for (let y = Math.round(ny + 0.4 * tl); y < Math.round(ny + 0.9 * tl) && y < h; y++) {
    const v = width(y, false);
    if (v > 0 && v < wmin) (wmin = v), (wy = y);
  }
  let hipy = -1, hmax = 0;
  for (let y = Math.max(0, wy); y < Math.min(h, Math.round(hy + 0.4 * Math.max(ky - hy, 0.3 * tl))); y++) {
    const v = width(y, false);
    if (v > hmax) (hmax = v), (hipy = y);
  }
  const r = {
    swell: armN > 20 ? sw_ / armN : 0,
    squash: armN > 20 ? sq / armN : 0,
    bend: angs.length > 20 ? angs[Math.floor(0.98 * (angs.length - 1))] : 0,
    hand,
    folds,
    ms: d.meta.ms?.fields ?? null,
  };
  if (wy >= 0 && hipy >= 0 && wmin > 0 && hmax > 0) {
    const w1 = width(wy, true), h1 = width(hipy, true);
    Object.assign(r, { waist: 1 - w1 / wmin, hip: 1 - h1 / hmax, whr0: wmin / hmax, whr1: h1 ? w1 / h1 : 0 });
  }
  return r;
}

const names = dumpsIn(path.join(o.runs, "dump"));
const report = {};
for (const name of names) report[name] = measure(readDump(path.join(o.runs, "dump", name)));
const f2 = (v, d = 2) => (v === undefined || v === null ? "  -  " : v.toFixed(d));
console.log("photo                       swell squash  bend  hand folds  waist   hip   waist/hip   fields");
for (const [name, r] of Object.entries(report)) {
  const over = Object.entries(LIMITS).filter(([k, lim]) => r[k] > lim).map(([k]) => k);
  console.log(
    `${name.padEnd(26)} ${f2(r.swell)}  ${f2(r.squash)}  ${f2(r.bend, 0).padStart(4)}  ${f2(r.hand)}  ${String(r.folds).padStart(4)}  ` +
      `${r.waist !== undefined ? (100 * r.waist).toFixed(0).padStart(4) + "%" : "   - "} ${r.hip !== undefined ? (100 * r.hip).toFixed(0).padStart(4) + "%" : "   - "}  ` +
      `${r.whr0 !== undefined ? `${f2(r.whr0)}->${f2(r.whr1)}` : "     -    "}  ${r.ms !== null ? r.ms.toFixed(0).padStart(5) + " ms" : ""}${over.length ? "  over: " + over.join(",") : ""}`,
  );
}
const mean = (k) => {
  const v = Object.values(report).map((r) => r[k]).filter((x) => typeof x === "number");
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
};
console.log(`\n${names.length} photos; mean fields time ${mean("ms").toFixed(0)} ms; folds total ${Object.values(report).reduce((a, r) => a + r.folds, 0)}`);
if (o.save) fs.writeFileSync(o.save, JSON.stringify(report, null, 1));

if (o.baseline) {
  const base = JSON.parse(fs.readFileSync(o.baseline, "utf8"));
  const worse = [];
  for (const [name, r] of Object.entries(report)) {
    const b = base[name];
    if (!b) continue;
    for (const k of ["swell", "squash", "bend", "hand", "folds"]) if (r[k] > b[k] + MARGIN[k] && r[k] > LIMITS[k] * 0.5) worse.push(`${name}: ${k} ${f2(b[k])} -> ${f2(r[k])}`);
    if (r.whr0 !== undefined && b.whr1 !== undefined && Math.abs(r.whr1 - r.whr0) > Math.abs(b.whr1 - b.whr0) + MARGIN.whr)
      worse.push(`${name}: waist/hip change ${f2(b.whr1 - b.whr0)} -> ${f2(r.whr1 - r.whr0)}`);
  }
  console.log(worse.length ? `\nWorse than the baseline:\n  ${worse.join("\n  ")}` : "\nNothing worse than the baseline.");
  if (worse.length) process.exitCode = 1;
}
