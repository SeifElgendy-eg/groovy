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
const expected = { "#chooseLipsBtn": ["LIPS", "Filler (lips)", "Test Photo"], "#chooseWrinklesBtn": ["WRINKLES", "Botox (wrinkles)", "Test Photo · Wrinkles"], "#chooseAcneBtn": ["ACNE", "Acne Treatment", "Test Photo · Acne"], "#chooseBodyBtn": ["BODY", "Weight loss (body shaping)", "Test Photo"] };
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
  const settled = async () => {
    await page.waitForTimeout(300);
    await page.waitForFunction(() => !document.body.dataset.effectsBusy, null, { timeout: 60000 });
    await page.waitForTimeout(200);
  };
  await settled();
  const off = await page.evaluate(() => stage.toDataURL());
  await page.evaluate(() => { skinDebug.checked = true; skinDebug.dispatchEvent(new Event("change")); });
  await settled();
  const on = await page.evaluate(() => stage.toDataURL());
  const ok = on !== off;
  console.log(ok ? "ok  " : "FAIL", choose, "debug mask overlay draws");
  if (!ok) bad++;
  await page.evaluate(() => { skinDebug.checked = false; });
  const where = await page.evaluate(() => document.body.dataset.skinCompute);
  console.log(where === "worker" ? "ok  " : "FAIL", choose, "skin effect computed in the Web Worker:", where);
  if (where !== "worker") bad++;
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

  // "Take photo": the frame is used directly (no PNG round trip) at the camera's full resolution,
  // shown in place of the <img>.
  {
    const t0 = Date.now();
    await cam.click(".capture-photo");
    await cam.waitForFunction(() => document.getElementById("perfBadge").textContent === "PHOTO READY", null, { timeout: 120000 });
    const shot = await cam.evaluate(() => {
      const still = document.querySelector(".captured-still");
      return {
        still: !!still && getComputedStyle(still).display !== "none",
        imgHidden: getComputedStyle(document.getElementById("photo")).display === "none",
        size: still ? `${still.width}x${still.height}` : "",
        video: `${document.getElementById("video").videoWidth}x${document.getElementById("video").videoHeight}`,
        stage: `${document.getElementById("stage").width}x${document.getElementById("stage").height}`,
      };
    });
    const okShot = shot.still && shot.imgHidden && shot.size === shot.video && shot.stage === shot.video;
    console.log(okShot ? "ok  " : "FAIL", "take photo uses the full-resolution frame directly", JSON.stringify(shot), `${Date.now() - t0} ms`);
    if (!okShot) bad++;
    await cam.click("#cameraBtn"); // back to the live camera for the next checks
    await cam.waitForTimeout(800);
    const back = await cam.evaluate(() => getComputedStyle(document.querySelector(".captured-still")).display === "none" && getComputedStyle(document.getElementById("video")).display !== "none");
    console.log(back ? "ok  " : "FAIL", "back to camera hides the captured photo");
    if (!back) bad++;
  }

  // Staff camera panel: opens with Ctrl+Shift+C and reports the granted stream resolution.
  await cam.keyboard.press("Control+Shift+C");
  await cam.waitForTimeout(300);
  const panel = await cam.evaluate(() => {
    const p = document.querySelector(".camera-panel");
    return { shown: !!p && !p.hidden, res: p?.querySelector("[data-res]")?.textContent ?? "" };
  });
  const panelOk = panel.shown && /\d+×\d+ @ \d+ fps/.test(panel.res);
  console.log(panelOk ? "ok  " : "FAIL", "camera panel shows the stream", JSON.stringify(panel));
  if (!panelOk) bad++;
  await cam.close();
}
// Body shaping is shot from a distance: its capture button runs a countdown (cancellable), then
// takes the photo. It has its own standing guide, not the face oval.
{
  const body = await browser.newPage();
  body.on("pageerror", (e) => errors.push(e.message));
  await body.goto(server.resolvedUrls.local[0]);
  await body.waitForFunction(() => !document.getElementById("startBtn").disabled, null, { timeout: 120000 });
  await body.click("#chooseBodyBtn");
  await body.click("#startBtn");
  await body.waitForFunction(() => document.getElementById("overlay").classList.contains("hidden"), null, { timeout: 30000 });
  await body.waitForTimeout(800);
  const ui = () =>
    body.evaluate(() => ({
      bodyGuide: !document.querySelector(".body-guide").hidden,
      faceGuide: !document.querySelector(".face-guide").hidden,
      button: document.querySelector(".capture-photo").textContent,
      counting: !document.querySelector(".capture-countdown").hidden,
      number: document.querySelector(".capture-countdown-number").textContent,
      still: !!document.querySelector(".captured-still"),
    }));
  const idle = await ui();
  const idleOk = idle.bodyGuide && !idle.faceGuide && idle.button === "Start 5-second timer" && !idle.counting;
  console.log(idleOk ? "ok  " : "FAIL", "body camera shows the standing guide and a timer button", JSON.stringify(idle));
  if (!idleOk) bad++;

  await body.click(".capture-photo");
  const running = await ui();
  const runningOk = running.counting && running.number === "5" && running.button === "Cancel" && !running.still;
  console.log(runningOk ? "ok  " : "FAIL", "pressing the button starts the countdown", JSON.stringify(running));
  if (!runningOk) bad++;

  await body.click(".capture-photo"); // Cancel
  await body.waitForTimeout(1500); // no photo may follow a cancelled countdown
  const cancelled = await ui();
  const cancelledOk = !cancelled.counting && cancelled.button === "Start 5-second timer" && !cancelled.still;
  console.log(cancelledOk ? "ok  " : "FAIL", "cancel stops the countdown without taking a photo", JSON.stringify(cancelled));
  if (!cancelledOk) bad++;

  await body.click(".capture-photo");
  await body.waitForFunction(() => document.getElementById("perfBadge").textContent === "PHOTO READY", null, { timeout: 120000 });
  const taken = await ui();
  const takenOk = taken.still && !taken.counting;
  console.log(takenOk ? "ok  " : "FAIL", "the countdown ends by taking the photo", JSON.stringify(taken));
  if (!takenOk) bad++;
  await body.close();
}
// Camera failures must be visible to the user (they used to be swallowed silently).
for (const [errName, expectedText] of [
  ["NotAllowedError", "Allow camera access in your browser settings."],
  ["NotFoundError", "No camera found. Connect a camera and try again."],
  ["NotReadableError", "Camera is busy. Close other camera apps and try again."],
]) {
  const bad_ = await browser.newPage();
  bad_.on("pageerror", (e) => errors.push(e.message));
  await bad_.addInitScript((name) => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("x", name));
  }, errName);
  await bad_.goto(server.resolvedUrls.local[0]);
  await bad_.waitForFunction(() => !document.getElementById("startBtn").disabled, null, { timeout: 120000 });
  await bad_.click("#chooseLipsBtn");
  await bad_.click("#startBtn");
  await bad_.waitForTimeout(500);
  const toast = await bad_.evaluate(() => {
    const t = document.querySelector(".status-toast");
    return { hidden: t.hidden, text: t.textContent, overlayStillUp: !document.getElementById("overlay").classList.contains("hidden") };
  });
  const ok = !toast.hidden && toast.text === expectedText && toast.overlayStillUp;
  console.log(ok ? "ok  " : "FAIL", `${errName} shows: ${toast.text}`);
  if (!ok) bad++;
  // A retry clears the old message.
  await bad_.addInitScript(() => {});
  await bad_.evaluate(() => { navigator.mediaDevices.getUserMedia = () => new Promise(() => {}); });
  await bad_.click("#startBtn");
  await bad_.waitForTimeout(300);
  const cleared = await bad_.evaluate(() => document.querySelector(".status-toast").hidden);
  console.log(cleared ? "ok  " : "FAIL", `${errName}: message clears when the user retries`);
  if (!cleared) bad++;
  await bad_.close();
}
if (errors.length) { console.log("page errors:", errors); bad++; }
await browser.close(); await server.close();
process.exit(bad ? 1 : 0);
