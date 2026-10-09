// Run photos through the built app's body shaping (as a visitor would: upload, slider) and save,
// per photo, the pictures at the given strengths and a dump of the analysis (the fields, body points,
// body parts and the fields' inputs) for metrics.mjs and fields.mjs.
//
//   npm run build
//   node scripts/body/run-app.mjs --out <folder> [--dist dist] [--at 50,100] <photo or folder>...
//
// The photos and everything written stay in --out on this computer: photos of people must not be
// committed or shared.
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { ROOT, nameOf, options, photoList, writeDump } from "./lib.mjs";

const o = options();
if (!o.out || !o._.length) {
  console.error("usage: node scripts/body/run-app.mjs --out <folder> [--dist dist] [--at 50,100] <photo or folder>...");
  process.exit(2);
}
const dist = path.resolve(o.dist ?? path.join(ROOT, "dist"));
const out = path.resolve(o.out);
const strengths = String(o.at ?? "50,100").split(",").map(Number);
const photos = photoList(o._);
fs.mkdirSync(path.join(out, "app"), { recursive: true });
fs.mkdirSync(path.join(out, "dump"), { recursive: true });

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".png": "image/png", ".json": "application/json", ".svg": "image/svg+xml" };
const server = http
  .createServer((req, res) => {
    let f = path.join(dist, decodeURIComponent(req.url.split("?")[0]));
    if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, "index.html");
    if (!fs.existsSync(f)) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { "Content-Type": types[path.extname(f)] || "application/octet-stream", "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" });
    fs.createReadStream(f).pipe(res);
  })
  .listen(0, "127.0.0.1");
await new Promise((r) => server.on("listening", r));
const url = `http://127.0.0.1:${server.address().port}/?debug=body`;

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(url);
await page.waitForFunction(() => !document.getElementById("startBtn").disabled, null, { timeout: 180000 });
await page.evaluate(() => document.getElementById("chooseBodyBtn").click());
await page.waitForTimeout(3000);

const setSlider = (v) =>
  page.evaluate((v) => {
    const el = document.getElementById("bodySlider");
    el.value = String(v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, v);
const idle = () => page.waitForFunction(() => !document.body.dataset.effectsBusy, null, { timeout: 300000, polling: 50 });
const grab = () =>
  page.evaluate(() => {
    const st = document.getElementById("stage");
    const c = document.createElement("canvas");
    c.width = st.width;
    c.height = st.height;
    const x = c.getContext("2d");
    x.drawImage(document.getElementById("photo"), 0, 0, c.width, c.height);
    x.drawImage(st, 0, 0);
    return c.toDataURL("image/jpeg", 0.92);
  });

const summary = [];
for (const photo of photos) {
  const name = nameOf(photo);
  const t0 = Date.now();
  await setSlider(0);
  await page.setInputFiles("#fileInput", photo);
  await page.waitForFunction(() => document.getElementById("perfBadge").textContent === "PHOTO READY", null, { timeout: 300000 });
  for (const v of strengths) {
    await setSlider(v);
    await page.waitForTimeout(100);
    await idle();
    const d = await grab();
    fs.writeFileSync(path.join(out, "app", `${name}-${v}.jpg`), Buffer.from(d.split(",")[1], "base64"));
  }
  const dump = await page.evaluate(() => {
    const r = globalThis.groovyBody?.analysis;
    if (!r) return null;
    const b64 = (a) => {
      const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
      let s = "";
      for (let i = 0; i < u.length; i += 32768) s += String.fromCharCode(...u.subarray(i, i + 32768));
      return btoa(s);
    };
    const arrays = { arms: r.arms, torso: r.torso, legs: r.legs, labels: r.labels, person: r.person, joints: r.joints };
    if (r.inputs)
      Object.assign(arrays, {
        in_person: r.inputs.person, in_labels: r.inputs.labels, in_joints: r.inputs.joints, in_rgb: r.inputs.rgb,
        in_bodypix: r.inputs.bodypix, in_mediapipe: r.inputs.mediapipe,
      });
    return {
      meta: { w: r.w, h: r.h, build: r.build, ms: { ...r.ms, ...globalThis.groovyBody.lastMs }, limbs: r.limbs, outline: r.outline, legs: globalThis.groovyBody.legs },
      arrays: Object.fromEntries(Object.entries(arrays).map(([k, a]) => [k, [a.constructor.name, b64(a)]])),
      status: document.getElementById("bodyStatus").textContent.trim(),
    };
  });
  if (!dump) {
    console.log(`${name}: no body analysis (${await page.textContent("#bodyStatus")})`);
    summary.push({ name, analysed: false });
    continue;
  }
  const ctor = { Float32Array, Uint8Array, Uint8ClampedArray };
  const arrays = Object.fromEntries(
    Object.entries(dump.arrays).map(([k, [c, s]]) => {
      const b = Buffer.from(s, "base64");
      return [k, new ctor[c](b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))];
    }),
  );
  writeDump(path.join(out, "dump", name), { ...dump.meta, photo: path.resolve(photo), status: dump.status }, arrays);
  const ms = Date.now() - t0;
  const t = dump.meta.ms;
  console.log(`${name}: ${ms} ms (model ${t.model.toFixed(0)} ms, MediaPipe ${(t.pose ?? 0).toFixed(0)} ms, fields ${t.fields.toFixed(0)} ms; limbs ${(dump.meta.limbs ?? []).join(" ") || "BodyPix"}) | ${dump.status}`);
  summary.push({ name, analysed: true, ms, ...dump.meta.ms });
}
fs.writeFileSync(path.join(out, "run.json"), JSON.stringify({ photos: summary, errors }, null, 1));
if (errors.length) console.log("page errors:\n" + errors.join("\n"));
await browser.close();
server.close();
