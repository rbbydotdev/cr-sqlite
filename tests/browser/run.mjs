// Playwright runner: start serve.mjs, launch chromium, run benchmarks, print results.
//
// Usage: cd tests && npx playwright install chromium  # first time only
//        node browser/run.mjs

import { spawn } from "node:child_process";
import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8765;

function startServer() {
  const child = spawn("node", [path.join(__dirname, "serve.mjs"), String(PORT)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("server start timeout")), 5000);
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("serving")) {
        clearTimeout(t);
        resolve(child);
      }
    });
    child.stderr.on("data", (chunk) => process.stderr.write(`[server] ${chunk}`));
  });
}

const server = await startServer();
console.log(`server up at http://localhost:${PORT}`);

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();

page.on("console", (msg) => console.log(`[page ${msg.type()}] ${msg.text()}`));
page.on("pageerror", (e) => console.log(`[page error] ${e.message}`));
page.on("requestfailed", (req) =>
  console.log(`[req failed] ${req.url()} ${req.failure()?.errorText ?? ""}`),
);

try {
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: "load" });
  // Auto-run is wired on window.load; wait for results to populate.
  try {
    await page.waitForFunction(() => Array.isArray(window.__BENCH_RESULTS__), null, {
      timeout: 60_000,
    });
  } catch (e) {
    const status = await page.evaluate(() => document.getElementById("status")?.textContent);
    const html = await page.evaluate(() => document.body.innerHTML.slice(0, 800));
    console.error("\nTIMEOUT — status:", status);
    console.error("body snippet:", html);
    throw e;
  }
  const results = await page.evaluate(() => window.__BENCH_RESULTS__);

  console.log("\nbenchmark results (median of 3 runs):");
  console.log("─".repeat(86));
  console.log(
    "scenario".padEnd(36) +
      "median".padStart(10) +
      "min".padStart(7) +
      "max".padStart(7) +
      "rows".padStart(8) +
      "  note",
  );
  console.log("─".repeat(86));
  for (const r of results) {
    const dt = r.dt > 0 ? r.dt.toFixed(1) : "—";
    const min = r.min !== undefined ? r.min.toFixed(0) : "—";
    const max = r.max !== undefined ? r.max.toFixed(0) : "—";
    console.log(
      r.name.slice(0, 36).padEnd(36) +
        String(dt).padStart(10) +
        String(min).padStart(7) +
        String(max).padStart(7) +
        String(r.rows ?? "—").padStart(8) +
        "  " +
        (r.note ?? ""),
    );
  }
  console.log("─".repeat(86));
  const errors = results.filter((r) => /ERROR/.test(r.note ?? ""));
  if (errors.length > 0) {
    console.error(`\nERRORS: ${errors.length}`);
    for (const e of errors) console.error(`  ${e.name}: ${e.note}`);
    process.exitCode = 1;
  }
} finally {
  await browser.close();
  server.kill();
}
