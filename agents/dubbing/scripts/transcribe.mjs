#!/usr/bin/env node
// Step 2: transcribe every dubbed video with ElevenLabs Speech-to-Text (Scribe), word timestamps on.
// This is an independent listen to what the dub actually says, not the dubbing job's own script.
// Saved as agents/dubbing/fixtures/transcripts/<id>.<lang>.json (small, committed so tests run offline).
//   node agents/dubbing/scripts/transcribe.mjs [--force]
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { el } from '../../../lib/el.mjs';

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..');
const DUBS = join(HERE, 'media/out/dubs'); const OUT = join(HERE, 'fixtures/transcripts'); mkdirSync(OUT, { recursive: true });
const force = process.argv.includes('--force');
export const MODEL = process.env.STT_MODEL ?? 'scribe_v1';

for (const f of readdirSync(DUBS).filter((x) => x.endsWith('.mp4'))) {
  const key = f.replace(/\.mp4$/, ''); const lang = key.split('.').pop();
  const out = join(OUT, `${key}.json`);
  if (existsSync(out) && !force) { console.log(`${key}: cached`); continue; }
  const fd = new FormData();
  fd.append('file', new Blob([readFileSync(join(DUBS, f))], { type: 'video/mp4' }), f);
  fd.append('model_id', MODEL); fd.append('language_code', lang); fd.append('timestamps_granularity', 'word'); fd.append('tag_audio_events', 'false');
  const r = await el('POST', '/v1/speech-to-text', fd);
  const words = (r.words ?? []).filter((w) => w.type === 'word').map((w) => ({ text: w.text, start: w.start, end: w.end }));
  writeFileSync(out, JSON.stringify({ key, lang, model: MODEL, language_code: r.language_code, language_probability: r.language_probability, text: r.text, words }, null, 1) + '\n');
  console.log(`${key}: ${r.text}`);
}
