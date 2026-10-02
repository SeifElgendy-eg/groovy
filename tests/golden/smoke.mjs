// UI smoke test: service switching, headers, sample-button labels, reset behaviour.
import { chromium } from "playwright";
import { preview } from "vite";
const server = await preview({ preview: { host: "127.0.0.1", port: 0, open: false } });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  // Fake camera so the live-camera path (permission, stream, guide, capture button) is exercised.
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(server.resolvedUrls.local[0]);
await page.waitForFunction(() => !document.getElementById("startBtn").disabled, null, { timeout: 120000 });
const expected = { "#chooseLipsBtn": ["LIPS", "Filler (lips)", "Test Photo"], "#chooseWrinklesBtn": ["WRINKLES", "Botox (wrinkles)", "Test Photo · Wrinkles"], "#chooseAcneBtn": ["ACNE", "Acne Treatment", "Test Photo · Acne"] };
let bad = 0;
for (const [sel, [eyebrow, title, label]] of Object.entries(expected)) {
  await page.click(sel);
  const got = await page.evaluate(() => [moduleEyebrow.textContent, moduleTitle.textContent, sampleBtn.textContent]);
  const ok = got.join("|") === [eyebrow, title, label].join("|");
  console.log(ok ? "ok  " : "FAIL", sel, got.join(" | "));
  if (!ok) bad++;
  await page.click("#backHomeBtn");
}
await page.click("#chooseWrinklesBtn");
await page.click("#resetBtn");
const before = await page.evaluate(() => beforeBtn.classList.contains("active"));
console.log(before ? "ok  " : "FAIL", "wrinkles reset shows Before");
if (!before) bad++;
await page.click("#backHomeBtn");
await page.click("#chooseLipsBtn");
await page.click("#resetBtn");
const lipsBefore = await page.evaluate(() => beforeBtn.classList.contains("active"));
console.log(!lipsBefore ? "ok  " : "FAIL", "lips reset keeps After");
if (lipsBefore) bad++;
// "Show face mask" debug overlay must draw for acne and wrinkles (it reads each effect's mask).
for (const [choose, sample] of [["#chooseAcneBtn", "#acneSampleBtn"], ["#chooseWrinklesBtn", "#wrinklesSampleBtn"]]) {
  await page.click("#backHomeBtn").catch(() => {});
  await page.click(choose);
  await page.click(sample);
  await page.waitForFunction(() => document.getElementById("perfBadge").textContent === "PHOTO READY" && document.getElementById("faceBadge").classList.contains("detected"), null, { timeout: 120000 });
  await page.waitForTimeout(800);
  const off = await page.evaluate(() => stage.toDataURL());
  await page.evaluate(() => { skinDebug.checked = true; skinDebug.dispatchEvent(new Event("change")); });
  await page.waitForTimeout(800);
  const on = await page.evaluate(() => stage.toDataURL());
  const ok = on !== off;
  console.log(ok ? "ok  " : "FAIL", choose, "debug mask overlay draws");
  if (!ok) bad++;
  await page.evaluate(() => { skinDebug.checked = false; });
}
// Live camera path: start the (fake) camera, pick a service, the capture guide must appear.
{
  const cam = await browser.newPage();
  cam.on("pageerror", (e) => errors.push(e.message));
  await cam.goto(server.resolvedUrls.local[0]);
  await cam.waitForFunction(() => !document.getElementById("startBtn").disabled, null, { timeout: 120000 });
  await cam.click("#chooseLipsBtn"); // the viewer is hidden on the home screen
  await cam.click("#startBtn");
  await cam.waitForFunction(() => document.getElementById("overlay").classList.contains("hidden"), null, { timeout: 30000 });
  await cam.waitForTimeout(800);
  const state = await cam.evaluate(() => ({
    guideShown: !document.querySelector(".face-guide").hidden,
    label: document.querySelector(".face-guide-label").textContent,
    source: document.getElementById("sourceBadge").textContent,
    capture: !!document.querySelector(".capture-photo"),
  }));
  const ok = state.guideShown && state.capture && state.source.includes("CAMERA") && state.label === "Position your face inside the oval";
  console.log(ok ? "ok  " : "FAIL", "live camera shows the capture guide", JSON.stringify(state));
  if (!ok) bad++;
  await cam.close();
}
if (errors.length) { console.log("page errors:", errors); bad++; }
await browser.close(); await server.close();
process.exit(bad ? 1 : 0);
