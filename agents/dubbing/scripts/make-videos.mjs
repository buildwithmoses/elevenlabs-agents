#!/usr/bin/env node
// Builds the 3 fictional source videos: ElevenLabs TTS narration per segment + a title card per segment.
//   node agents/dubbing/scripts/make-videos.mjs [--force]
// Output: agents/dubbing/media/source/<id>.mp4 (small, committed) and media/source/<id>.timing.json
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { elBinary, el } from '../../../lib/el.mjs';

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..');
const spec = JSON.parse(readFileSync(join(HERE, 'fixtures/videos.json'), 'utf8'));
const SRC = join(HERE, 'media/source'); const TMP = join(HERE, 'media/out/build'); mkdirSync(SRC, { recursive: true }); mkdirSync(TMP, { recursive: true });
const VOICE = 'EXAVITQu4vr4xnSDxMaL'; // Sarah: mature, reassuring (premade voice)
const force = process.argv.includes('--force');
const dur = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim());
const ff = (args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);

execFileSync('python3', ['-I', join(HERE, 'scripts/cards.py'), join(HERE, 'fixtures/videos.json'), join(TMP, 'cards')], { stdio: 'inherit' });
const before = (await el('GET', '/v1/user/subscription')).character_count;
let chars = 0;
for (const v of spec.videos) {
  const out = join(SRC, `${v.id}.mp4`);
  if (existsSync(out) && !force) { console.log(`${v.id}: exists`); continue; }
  const parts = []; const timing = []; let t = 0;
  for (const [i, seg] of v.segments.entries()) {
    const mp3 = join(TMP, `${v.id}-${i}.mp3`);
    if (!existsSync(mp3) || force) {
      writeFileSync(mp3, await elBinary(`/v1/text-to-speech/${VOICE}?output_format=mp3_44100_128`, { text: seg.say, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.6, similarity_boost: 0.8 } }));
      chars += seg.say.length;
    }
    const d = dur(mp3) + 0.7; // a beat of silence after each line
    const part = join(TMP, `${v.id}-${i}.mp4`);
    ff(['-loop', '1', '-i', join(TMP, 'cards', `${v.id}-${String(i).padStart(2, '0')}.png`), '-i', mp3, '-af', 'apad', '-t', d.toFixed(2),
      '-c:v', 'libx264', '-tune', 'stillimage', '-pix_fmt', 'yuv420p', '-r', '25', '-c:a', 'aac', '-ar', '44100', '-ac', '2', part]);
    parts.push(part); timing.push({ i, start: +t.toFixed(2), end: +(t + d).toFixed(2), say: seg.say }); t += d;
  }
  const list = join(TMP, `${v.id}.txt`); writeFileSync(list, parts.map((p) => `file '${p}'`).join('\n'));
  ff(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', out]);
  writeFileSync(join(SRC, `${v.id}.timing.json`), JSON.stringify({ id: v.id, duration: +dur(out).toFixed(2), segments: timing }, null, 2) + '\n');
  console.log(`${v.id}: ${dur(out).toFixed(1)}s`);
}
const after = (await el('GET', '/v1/user/subscription')).character_count;
console.log(`TTS characters sent: ${chars}; account character_count ${before} -> ${after} (+${after - before})`);
