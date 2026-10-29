#!/usr/bin/env node
// Turns fixtures/calls.json into real two-voice phone-call audio (fixtures/audio/<id>.mp3).
// Primary: ElevenLabs Text to Dialogue (one request per call, eleven_v3). Fallback: one TTS request per line
// (eleven_multilingual_v2) stitched with ffmpeg. Output is re-encoded to 32 kbps mono so it can live in git.
// Cached: existing files are skipped unless --force. Prints characters used.
//   node agents/call-qa/scripts/generate-audio.mjs [--only c01,c02] [--force]
import { existsSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { elBinary, arg } from '../../../lib/el.mjs';

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(HERE, 'fixtures', 'audio');
mkdirSync(OUT, { recursive: true });
const VOICES = { A: 'EXAVITQu4vr4xnSDxMaL' /* Sarah, front desk */, C: 'JBFqnCBsd6RMkjVDRZzb' /* George, caller */ };
const calls = JSON.parse(readFileSync(join(HERE, 'fixtures', 'calls.json'), 'utf8')).calls;
const only = arg('only') ? String(arg('only')).split(',') : null;
const force = process.argv.includes('--force');

const compress = (src, dst) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-ac', '1', '-ar', '22050', '-b:a', '32k', dst]);
let chars = 0;
for (const c of calls) {
  if (only && !only.includes(c.id)) continue;
  const dst = join(OUT, `${c.id}.mp3`);
  if (existsSync(dst) && !force) { console.log(`${c.id} cached`); continue; }
  const tmp = join(OUT, `.${c.id}.raw.mp3`);
  const n = c.lines.reduce((s, l) => s + l[1].length, 0);
  try {
    const buf = await elBinary('/v1/text-to-dialogue?output_format=mp3_44100_128', {
      model_id: 'eleven_v3', inputs: c.lines.map(([who, text]) => ({ text, voice_id: VOICES[who] })),
    });
    writeFileSync(tmp, buf); compress(tmp, dst); rmSync(tmp);
    chars += n; console.log(`${c.id} dialogue ok (${n} chars)`);
  } catch (e) {
    console.log(`${c.id} dialogue failed (${String(e.message).slice(0, 120)}); falling back to per-line TTS`);
    const parts = [];
    for (const [i, [who, text]] of c.lines.entries()) {
      const p = join(OUT, `.${c.id}.${i}.mp3`);
      writeFileSync(p, await elBinary(`/v1/text-to-speech/${VOICES[who]}?output_format=mp3_44100_128`, { text, model_id: 'eleven_multilingual_v2' }));
      parts.push(p);
    }
    const list = join(OUT, `.${c.id}.list.txt`);
    writeFileSync(list, parts.map((p) => `file '${p}'`).join('\n'));
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', tmp]);
    compress(tmp, dst); for (const p of [...parts, list, tmp]) rmSync(p);
    chars += n; console.log(`${c.id} per-line ok (${n} chars)`);
  }
}
console.log(`TTS characters used this run: ${chars}`);
