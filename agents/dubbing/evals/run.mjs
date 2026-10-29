#!/usr/bin/env node
// Dubbing evals: run the full pipeline on the 6 real dubs plus 9 deliberately corrupted transcripts,
// let a simulated Dr. Ruiz approve everything the packets mark ready (a rubber stamp, on purpose, so the
// SYSTEM has to protect patients), attack the approval rules, then publish.
//   node agents/dubbing/evals/run.mjs [--variant no-fact-check] [--label baseline]
// Writes agents/dubbing/evals/results/<label>-<ts>.json and latest.json (gate.mjs reads latest.json).
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, copyFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { arg } from '../../../lib/el.mjs';

const variant = arg('variant', 'baseline');
const label = arg('label', variant);
const HERE = new URL('..', import.meta.url).pathname;
const WORK = join(HERE, 'media/out', `eval-${variant}`);
rmSync(WORK, { recursive: true, force: true }); mkdirSync(WORK, { recursive: true });
process.env.DUB_WORK = WORK;                     // pipeline/approve/publish read it at import time
const { qaDub, spec, spend } = await import('../scripts/pipeline.mjs');
const { approve } = await import('../scripts/approve.mjs');
const { publish } = await import('../scripts/publish.mjs');
const { APPROVER } = await import('../src/review.js');
const t0 = Date.now();

// 1. Real dubs.
const real = [];
for (const v of spec.videos) for (const l of spec.languages) real.push(await qaDub(`${v.id}.${l.code}`, { variant, writePacket: variant === 'baseline' }));

// 2. Corrupted transcripts (built from the transcript of the version each real dub would ship).
const corrupted = [];
for (const c of JSON.parse(readFileSync(join(HERE, 'fixtures/corrupted.json'), 'utf8')).cases) {
  const baseQa = real.find((r) => r.key === c.base);
  const src = JSON.parse(readFileSync(join(HERE, 'fixtures/transcripts', `${c.base}${existsSync(join(HERE, 'fixtures/transcripts', `${c.base}.revoiced.json`)) ? '.revoiced' : ''}.json`), 'utf8'));
  let text = src.text;
  for (const [a, b] of c.replace) { if (!text.includes(a)) throw new Error(`${c.id}: "${a}" not in ${c.base} transcript`); text = text.replace(a, b); }
  const qa = await qaDub(c.base, { variant, heardOverride: { text, words: [] }, fileOverride: join(HERE, baseQa.candidate_file), writePacket: false, recordKey: c.id });
  corrupted.push({ ...qa, expect: c.expect, caught: qa.status === 'blocked' && qa.issues.some((i) => c.expect.includes(i.code)) });
}
const all = [...real, ...corrupted];

// 3. Attacks on the approval rules, before anyone approves.
const attacks = [];
const tryAttack = (name, fn, mustFail = true) => { const r = fn(); attacks.push({ name, refused: !r.ok, ok: mustFail ? !r.ok : r.ok, reason: r.reason ?? null }); };
tryAttack('publish with no approval', () => publish(real[0].key));
tryAttack('approval by the front desk manager', () => approve({ key: real[0].key, approver: 'Marcus Bell' }));
const blocked = all.find((r) => r.status === 'blocked');
if (blocked) tryAttack(`approve a blocked dub (${blocked.key})`, () => approve({ key: blocked.key, approver: APPROVER }));
//    tamper: approve a copy, then change one byte, then try to publish it
const tq = { ...real[0], key: 'tamper-test', candidate_file: join('media/out', `eval-${variant}`, 'tamper.mp4') };
copyFileSync(join(HERE, real[0].candidate_file), join(HERE, tq.candidate_file));
mkdirSync(join(WORK, 'qa'), { recursive: true }); writeFileSync(join(WORK, 'qa', 'tamper-test.json'), JSON.stringify(tq));
const ta = approve({ key: 'tamper-test', approver: APPROVER });
appendFileSync(join(HERE, tq.candidate_file), Buffer.from([0]));
tryAttack('publish a file changed after approval', () => (ta.ok ? publish('tamper-test') : { ok: false, reason: 'approval itself refused' }));

// 4. Simulated Dr. Ruiz approves everything marked ready; then publish everything.
const approved = new Set();
for (const r of all) if (r.status === 'ready_for_review') { const a = approve({ key: r.key, approver: APPROVER }); if (a.ok) approved.add(r.key); }
const published = all.map((r) => publish(r.key)).filter((p) => p.ok).map((p) => p.key);

// 5. Metrics.
const NUM = ['sets', 'reps', 'hold_seconds', 'rest_seconds', 'times_per_day'];
const factsOk = (kinds) => { const fs = all.flatMap((r) => r.facts.filter((f) => kinds.includes(f.kind)).map((f) => f.found === true || f.flagged)); return fs.filter(Boolean).length / fs.length; };
const metrics = {
  critical_numbers_preserved_or_flagged: +factsOk(NUM).toFixed(3),
  safety_line_present_or_flagged: +factsOk(['safety']).toFixed(3),
  nothing_published_without_approval: (published.every((k) => approved.has(k)) && attacks.every((a) => a.ok)) ? 1 : 0,
  corrupted_fixture_caught: +(corrupted.filter((c) => c.caught).length / corrupted.length).toFixed(3),
  corrupted_published: corrupted.filter((c) => published.includes(c.key)).length,
  real_ready: real.filter((r) => r.status === 'ready_for_review').length,
  real_remediated: real.filter((r) => r.remediated).length,
  real_spanish_false_alarms: real.filter((r) => r.lang === 'es' && r.status === 'blocked').length,
};
const out = {
  label, variant, at: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000), metrics, spend: spend(),   // ElevenLabs bills dubbing/STT/TTS in credits; see README for the build's total (the account counter lags, so per-run deltas are unreliable)
  attacks, real: real.map((r) => ({ key: r.key, status: r.status, remediated: r.remediated, issues: r.issues.map((i) => i.code), intelligibility: r.intelligibility })),
  corrupted: corrupted.map((c) => ({ key: c.key, status: c.status, caught: c.caught, expect: c.expect, issues: c.issues.map((i) => `${i.code}: ${i.detail}`), published: published.includes(c.key) })),
  published,
};
const ts = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
mkdirSync(join(HERE, 'evals/results'), { recursive: true });
writeFileSync(join(HERE, 'evals/results', `${label}-${ts}.json`), JSON.stringify(out, null, 2) + '\n');
writeFileSync(join(HERE, 'evals/results', 'latest.json'), JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify({ label, metrics, spend: out.spend, attacks: attacks.map((a) => `${a.ok ? 'ok ' : 'FAIL'} ${a.name}`) }, null, 2));
for (const c of out.corrupted) console.log(`${c.caught ? 'caught ' : 'MISSED '} ${c.key.padEnd(26)} ${c.status.padEnd(17)} ${c.issues.slice(0, 2).join(' | ')}`);
