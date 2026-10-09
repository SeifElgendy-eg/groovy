// Recompute the movement fields from dumped inputs (run-app.mjs) with the current
// src/effects/body/field.ts, without the browser: fast to iterate on the slimming.
//
//   node scripts/body/fields.mjs --runs <folder> --out <folder> [--render] [--compare] [names...]
//
//   --runs     a run-app.mjs output folder (uses its dump/ inputs)
//   --out      where to write: <out>/dump/<name>/ (fields, labels; same layout as run-app.mjs)
//   --render   also write the photo at 100% to <out>/app/<name>-100.jpg (no backdrop)
//   --compare  print the largest difference to the fields dumped by the app (0 = identical)
//   --pose <file.json>  use these body points instead of BodyPix's: MediaPipe Pose landmarks per
//              photo ({ "<any path>/<name>.<ext>": { lm: [[x, y, visibility] x 33] (0..1) } })
//   --fuse     per limb, MediaPipe's points (--pose, or the app's) where they lie on the right body
//              parts, else BodyPix's (src/effects/body/joints.ts). Without --pose/--fuse: the app's points.
//   --bodypix  BodyPix's points alone (as before MediaPipe)
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

const joints2 = await loadField("joints");
const pose = o.pose ? Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(o.pose, "utf8"))).map(([k, v]) => [path.basename(k).replace(/\.\w+$/, ""), v])) : null;
const chosen = {};
/**
 * The body points to use: as the app did (default), or from BodyPix's and MediaPipe's own points:
 * --pose: MediaPipe's from that file (else the app's dumped ones), --fuse: combined (joints.ts).
 */
function jointsFor(name, d) {
  if (o.bodypix) return (d.in_bodypix ?? d.in_joints).slice();
  if (!o.pose && !o.fuse) return d.in_joints.slice();
  const { w, h } = d.meta;
  const bodypix = d.in_bodypix ?? d.in_joints; // older dumps: in_joints were BodyPix's
  const lm = pose?.[name]?.lm;
  const mp = lm ? joints2.fromMediaPipe(lm, w, h) : d.in_mediapipe?.length ? d.in_mediapipe : null;
  if (!mp) return bodypix.slice();
  if (!o.fuse) return mp.slice();
  const f = joints2.fuseJoints({ w, h, person: d.in_person, labels: d.in_labels, bodypix, mediapipe: mp });
  chosen[name] = f.chosen;
  return f.joints;
}
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
  const joints = jointsFor(name, d);
  const dbg = {};
  const r = field.bodyFields({ w, h, person: d.in_person.slice(), labels: d.in_labels.slice(), joints, rgb: d.in_rgb, debug: dbg });
  const ms = performance.now() - t;
  total += ms;
  writeDump(path.join(o.out, "dump", name), { ...d.meta, build: r.build, cap: r.cap, ms: { fields: ms } }, {
    arms: r.arms, torso: r.torso, legs: r.legs, labels: r.labels, person: d.person, joints,
  });
  let line = `${name}: ${ms.toFixed(0)} ms, strength ${r.build.toFixed(2)} cap ${r.cap.toFixed(2)}` + (o.verbose ? ` ${Object.entries(dbg).map(([k, v]) => `${k} ${v.toFixed(3)}`).join(" ")}` : "");
  if (o.compare) {
    let m = 0;
    for (const k of ["arms", "torso", "legs"]) for (let i = 0; i < r[k].length; i++) m = Math.max(m, Math.abs(r[k][i] - d[k][i]));
    m = Math.max(m, Math.abs(r.build - d.meta.build));
    worst = Math.max(worst, m);
    line += `  max diff ${m.toExponential(2)}`;
  }
  if (o.render) {
    const { data, info } = await sharp(d.meta.photo).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const c = r.build * r.cap;
    const k = [field.FULL.arms * c, field.FULL.torso * c, d.meta.legs === false ? 0 : field.FULL.legs * c];
    const img = warpRGB(data, info.width, info.height, [r.arms, r.torso, r.legs], k, w, h);
    fs.mkdirSync(path.join(o.out, "app"), { recursive: true });
    await sharp(img, { raw: { width: info.width, height: info.height, channels: 3 } }).jpeg({ quality: 92 }).toFile(path.join(o.out, "app", `${name}-100.jpg`));
  }
  if (chosen[name]) line += `  limbs (R arm, L arm, R leg, L leg, hips): ${chosen[name].join(" ")}`;
  console.log(line);
}
console.log(`${names.length} photos, ${(total / Math.max(1, names.length)).toFixed(0)} ms per photo` + (o.compare ? `, largest difference ${worst.toExponential(2)}` : ""));
