#!/usr/bin/env node
// Score calls end to end and write reports + Hannah's review queue.
//   node agents/call-qa/run.mjs                       all fixture calls (cached transcripts)
//   node agents/call-qa/run.mjs --audio path/to.mp3   any recorded call (transcribed with Scribe)
//   node agents/call-qa/run.mjs --calls c02,c07 [--variant judge-only]
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { arg } from '../../lib/el.mjs';
import { transcribe } from './src/transcribe.mjs';
import { scoreCall, toMarkdown } from './src/pipeline.mjs';
import { addFlags } from './src/review-queue.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const variant = arg('variant', 'baseline');
const outDir = join(HERE, 'reports'); mkdirSync(outDir, { recursive: true });
let jobs;
if (arg('audio')) {
  const p = String(arg('audio')); const id = basename(p).replace(/\.[^.]+$/, '');
  jobs = [{ id, audio: p, cache: join(outDir, `${id}.scribe.json`) }];
} else {
  const calls = JSON.parse(readFileSync(join(HERE, 'fixtures/calls.json'), 'utf8')).calls;
  const only = arg('calls') ? String(arg('calls')).split(',') : null;
  jobs = calls.filter((c) => !only || only.includes(c.id)).map((c) => ({ id: c.id, audio: join(HERE, 'fixtures/audio', `${c.id}.mp3`), cache: join(HERE, 'fixtures/transcripts', `${c.id}.scribe.json`) }));
}
let cost = 0;
for (const j of jobs) {
  const scribe = await transcribe(j.audio, { cachePath: j.cache });
  const card = await scoreCall({ id: j.id, scribe, variant });
  cost += card.judge_cost_usd;
  writeFileSync(join(outDir, `${j.id}.json`), JSON.stringify(card, null, 2) + '\n');
  writeFileSync(join(outDir, `${j.id}.md`), toMarkdown(card));
  if (variant === 'baseline') addFlags(card.flags);
  const fails = Object.entries(card.items).filter(([, v]) => v.result === 'fail').map(([k]) => k);
  console.log(`${j.id}: ${fails.length ? fails.join(', ') : 'clean'}${card.flags.length ? `  -> review queue (${card.flags.length})` : ''}`);
}
console.log(`judge spend $${cost.toFixed(4)} · reports in agents/call-qa/reports/`);
