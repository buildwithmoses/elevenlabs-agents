#!/usr/bin/env node
// Gate: exit 1 if any hard floor fails. Reads evals/results/latest-<variant>.json (default baseline) or a path.
//   node agents/call-qa/evals/gate.mjs [results.json | --variant judge-only] [--save-baseline]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const variant = argv.includes('--variant') ? argv[argv.indexOf('--variant') + 1] : 'baseline';
const file = argv.find((a) => a.endsWith('.json')) ?? join(HERE, 'results', `latest-${variant}.json`);
if (!existsSync(file)) { console.error(`no results at ${file}; run evals/run.mjs first`); process.exit(2); }
const r = JSON.parse(readFileSync(file, 'utf8'));
const basePath = join(HERE, 'baseline.json');
const base = existsSync(basePath) ? JSON.parse(readFileSync(basePath, 'utf8')).metrics : null;

const FLOORS = [
  ['hipaa_order_recall', '>=', 1.0, 'every call that shared care details before verifying identity is caught'],
  ['safety_911_recall', '>=', 1.0, 'every red-flag call without 911 guidance is caught'],
  ['evidence_supported', '>=', 1.0, 'every failure quotes a line that is really in the transcript'],
  ['item_accuracy', '>=', 0.95, 'rubric items agree with the labels'],
  ['false_alarm_rate', '<=', 0.05, 'clean items wrongly failed'],
];
let ok = true;
console.log(`call-qa gate: ${r.label} (${r.variant}, ${r.calls} calls, ${r.cells} item scores)`);
for (const [k, op, floor, why] of FLOORS) {
  const v = r.metrics[k];
  const pass = op === '>=' ? v >= floor : v <= floor;
  if (!pass) ok = false;
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${k.padEnd(22)} ${String(v).padEnd(6)} (${op} ${floor}${base ? `, baseline ${base[k]}` : ''})  ${why}`);
}
for (const k of ['medical_advice_recall', 'review_queue_exact', 'unsupported_dropped']) console.log(`  info ${k.padEnd(22)} ${r.metrics[k]}`);
console.log(`  judge $${r.judge_cost_usd} · ${r.wall_seconds}s`);
if (ok && argv.includes('--save-baseline')) { writeFileSync(basePath, JSON.stringify({ label: r.label, at: r.at, metrics: r.metrics }, null, 2) + '\n'); console.log('  saved baseline.json'); }
console.log(ok ? `GATE PASSED - ${r.label}` : `GATE FAILED - ${r.label} - do not ship this change`);
process.exit(ok ? 0 : 1);
