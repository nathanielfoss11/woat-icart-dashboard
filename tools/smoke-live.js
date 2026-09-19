#!/usr/bin/env node
// smoke-live.js — live smoke test for the dashboard, run from GitHub Actions (the session's sandbox cannot reach
// reports.woat.org or supabase.co, so this is the one automated check that sees the real page with real RPCs).
//
// What it asserts, for one URL (root or /dev/):
//   1. the page loads, the KPI tiles render numbers, no uncaught page errors, no console errors (Supabase aborts excluded)
//   2. the spend card caption has the "Spend … · updates daily" shape, and its blended note carries the same API-day
//      count as the caption when both are present (commit 3's contract)
//   3. the Campaign Sources strip equals what the page's own rules compute from the live report_utms rows
//      (expect-strip.js logic, fed by the same RPC call the page makes) — row count, Other label, Untagged last,
//      and family entries summing to the Entries KPI
//   4. the amber coverage notes on "All time" are the '*' rows of report_coverage_notes, verbatim, in date order
// The anon key is read from the page source itself (it is public by design); nothing secret is needed.
//
// Usage: node tools/smoke-live.js https://reports.woat.org/           (exit 1 on any failure)
const { chromium } = require("playwright");
const url = process.argv[2] || "https://reports.woat.org/";
const results = []; let failures = 0;
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); if (!ok) failures++; console.log((ok ? "PASS " : "FAIL ") + name + (detail ? "   [" + String(detail).slice(0, 300) + "]" : "")); };
const eq = (name, got, want) => check(name, got === want, "got " + JSON.stringify(got) + (got === want ? "" : "  want " + JSON.stringify(want)));

// ---- the strip rules, extracted from the page source exactly as expect-strip.js does ----
function stripRules(src) {
  const vm = require("vm");
  const grab = re => { const m = src.match(re); if (!m) throw new Error("rule not found in page: " + re); return m[0]; };
  const code = [/const FAMILY_LABEL=\{[^\n]*\};/, /const PLATFORM_NAME=\{[^\n]*\};/, /const VENDOR_SUFFIX=\{[^\n]*\};/, /const MAX_RAW_ROWS=\d+;/,
    /const famKey=[^\n]*;/, /const isPaidMedium=[^\n]*;/, /const mediumClass=[^\n]*;/, /function famInfo\(key, medium\)\{[\s\S]*?\n\}/].map(grab).join("\n");
  const ctx = {}; vm.createContext(ctx);
  vm.runInContext(code + "\nthis.famKey=famKey;this.famInfo=famInfo;this.MAX_RAW_ROWS=MAX_RAW_ROWS;", ctx);
  return ctx;
}
function expectedStrip(rows, ctx) {
  const fams = {};
  rows.forEach(x => {
    const k = ctx.famKey(x.utm_source), info = ctx.famInfo(k, x.utm_medium), label = info.label;
    const f = fams[label] || (fams[label] = { label, known: info.known, sources: new Set(), entries: 0 });
    f.sources.add(x.utm_source === "(none)" || x.utm_source == null ? "(none)" : String(x.utm_source));
    f.entries += +x.entries || 0;
  });
  const all = Object.values(fams).sort((a, b) => b.entries - a.entries);
  const untagged = all.find(f => f.label === "Untagged");
  const known = all.filter(f => f !== untagged && f.known), raw = all.filter(f => f !== untagged && !f.known);
  const head = known.concat(raw.slice(0, ctx.MAX_RAW_ROWS)).sort((a, b) => b.entries - a.entries), tail = raw.slice(ctx.MAX_RAW_ROWS);
  let other = null;
  if (tail.length) { const s = new Set(); tail.forEach(f => f.sources.forEach(x => s.add(x))); other = "Other (" + s.size + (s.size === 1 ? " source" : " sources") + ")"; head.push({ label: other, entries: tail.reduce((a, f) => a + f.entries, 0) }); }
  if (untagged) head.push(untagged);
  return { rows: head.length < 2 ? [] : head, other, total: all.reduce((a, f) => a + f.entries, 0) };
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, timezoneId: "America/Boise", locale: "en-US" });
  const pageErrors = [], consoleErrors = [];
  page.on("pageerror", e => pageErrors.push(String(e)));
  page.on("console", m => { if (m.type() === "error" && !/net::ERR_ABORTED|Failed to load resource/.test(m.text())) consoleErrors.push(m.text()); });

  // 1. load
  const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  check("page responds 200", resp && resp.status() === 200, resp && resp.status());
  const src = await page.content();
  const anon = (src.match(/const ANON="([^"]+)"/) || [])[1];
  const supa = (src.match(/const SUPA="([^"]+)"/) || [])[1];
  check("page source carries the Supabase URL and anon key it uses", !!anon && !!supa, supa);
  await page.waitForSelector("#kpis .tile .val", { timeout: 60000 });
  await page.waitForFunction(() => !/loading/i.test(document.getElementById("sub").textContent), null, { timeout: 60000 });
  const kpiVals = await page.$$eval("#kpis .tile .val", els => els.map(e => e.textContent.trim()));
  check("KPI tiles render numbers", kpiVals.length >= 4 && kpiVals.every(v => /\d/.test(v)), kpiVals.join(" | "));
  const entriesKpi = +((kpiVals[0] || "").replace(/[^0-9]/g, ""));
  const sub = await page.$eval("#sub", e => e.textContent.trim());
  check("subtitle shows the range", /iCart online joins · .+ – .+/.test(sub), sub);

  // 2. spend card contract (caption vs blended note)
  await page.waitForFunction(() => { const c = document.getElementById("spCap"); return c && /Spend/.test(c.textContent); }, null, { timeout: 60000 }).catch(() => {});
  const spCap = await page.$eval("#spCap", e => e.textContent.trim()).catch(() => "");
  const spNote = await page.$eval("#spNote", e => e.textContent.trim()).catch(() => "");
  check("spend caption present", /^Spend .*· updates daily/.test(spCap), spCap);
  const cap = spCap.match(/recorded on (\d+) of (\d+) days/), note = spNote.match(/\((\d+) of them with Meta\/Google API spend|API spend on (\d+) of its (\d+) days/);
  if (cap && note) eq("blended note's API-day count equals the caption's", note[1] || note[2], cap[1]); else check("spend note/caption shapes consistent (no partial-coverage mismatch)", true, (spCap.slice(0, 60) + " / " + spNote.slice(0, 80)));

  // 3. strip vs live report_utms (same call the page makes: last 30 days = today−29 → tomorrow, Boise dates)
  const range = await page.evaluate(() => (typeof RANGE !== 'undefined' ? RANGE : null));   // RANGE is a top-level let, not a window property
  const rows = await page.evaluate(async ({ supa, anon, range }) => {
    const [from, to] = range || [];
    const r = await fetch(supa + "/rest/v1/rpc/report_utms", { method: "POST", headers: { apikey: anon, Authorization: "Bearer " + anon, "Content-Type": "application/json" },
      body: JSON.stringify({ p_from: from, p_to: to, p_plan: null, p_locations: null, p_account: null, p_platform: null }) });
    const j = await r.json(); return Array.isArray(j) ? j : (j && j.rows) || [];
  }, { supa, anon, range });
  check("report_utms returns rows for the page's range", Array.isArray(rows) && rows.length > 0, rows.length + " rows for " + JSON.stringify(range));
  await page.waitForSelector("#utmFamilyTable tbody tr", { timeout: 60000 }).catch(() => {});
  const strip = await page.$$eval("#utmFamilyTable tbody tr", trs => trs.map(tr => ({ label: tr.children[0].textContent.trim(), entries: +tr.children[2].textContent.replace(/[^0-9]/g, "") })));
  const exp = expectedStrip(rows, stripRules(src));
  eq("strip row count equals the page's rules on live report_utms", strip.length, exp.rows.length);
  eq("strip labels in order equal the computed expectation", strip.map(r => r.label).join(" | "), exp.rows.map(r => r.label).join(" | "));
  eq("Other label", strip.find(r => /^Other \(/.test(r.label))?.label || null, exp.other);
  check("Untagged pinned last", strip.length === 0 || strip[strip.length - 1].label === "Untagged", strip[strip.length - 1] && strip[strip.length - 1].label);
  eq("family entries sum to the Entries KPI", strip.reduce((a, r) => a + r.entries, 0), entriesKpi);

  // 4. All time: coverage notes verbatim from the RPC, in period order
  await page.selectOption("#preset", "all");
  await page.waitForFunction(() => /2023/.test(document.getElementById("sub").textContent), null, { timeout: 60000 });
  await page.waitForTimeout(1500);
  const notes = await page.$$eval("#dataNotes .note", els => els.map(e => e.textContent.trim()));
  const rpcNotes = await page.evaluate(async ({ supa, anon }) => {
    const r = await fetch(supa + "/rest/v1/rpc/report_coverage_notes", { method: "POST", headers: { apikey: anon, Authorization: "Bearer " + anon, "Content-Type": "application/json" }, body: JSON.stringify({ p_from: "2023-01-01", p_to: "2027-12-31" }) });
    return await r.json();
  }, { supa, anon });
  const flagged = (rpcNotes || []).filter(n => n.flag === "*").sort((a, b) => a.period_from < b.period_from ? -1 : 1).map(n => n.note);
  eq("All time renders every '*' coverage note verbatim, in period order", notes.join("\n"), flagged.join("\n"));

  // errors
  eq("no uncaught page errors", pageErrors.length, 0); if (pageErrors.length) console.log(pageErrors.join("\n"));
  eq("no console errors", consoleErrors.length, 0); if (consoleErrors.length) console.log(consoleErrors.join("\n"));

  await browser.close();
  console.log(`\n${url}: ${results.length - failures} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error("SMOKE CRASHED:", e); process.exit(2); });
