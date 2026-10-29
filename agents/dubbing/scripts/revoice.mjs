#!/usr/bin/env node
// Remediation: when a dub's AUDIO fails QA but its TRANSLATION passes, re-voice the dub's own translated
// script with ElevenLabs eleven_v3 TTS, one segment per title card, and lay it over the source video.
// The result goes through the same QA again; it still needs Dr. Ruiz's approval.
//   node agents/dubbing/scripts/revoice.mjs --key heel-slides.vi
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { elBinary, arg } from '../../../lib/el.mjs';
import { alignToSegments } from '../src/align.js';

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..');
export const REVOICE_MODEL = 'eleven_v3';
const VOICE = 'EXAVITQu4vr4xnSDxMaL';
const dur = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim());
const ff = (args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);

export async function revoice(key) {
  const [id, lang] = key.split('.');
  const spec = JSON.parse(readFileSync(join(HERE, 'fixtures/videos.json'), 'utf8'));
  const video = spec.videos.find((v) => v.id === id);
  const timing = JSON.parse(readFileSync(join(HERE, 'media/source', `${id}.timing.json`), 'utf8'));
  const script = readFileSync(join(HERE, 'fixtures/scripts', `${key}.txt`), 'utf8');
  const lines = alignToSegments(video, script);
  if (!lines) return { ok: false, reason: 'sentence count of the translation does not match the source; needs a person' };
  const TMP = join(HERE, 'media/out/revoice-tmp'); const OUT = join(HERE, 'media/out/revoiced'); mkdirSync(TMP, { recursive: true }); mkdirSync(OUT, { recursive: true });
  const inputs = []; const filters = []; let chars = 0; const speedups = [];
  for (const [i, text] of lines.entries()) {
    const seg = timing.segments[i]; const window = seg.end - seg.start - 0.15;
    const raw = join(TMP, `${key}-${i}.mp3`);
    writeFileSync(raw, await elBinary(`/v1/text-to-speech/${VOICE}?output_format=mp3_44100_128`, { text, model_id: REVOICE_MODEL }));
    chars += text.length;
    const d = dur(raw); const tempo = d > window ? Math.min(d / window, 1.3) : 1;
    speedups.push(+tempo.toFixed(2));
    inputs.push('-i', raw);
    filters.push(`[${i + 1}:a]${tempo > 1 ? `atempo=${tempo.toFixed(3)},` : ''}adelay=${Math.round(seg.start * 1000)}|${Math.round(seg.start * 1000)}[a${i}]`);
  }
  const mix = `${filters.join(';')};${lines.map((_, i) => `[a${i}]`).join('')}amix=inputs=${lines.length}:normalize=0,apad[aout]`;
  const out = join(OUT, `${key}.mp4`);
  ff(['-i', join(HERE, 'media/source', `${id}.mp4`), ...inputs, '-filter_complex', mix, '-map', '0:v', '-map', '[aout]', '-t', String(timing.duration), '-c:v', 'copy', '-c:a', 'aac', '-ac', '2', out]);
  return { ok: true, file: out, chars, speedups, model: REVOICE_MODEL };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const key = arg('key'); if (!key) throw new Error('--key <video>.<lang>');
  console.log(JSON.stringify(await revoice(key)));
}
