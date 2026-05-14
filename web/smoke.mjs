// @ts-nocheck — uses sibling-package playwright; not part of any tsconfig.
// Smoke-check the FUGUE collaborative-text demo against a running server.
// Drives the actual user flow: type → sync → offline → divergence → reconnect.
//
// Run: node smoke.mjs  (uses ../tests/node_modules/playwright)

import { chromium } from "../tests/node_modules/playwright/index.mjs";

const URL = process.env.URL ?? "http://localhost:8787/";
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

const errors = [];
const warns = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
  else if (m.type() === "warning") warns.push(m.text());
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("requestfailed", (req) => errors.push(`reqfailed: ${req.url()} ${req.failure()?.errorText ?? ""}`));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function readBodies() {
  return page.evaluate(() => {
    return Array.from(document.querySelectorAll(".peer")).map((el) => ({
      letter: el.dataset.peer,
      online: !el.classList.contains("offline"),
      pending: el.querySelector(".pending")?.hidden ? 0 : Number((el.querySelector(".pending")?.textContent ?? "0").match(/\d+/)?.[0] ?? 0),
      body: el.querySelector(".editor").value,
      rows: Number(el.querySelector(".rows-summary").textContent.match(/\d+/)?.[0] ?? 0),
    }));
  });
}

async function setOnline(letter, online) {
  await page.evaluate(({ l, on }) => {
    const card = document.querySelector(`.peer[data-peer="${l}"]`);
    const cb = card.querySelector(".online-cb");
    if (cb.checked !== on) {
      cb.checked = on;
      cb.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }, { l: letter, on: online });
}

try {
  await page.goto(URL, { waitUntil: "load" });
  await page.waitForFunction(() => document.querySelectorAll(".peer").length >= 2, null, { timeout: 15_000 });

  // ── step 1: boot — 2 peers, online, empty, no errors ────────────
  let snap = await readBodies();
  console.log("boot:", JSON.stringify(snap));

  await page.screenshot({ path: "/tmp/fugue-demo-boot.png", fullPage: false });

  // ── step 2: type into A → expect B to converge ──────────────────
  await page.focus(`.peer[data-peer="A"] .editor`);
  await page.keyboard.type("hello world ");
  await wait(1500);
  snap = await readBodies();
  console.log("after A types 'hello world ':", JSON.stringify(snap));

  const afterTypeA = snap.find((p) => p.letter === "A");
  const afterTypeB = snap.find((p) => p.letter === "B");
  const sync1Ok =
    afterTypeA.body === "hello world " &&
    afterTypeB.body === "hello world ";

  // ── step 3: toggle B offline, type more into A ──────────────────
  await setOnline("B", false);
  await wait(200);
  await page.focus(`.peer[data-peer="A"] .editor`);
  await page.keyboard.type("(while B offline) ");
  await wait(1500);
  snap = await readBodies();
  console.log("A typed while B offline:", JSON.stringify(snap));

  const offlineA = snap.find((p) => p.letter === "A");
  const offlineB = snap.find((p) => p.letter === "B");
  const offlineOk =
    offlineA.body === "hello world (while B offline) " &&
    offlineB.body === "hello world " &&
    offlineB.online === false;

  // ── step 4: type into offline B → expect pending counter ────────
  await page.focus(`.peer[data-peer="B"] .editor`);
  await page.keyboard.press("End");
  await page.keyboard.type("[B was offline] ");
  await wait(800);
  snap = await readBodies();
  console.log("B typed offline:", JSON.stringify(snap));
  const localB = snap.find((p) => p.letter === "B");
  const pendingOk = localB.body.includes("[B was offline]") && localB.pending > 0;

  await page.screenshot({ path: "/tmp/fugue-demo-offline.png", fullPage: false });

  // ── step 5: reconnect B → expect both peers to converge ─────────
  await setOnline("B", true);
  await wait(3000);
  snap = await readBodies();
  console.log("after B reconnects:", JSON.stringify(snap));
  const inspA = await page.evaluate(() => window.__inspect("A"));
  const inspB = await page.evaluate(() => window.__inspect("B"));
  console.log("inspect A:", JSON.stringify(inspA, null, 2));
  console.log("inspect B:", JSON.stringify(inspB, null, 2));

  const finalA = snap.find((p) => p.letter === "A");
  const finalB = snap.find((p) => p.letter === "B");
  const converged =
    finalA.body === finalB.body &&
    finalA.body.includes("hello world") &&
    finalA.body.includes("(while B offline)") &&
    finalA.body.includes("[B was offline]") &&
    finalB.online === true &&
    finalB.pending === 0;

  await page.screenshot({ path: "/tmp/fugue-demo-converged.png", fullPage: false });

  // ── results ─────────────────────────────────────────────────────
  console.log("\nresults:");
  console.log(`  step 2 — sync while online:    ${sync1Ok ? "PASS" : "FAIL"}`);
  console.log(`  step 3 — A diverges, B frozen: ${offlineOk ? "PASS" : "FAIL"}`);
  console.log(`  step 4 — B pending counter:    ${pendingOk ? "PASS" : "FAIL"}`);
  console.log(`  step 5 — reconnect converges:  ${converged ? "PASS" : "FAIL"}`);
  console.log(`  errors: ${errors.length}, warns: ${warns.length}`);
  for (const e of errors.slice(0, 8)) console.log("    err: " + e);

  const ok = sync1Ok && offlineOk && pendingOk && converged && errors.filter((e) => !/favicon/i.test(e)).length === 0;
  if (!ok) { console.error("\nSMOKE FAIL"); process.exitCode = 1; }
  else { console.log("\nSMOKE OK"); }
} finally {
  await browser.close();
}
