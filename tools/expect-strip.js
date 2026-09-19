#!/usr/bin/env node
// expect-strip.js — derive the EXPECTED "By source family" strip from the page's own input, using the page's own
// rules. The rules (FAMILY_LABEL / PLATFORM_NAME / VENDOR_SUFFIX / MAX_RAW_ROWS / famKey / famInfo / isPaidMedium /
// mediumClass) are extracted verbatim from index.html so this cannot drift from the code, and the grouping /
// fold / ordering below is the same algorithm as renderUtmFamilies(), including how ties are ordered.
//
// INPUT MUST BE report_utms OUTPUT — the rows the page actually receives — not a raw checkouts query.
// report_utms dedups per person (lower(btrim(email))) BEFORE grouping, so a source that only ever appears on
// a person who also has a "real" row (a test tag, say) is absent from its output while present in raw data.
// 2026-09-18: a raw-count list predicted "Other (3 sources)"; the page showed "Other (2 sources)" because
// `deploytest` had been collapsed by the dedup. Feeding the RPC output removes that class of error.
//
// Get the input from the RPC or the MCP (`icart_get_campaign_sources`, same RPC, same dedup) for the SAME
// range the page requests — "Last 30 days" is (today−29 → tomorrow), local dates.
//
// Usage:  node expect-strip.js index.html report_utms.json
//   report_utms.json: the RPC's JSON array, or the MCP's {"rows":[...]} wrapper. Row fields used:
//   utm_source, utm_medium, entries (joins/lost_joins/join_contract_value are summed when present).
//   Rows are taken IN FILE ORDER — the page consumes them in RPC order and the sort is stable, so the order
//   of equal-entry families (which raw source gets the 4th row vs folds into Other) depends on it.
const fs = require("fs"), vm = require("vm");
const [html, list] = process.argv.slice(2);
if (!html || !list) { console.error("usage: node expect-strip.js index.html report_utms.json"); process.exit(2); }
const src = fs.readFileSync(html, "utf8");
const grab = re => { const m = src.match(re); if (!m) throw new Error("rule not found in page: " + re); return m[0]; };
const code = [
  grab(/const FAMILY_LABEL=\{[^\n]*\};/),
  grab(/const PLATFORM_NAME=\{[^\n]*\};/),
  grab(/const VENDOR_SUFFIX=\{[^\n]*\};/),
  grab(/const MAX_RAW_ROWS=\d+;/),
  grab(/const famKey=[^\n]*;/),
  grab(/const isPaidMedium=[^\n]*;/),
  grab(/const mediumClass=[^\n]*;/),
  grab(/function famInfo\(key, medium\)\{[\s\S]*?\n\}/),
].join("\n");
const ctx = {}; vm.createContext(ctx);
vm.runInContext(code + "\nthis.famKey=famKey;this.famInfo=famInfo;this.MAX_RAW_ROWS=MAX_RAW_ROWS;", ctx);

let input = JSON.parse(fs.readFileSync(list, "utf8"));
if (input && !Array.isArray(input) && Array.isArray(input.rows)) input = input.rows;
if (!Array.isArray(input)) { console.error("input must be a JSON array of report_utms rows or {rows:[...]}"); process.exit(2); }
// accept the older hand-written shape too ({source, medium, entries})
const rows = input.map(r => ({ utm_source: r.utm_source !== undefined ? r.utm_source : r.source, utm_medium: r.utm_medium !== undefined ? r.utm_medium : r.medium,
  entries: +r.entries || 0, joins: +r.joins || 0, lost: +(r.lost_joins !== undefined ? r.lost_joins : r.lost) || 0, value: +r.join_contract_value || 0 }));

// ---- same algorithm as renderUtmFamilies() ----
const fams = {};
rows.forEach(x => {
  const k = ctx.famKey(x.utm_source), info = ctx.famInfo(k, x.utm_medium), label = info.label;
  const f = fams[label] || (fams[label] = { label, known: info.known, sources: new Set(), entries: 0, joins: 0, lost: 0, value: 0 });
  f.sources.add(x.utm_source === "(none)" || x.utm_source == null ? "(none)" : String(x.utm_source));
  f.entries += x.entries; f.joins += x.joins; f.lost += x.lost; f.value += x.value;
});
const all = Object.values(fams).sort((a, b) => b.entries - a.entries);          // stable: ties keep first-appearance order
const totalEntries = all.reduce((a, f) => a + f.entries, 0);
const untagged = all.find(f => f.label === "Untagged");
const known = all.filter(f => f !== untagged && f.known), raw = all.filter(f => f !== untagged && !f.known);
const head = known.concat(raw.slice(0, ctx.MAX_RAW_ROWS)).sort((a, b) => b.entries - a.entries), tail = raw.slice(ctx.MAX_RAW_ROWS);
if (tail.length) {
  const o = { label: "", sources: new Set(), entries: 0, joins: 0, lost: 0, value: 0, other: true };
  tail.forEach(f => { f.sources.forEach(s => o.sources.add(s)); o.entries += f.entries; o.joins += f.joins; o.lost += f.lost; o.value += f.value; });
  o.label = "Other (" + o.sources.size + (o.sources.size === 1 ? " source" : " sources") + ")";
  head.push(o);
}
if (untagged) head.push(untagged);

// ---- report ----
const pct = n => (Math.round(n * 10) / 10).toFixed(1) + "%";
console.log(`Input: ${rows.length} report_utms rows, ${totalEntries.toLocaleString("en-US")} entries (must equal the Entries KPI tile for the same range)`);
console.log(`Rules from page: MAX_RAW_ROWS = ${ctx.MAX_RAW_ROWS}; ${known.length} recognised families, ${raw.length} unrecognised raw sources → ${Math.min(raw.length, ctx.MAX_RAW_ROWS)} own rows${tail.length ? `, ${tail.length} fold into Other` : ", nothing folds"}`);
if (head.length < 2) { console.log("\nStrip HIDDEN (fewer than two families)."); process.exit(0); }
console.log(`\nEXPECTED STRIP — ${head.length} rows, in display order:`);
console.log("  #   Source family                 Raw sources                          Entries   Share   Joins  Conv.");
head.forEach((f, i) => {
  const srcs = f.label === "Untagged" ? "—" : [...f.sources].sort().join(", ");
  console.log(`  ${String(i + 1).padStart(2)}  ${f.label.padEnd(29)} ${srcs.padEnd(36)} ${String(f.entries).padStart(7)}  ${pct(f.entries / totalEntries * 100).padStart(6)}  ${String(f.joins).padStart(6)}  ${(f.entries ? pct(f.joins / f.entries * 100) : "—").padStart(6)}`);
});
if (tail.length) console.log(`\nOther tooltip: ${[...head.find(f => f.other).sources].sort().join(", ")}`);
const tied = raw.length > ctx.MAX_RAW_ROWS && raw[ctx.MAX_RAW_ROWS - 1].entries === raw[ctx.MAX_RAW_ROWS].entries;
if (tied) console.log(`Note: the last raw row and the first folded source are tied at ${raw[ctx.MAX_RAW_ROWS].entries} entries — which one shows depends on RPC row order (first-appearance wins), as on the page.`);
console.log(`\nCheck on the page: ${head.length} rows; ${tail.length ? `"${head.find(f => f.other).label}"` : "no Other row"}; Untagged ${untagged ? "last" : "absent"}; family entries sum to ${totalEntries.toLocaleString("en-US")}.`);
