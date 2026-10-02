import { chromium } from "playwright";
const url = process.argv[2];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
for (const [choose, sample] of [["#chooseWrinklesBtn", "#wrinklesSampleBtn"], ["#chooseAcneBtn", "#acneSampleBtn"]]) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const warns = []; page.on("console", (m) => { if (/worker/i.test(m.text())) warns.push(m.text()); });
  await page.addInitScript(() => {
    window.__long = [];
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push(e.duration); }).observe({ type: "longtask", buffered: true });
  });
  await page.goto(url);
  await page.waitForFunction(() => !document.getElementById("startBtn").disabled, null, { timeout: 120000 });
  await page.click(choose);
  await page.evaluate(() => (window.__long = []));
  await page.click(sample);
  await page.waitForFunction(() => document.getElementById("perfBadge").textContent === "PHOTO READY" && document.getElementById("faceBadge").classList.contains("detected"), null, { timeout: 120000 });
  await page.waitForTimeout(300); await page.waitForFunction(() => !document.body.dataset.effectsBusy, null, { timeout: 60000 }); await page.waitForTimeout(500);
  const l = await page.evaluate(() => window.__long.map(Math.round).sort((a, b) => b - a).slice(0, 4));
  console.log(choose, "longest main-thread blocks (ms):", l.join(", "), warns.join(" "));
  await page.close();
}
await browser.close();
