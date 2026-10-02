// Golden-image harness. Drives the app through its stable DOM ids and snapshots #stage.
//   node tests/golden/run.mjs --url http://127.0.0.1:8080/ --update   (write goldens)
//   node tests/golden/run.mjs --url http://127.0.0.1:8080/            (compare)
// The DOM ids / data-attributes used below are the test contract: keep them stable in any refactor.
import { chromium } from "playwright";
import { preview } from "vite";
import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
// Without --url, serve the freshly built dist/ (run `npm run build` first).
let previewServer = null;
let URL_ = arg("--url", "");
if (!URL_) {
  previewServer = await preview({ preview: { host: "127.0.0.1", port: 0, strictPort: false, open: false } });
  URL_ = previewServer.resolvedUrls.local[0];
}
const UPDATE = args.includes("--update");
const GOLD = path.join(here, "golden-images");
const OUT = path.join(here, "out");
const MAX_MEAN_DIFF = Number(arg("--mean", 0.01)); // mean abs channel diff (0..255)
fs.mkdirSync(GOLD, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

const scenarios = [
  { name: "lips-original", module: "#chooseLipsBtn", sample: "#sampleBtn", steps: [] },
  ...[16, 28, 50].map((p) => ({
    name: `lips-preset-${p}`, module: "#chooseLipsBtn", sample: "#sampleBtn",
    steps: [`[data-lip-preset="${p}"]`],
  })),
  { name: "lips-color-28", module: "#chooseLipsBtn", sample: "#sampleBtn", steps: ['[data-shade="brightred"]'] },
  { name: "wrinkles-100", module: "#chooseWrinklesBtn", sample: "#wrinklesSampleBtn", steps: [] },
  ...[50, 80, 100].map((p) => ({
    name: `acne-${p}`, module: "#chooseAcneBtn", sample: "#acneSampleBtn",
    steps: [`[data-acne-preset="${p}"]`],
  })),
];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
let failed = 0;
for (const s of scenarios) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => console.log("  pageerror:", e.message));
  await page.goto(URL_);
  await page.waitForFunction(() => !document.getElementById("startBtn").disabled, null, { timeout: 120000 });
  await page.click(s.module);
  await page.click(s.sample);
  await page.waitForFunction(
    () => document.getElementById("perfBadge").textContent === "PHOTO READY" &&
          document.getElementById("faceBadge").classList.contains("detected"),
    null, { timeout: 120000 });
  for (const sel of s.steps) await page.click(sel);
  await page.waitForTimeout(1500); // let prepare*/render settle
  const dataUrl = await page.evaluate(() => document.getElementById("stage").toDataURL("image/png"));
  const buf = Buffer.from(dataUrl.split(",")[1], "base64");
  fs.writeFileSync(path.join(OUT, `${s.name}.png`), buf);
  await page.close();
  const goldPath = path.join(GOLD, `${s.name}.png`);
  if (UPDATE) { fs.writeFileSync(goldPath, buf); console.log("wrote", s.name); continue; }
  if (!fs.existsSync(goldPath)) { console.log("MISSING golden", s.name); failed++; continue; }
  const a = await sharp(goldPath).raw().toBuffer({ resolveWithObject: true });
  const b = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  if (a.info.width !== b.info.width || a.info.height !== b.info.height || a.info.channels !== b.info.channels) {
    console.log("FAIL", s.name, "size mismatch"); failed++; continue;
  }
  let sum = 0, max = 0;
  for (let i = 0; i < a.data.length; i++) { const d = Math.abs(a.data[i] - b.data[i]); sum += d; if (d > max) max = d; }
  const mean = sum / a.data.length;
  const ok = mean <= MAX_MEAN_DIFF;
  console.log(ok ? "ok  " : "FAIL", s.name, `mean=${mean.toFixed(4)} max=${max}`);
  if (!ok) failed++;
}
await browser.close();
await previewServer?.close();
process.exit(failed ? 1 : 0);
