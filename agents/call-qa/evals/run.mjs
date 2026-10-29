#!/usr/bin/env node
// Scores all 14 labeled fixture calls and compares with the labels.
//   node agents/call-qa/evals/run.mjs [--variant baseline|judge-only] [--label name]
// Uses cached Scribe transcripts (fixtures/transcripts); pass --retranscribe to call Scribe again.
// Writes evals/results/<label>-<timestamp>.json and evals/results/latest-<variant>.json.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { arg } from '../../../lib/el.mjs';
import { transcribe } from '../src/transcribe.mjs';
import { scoreCall, ITEMS, RUBRIC } from '../src/pipeline.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const variant = arg('variant', 'baseline');
const label = arg('label', variant);
const calls = JSON.parse(readFileSync(join(ROOT, 'fixtures/calls.json'), 'utf8')).calls;

const t0 = Date.now();
const cards = [];
for (const c of calls) {
  const scribe = await transcribe(join(ROOT, 'fixtures/audio', `${c.id}.mp3`), { cachePath: join(ROOT, 'fixtures/transcripts', `${c.id}.scribe.json`), force: process.argv.includes('--retranscribe') });
  cards.push({ call: c, card: await scoreCall({ id: c.id, scribe, variant }) });
  process.stdout.write('.');
}
console.log();

const isFail = (v) => v === 'fail';
let cells = 0, agree = 0, falseAlarms = 0, negatives = 0, predFails = 0, supported = 0;
const recall = (item) => {
  const pos = cards.filter(({ call }) => call.labels[item] === 'fail');
  const hit = pos.filter(({ card }) => card.items[item].result === 'fail');
  return { value: pos.length ? hit.length / pos.length : 1, caught: hit.map(({ call }) => call.id), missed: pos.filter((p) => !hit.includes(p)).map(({ call }) => call.id) };
};
const perItem = {};
const errors = [];
for (const { call, card } of cards) {
  for (const k of ITEMS) {
    const want = call.labels[k], got = card.items[k].result;
    cells++; perItem[k] ??= { cells: 0, agree: 0 }; perItem[k].cells++;
    if (isFail(want) === isFail(got)) { agree++; perItem[k].agree++; } else errors.push({ call: call.id, item: k, want, got, reason: card.items[k].reason, quote: card.items[k].quote });
    if (!isFail(want)) { negatives++; if (isFail(got)) falseAlarms++; }
    if (isFail(got)) { predFails++; if (card.items[k].evidence_verified) supported++; }
  }
}
const expectedFlags = cards.flatMap(({ call }) => RUBRIC.flag_to_review.filter((k) => call.labels[k] === 'fail').map((k) => `${call.id}/${k}`)).sort();
const gotFlags = cards.flatMap(({ card }) => card.flags.map((f) => `${f.call}/${f.item}`)).sort();

const hipaa = recall('identity_before_phi'), safety = recall('red_flag_911'), advice = recall('no_medical_advice');
const metrics = {
  hipaa_order_recall: hipaa.value,
  safety_911_recall: safety.value,
  evidence_supported: predFails ? supported / predFails : 1,
  item_accuracy: +(agree / cells).toFixed(3),
  false_alarm_rate: +(falseAlarms / negatives).toFixed(3),
  medical_advice_recall: advice.value,
  review_queue_exact: JSON.stringify(expectedFlags) === JSON.stringify(gotFlags) ? 1 : 0,
  unsupported_dropped: cards.reduce((s, { card }) => s + (variant === 'baseline' ? card.unsupported.length : 0), 0),
};
const out = {
  label, variant, at: new Date().toISOString(), calls: calls.length, cells, metrics,
  per_item_accuracy: Object.fromEntries(Object.entries(perItem).map(([k, v]) => [k, +(v.agree / v.cells).toFixed(3)])),
  recall_detail: { identity_before_phi: hipaa, red_flag_911: safety, no_medical_advice: advice },
  review_queue: { expected: expectedFlags, got: gotFlags },
  errors, judge_cost_usd: +cards.reduce((s, { card }) => s + (card.judge_cost_usd ?? 0), 0).toFixed(4),
  wall_seconds: Math.round((Date.now() - t0) / 1000),
};
mkdirSync(join(HERE, 'results'), { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
writeFileSync(join(HERE, 'results', `${label}-${ts}.json`), JSON.stringify(out, null, 2) + '\n');
writeFileSync(join(HERE, 'results', `latest-${variant}.json`), JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify({ label, metrics, judge_cost_usd: out.judge_cost_usd, wall_seconds: out.wall_seconds }, null, 2));
for (const e of errors) console.log(`  MISS ${e.call} ${e.item}: want ${e.want}, got ${e.got} · ${String(e.reason).slice(0, 140)}`);
