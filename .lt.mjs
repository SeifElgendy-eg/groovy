import { chromium } from "playwright";
const url = process.argv[2];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
const out = [];
for (const [choose, sample] of [["#chooseWrinklesBtn", "#wrinklesSampleBtn"], ["#chooseAcneBtn", "#acneSampleBtn"]]) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const warns = []; page.on("console", (m) => { if (/worker/i.test(m.text())) warns.push(m.text()); });
  await page.goto(url);
  await page.waitForFunction(() => !document.getElementById("startBtn").disabled, null, { timeout: 120000 });
  await page.click(choose); await page.click(sample);
  await page.waitForFunction(() => document.getElementById("perfBadge").textContent === "PHOTO READY" && document.getElementById("faceBadge").classList.contains("detected"), null, { timeout: 120000 });
  await page.waitForTimeout(300); await page.waitForFunction(() => !document.body.dataset.effectsBusy, null, { timeout: 60000 }); await page.waitForTimeout(300);
  // Re-trigger only the effect preparation (same photo) and watch the main thread.
  const r = await page.evaluate(async (preset) => {
    const longest = { ms: 0 };
    const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) longest.ms = Math.max(longest.ms, e.duration); });
    po.observe({ entryTypes: ["longtask"] });
    const t0 = performance.now();
    // Toggling the debug mask re-renders; a module switch would refetch. Force a re-prepare via a new photo-size-equal path:
    document.querySelector(preset).click();
    await new Promise((r) => setTimeout(r, 50));
    while (document.body.dataset.effectsBusy) await new Promise((r) => setTimeout(r, 20));
    const total = performance.now() - t0;
    po.disconnect();
    return { total: Math.round(total), longestTask: Math.round(longest.ms) };
  }, choose === "#chooseAcneBtn" ? "[data-acne-preset='100']" : "[data-wrinkles-preset]");
  out.push(`${choose.replace("#choose", "").replace("Btn", "")}: ${JSON.stringify(r)} ${warns.join(" ")}`);
  await page.close();
}
console.log(out.join("\n"));
await browser.close();
