// The packaged app, as the kiosk runs it: served by the Windows launcher, opened in Edge.
// Run by the windows-package workflow after the launcher has started:
//
//   node tests/windows/zip-smoke.mjs http://127.0.0.1:8019 <app folder>
//
// Fails on any file the page asks for that the launcher does not serve, on page errors, and when
// a model does not load: the face models (the start button), BodyPix (the body worker) or MediaPipe
// Pose (its frame). Then a photo goes through body shaping, which must finish (applied, or "no
// full body found" for this face photo), and the processing indicator must be gone.
import { chromium } from "playwright";
import path from "node:path";

const [base, appDir] = process.argv.slice(2);
if (!base || !appDir) {
  console.error("usage: node tests/windows/zip-smoke.mjs <launcher url> <app folder>");
  process.exit(2);
}
const problems = [];
const browser = await chromium.launch({
  channel: process.platform === "win32" ? "msedge" : undefined,
  executablePath: process.platform === "win32" ? undefined : process.env.CHROMIUM_PATH,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
page.on("response", (r) => {
  if (r.status() >= 400 && !r.url().endsWith("/favicon.ico")) problems.push(`${r.status()} ${r.url()}`);
});
page.on("requestfailed", (r) => {
  if (!r.url().endsWith("/favicon.ico")) problems.push(`request failed: ${r.url()} (${r.failure()?.errorText})`);
});
page.on("console", (m) => {
  if (/unavailable|did not load/i.test(m.text())) problems.push(`console: ${m.text().slice(0, 300)}`);
});

const step = async (name, fn) => {
  const t = Date.now();
  try {
    await fn();
    console.log(`ok   ${name} (${((Date.now() - t) / 1000).toFixed(1)} s)`);
  } catch (err) {
    problems.push(`${name}: ${err.message.split("\n")[0]}`);
    console.log(`FAIL ${name}`);
  }
};

await step("the app loads its models", async () => {
  await page.goto(`${base}/?debug=body`);
  await page.waitForFunction(() => !document.getElementById("startBtn").disabled, null, { timeout: 180000 });
});
await step("body shaping opens", () => page.evaluate(() => document.getElementById("chooseBodyBtn").click()));
await step("MediaPipe Pose loads in its frame", () =>
  page.evaluate(async () => {
    const until = Date.now() + 120000;
    let f = null;
    while (!(f = document.querySelector('iframe[title="body points"]'))?.contentWindow?.poseReady) {
      if (Date.now() > until) throw new Error("no MediaPipe frame");
      await new Promise((r) => setTimeout(r, 250));
    }
    const w = f.contentWindow;
    const r = await Promise.race([w.poseReady.then(() => "ready"), w.poseFailed, new Promise((r) => setTimeout(() => r("timed out"), 120000))]);
    if (r !== "ready") throw new Error(r);
  }),
);
await step("a photo goes through body shaping to the end", async () => {
  await page.setInputFiles("#fileInput", path.join(appDir, "sample-face-test.png"));
  await page.waitForFunction(() => document.getElementById("perfBadge").textContent === "PHOTO READY", null, { timeout: 180000 });
  await page.evaluate(() => {
    const el = document.getElementById("bodySlider");
    el.value = "100";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForFunction(() => globalThis.groovyBody && !globalThis.groovyBody.busy && (globalThis.groovyBody.ready || globalThis.groovyBody.failed), null, { timeout: 180000, polling: 250 });
  const shown = await page.evaluate(() => ({ status: document.getElementById("bodyStatus").textContent.trim(), indicator: !document.querySelector(".body-progress")?.hidden }));
  console.log(`     status: ${shown.status}`);
  if (shown.indicator) throw new Error("the processing indicator is still shown");
});

await browser.close();
if (problems.length) {
  console.log(`\n${problems.length} problem(s):\n  ${problems.join("\n  ")}`);
  // (on GitHub, as annotations: readable on the run's page and through the API)
  if (process.env.GITHUB_ACTIONS) for (const p of problems) console.log(`::error title=zip smoke::${p.replace(/\r?\n/g, " ")}`);
  process.exit(1);
}
console.log("\nzip smoke OK");
