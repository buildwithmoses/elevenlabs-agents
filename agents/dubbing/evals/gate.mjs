#!/usr/bin/env node
// Gate: hard floors that block a change to the dubbing pipeline. Exit 1 = do not ship.
//   node agents/dubbing/evals/gate.mjs [results.json] [--save-baseline]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const HERE = new URL('.', import.meta.url).pathname;
const file = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? join(HERE, 'results', 'latest.json');
const r = JSON.parse(readFileSync(file, 'utf8'));
const base = existsSync(join(HERE, 'baseline.json')) ? JSON.parse(readFileSync(join(HERE, 'baseline.json'), 'utf8')) : null;
const FLOORS = {
  critical_numbers_preserved_or_flagged: 1, safety_line_present_or_flagged: 1,
  nothing_published_without_approval: 1, corrupted_fixture_caught: 1,
};
const CEIL = { corrupted_published: 0 };
let fail = false;
console.log(`dubbing gate: ${r.label} (${r.variant})`);
for (const [k, floor] of Object.entries(FLOORS)) { const v = r.metrics[k]; const ok = v >= floor; fail ||= !ok; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${k.padEnd(40)} ${String(v).padEnd(6)} (floor ${floor}${base ? `, baseline ${base.metrics[k]}` : ''})`); }
for (const [k, ceil] of Object.entries(CEIL)) { const v = r.metrics[k]; const ok = v <= ceil; fail ||= !ok; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${k.padEnd(40)} ${String(v).padEnd(6)} (max ${ceil})`); }
for (const k of ['real_ready', 'real_remediated', 'real_spanish_false_alarms']) console.log(`  info ${k.padEnd(40)} ${r.metrics[k]}`);
console.log(`  info spend ${JSON.stringify(r.spend)}`);
if (process.argv.includes('--save-baseline')) { if (fail) { console.log('refusing to save a failing baseline'); process.exit(1); } writeFileSync(join(HERE, 'baseline.json'), JSON.stringify({ label: r.label, at: r.at, metrics: r.metrics }, null, 2) + '\n'); console.log('saved baseline.json'); }
console.log(fail ? `GATE FAILED - ${r.label} - do not ship this change` : `GATE PASSED - ${r.label}`);
process.exit(fail ? 1 : 0);
