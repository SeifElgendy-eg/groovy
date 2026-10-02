// UI smoke test: service switching, headers, sample-button labels, reset behaviour.
import { chromium } from "playwright";
import { preview } from "vite";
const server = await preview({ preview: { host: "127.0.0.1", port: 0, open: false } });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
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
if (errors.length) { console.log("page errors:", errors); bad++; }
await browser.close(); await server.close();
process.exit(bad ? 1 : 0);
