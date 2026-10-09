// Recompute the movement fields from dumped inputs (run-app.mjs) with the current
// src/effects/body/field.ts, without the browser: fast to iterate on the slimming.
//
//   node scripts/body/fields.mjs --runs <folder> --out <folder> [--render] [--compare] [names...]
//
//   --runs     a run-app.mjs output folder (uses its dump/ inputs)
//   --out      where to write: <out>/dump/<name>/ (fields, labels; same layout as run-app.mjs)
//   --render   also write the photo at 100% to <out>/app/<name>-100.jpg (no backdrop)
//   --compare  print the largest difference to the fields dumped by the app (0 = identical)
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { dumpsIn, loadField, options, readDump, warpRGB, writeDump } from "./lib.mjs";

const o = options();
if (!o.runs || !o.out) {
  console.error("usage: node scripts/body/fields.mjs --runs <folder> --out <folder> [--render] [--compare] [names...]");
  process.exit(2);
}
const field = await loadField();
const names = o._.length ? o._ : dumpsIn(path.join(o.runs, "dump"));
let total = 0, worst = 0;
for (const name of names) {
  const d = readDump(path.join(o.runs, "dump", name));
  if (!d.in_person) {
    console.log(`${name}: no inputs in the dump (run the app with ?debug=body: run-app.mjs does)`);
    continue;
  }
  const { w, h } = d.meta;
  const t = performance.now();
  const r = field.bodyFields({ w, h, person: d.in_person.slice(), labels: d.in_labels.slice(), joints: d.in_joints.slice(), rgb: d.in_rgb });
  const ms = performance.now() - t;
  total += ms;
  writeDump(path.join(o.out, "dump", name), { ...d.meta, build: r.build, ms: { fields: ms } }, {
    arms: r.arms, torso: r.torso, legs: r.legs, labels: r.labels, person: d.person, joints: d.joints,
  });
  let line = `${name}: ${ms.toFixed(0)} ms`;
  if (o.compare) {
    let m = 0;
    for (const k of ["arms", "torso", "legs"]) for (let i = 0; i < r[k].length; i++) m = Math.max(m, Math.abs(r[k][i] - d[k][i]));
    m = Math.max(m, Math.abs(r.build - d.meta.build));
    worst = Math.max(worst, m);
    line += `  max diff ${m.toExponential(2)}`;
  }
  if (o.render) {
    const { data, info } = await sharp(d.meta.photo).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const k = [field.FULL.arms * r.build, field.FULL.torso * r.build, d.meta.legs === false ? 0 : field.FULL.legs * r.build];
    const img = warpRGB(data, info.width, info.height, [r.arms, r.torso, r.legs], k, w, h);
    fs.mkdirSync(path.join(o.out, "app"), { recursive: true });
    await sharp(img, { raw: { width: info.width, height: info.height, channels: 3 } }).jpeg({ quality: 92 }).toFile(path.join(o.out, "app", `${name}-100.jpg`));
  }
  console.log(line);
}
console.log(`${names.length} photos, ${(total / Math.max(1, names.length)).toFixed(0)} ms per photo` + (o.compare ? `, largest difference ${worst.toExponential(2)}` : ""));
