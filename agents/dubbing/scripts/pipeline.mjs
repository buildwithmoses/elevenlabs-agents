// The QA pipeline for one dub, shared by scripts/qa.mjs and evals/run.mjs.
//   translation check -> audio check (speech-to-text + LLM back-translation, verified in code)
//   -> if only the audio failed: re-voice the dub's own translation, then check again
//   -> status, review packet, file fingerprint.
// Variant 'no-fact-check' is the regression: it skips the fact checks and marks everything ready.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { el, judge } from '../../../lib/el.mjs';
import { checkDub } from '../src/checks.js';
import { decide, packet, sha256 } from '../src/review.js';
import { backTranslationMessages } from '../src/backtranslate.js';
import { alignToSegments } from '../src/align.js';

export const HERE = join(dirname(fileURLToPath(import.meta.url)), '..');
export const spec = JSON.parse(readFileSync(join(HERE, 'fixtures/videos.json'), 'utf8'));
export const WORK = process.env.DUB_WORK ?? join(HERE, 'media/out');
const rd = (p) => readFileSync(join(HERE, p), 'utf8');
const ensure = (p) => { mkdirSync(p, { recursive: true }); return p; };
const cost = { judge_usd: 0, stt_files: 0, revoice_chars: 0 };
export const spend = () => ({ ...cost, judge_usd: +cost.judge_usd.toFixed(4) });

export async function transcribe(file, lang, cacheFile) {
  if (existsSync(cacheFile)) return JSON.parse(readFileSync(cacheFile, 'utf8'));
  const fd = new FormData();
  fd.append('file', new Blob([readFileSync(file)], { type: 'video/mp4' }), 'dub.mp4');
  fd.append('model_id', 'scribe_v1'); fd.append('language_code', lang); fd.append('timestamps_granularity', 'word'); fd.append('tag_audio_events', 'false');
  const r = await el('POST', '/v1/speech-to-text', fd); cost.stt_files++;
  const out = { lang, model: 'scribe_v1', text: r.text, words: (r.words ?? []).filter((w) => w.type === 'word').map((w) => ({ text: w.text, start: w.start, end: w.end })) };
  writeFileSync(cacheFile, JSON.stringify(out, null, 1) + '\n');
  return out;
}

export async function backTranslate(langName, text, cacheFile, { live = true } = {}) {
  if (!live && cacheFile && existsSync(cacheFile)) return JSON.parse(readFileSync(cacheFile, 'utf8'));
  const r = await judge(backTranslationMessages(langName, text));
  cost.judge_usd += r._cost ?? 0;
  const { _cost, ...bt } = r;
  if (cacheFile) writeFileSync(cacheFile, JSON.stringify(bt, null, 1) + '\n');
  return bt;
}

/**
 * QA one dub. `heardOverride` lets the eval inject a corrupted transcript instead of the real one.
 * Returns the QA record (also written to WORK/qa/<key>.json, packet to review/<key>.md unless dryRun).
 */
export async function qaDub(key, { variant = 'baseline', heardOverride = null, fileOverride = null, live = true, writePacket = true, recordKey = key } = {}) {
  const [id, lang] = key.split('.');
  const video = spec.videos.find((v) => v.id === id);
  const langName = spec.languages.find((l) => l.code === lang).name;
  const timing = JSON.parse(rd(`media/source/${id}.timing.json`));
  const script = rd(`fixtures/scripts/${key}.txt`).trim();
  const dubFile = fileOverride ?? join(HERE, 'media/out/dubs', `${key}.mp4`);
  const factCheck = variant !== 'no-fact-check';
  const btDir = ensure(join(HERE, 'fixtures/backtranslations'));

  const heard = heardOverride ?? await transcribe(dubFile, lang, join(HERE, 'fixtures/transcripts', `${key}.json`));
  const translation = checkDub({ video, lang, heard: { text: script } }, { factCheck });
  const bt = factCheck ? await backTranslate(langName, heard.text, heardOverride ? null : join(btDir, `${key}.json`), { live }) : null;
  const audio = checkDub({ video, lang, heard, script, timing: timing.segments, duration: { source: timing.duration, dub: timing.duration }, backTranslation: bt }, { factCheck });

  let final = audio; let candidate = dubFile; let finalHeard = heard; let remediated = null;
  const audioOnly = audio.issues.length && !translation.issues.length;
  if (factCheck && audioOnly && !heardOverride && alignToSegments(video, script)) {
    const out = join(HERE, 'media/out/revoiced', `${key}.mp4`);
    let info = { model: 'eleven_v3', reused: true };
    if (!existsSync(out)) { const { revoice } = await import('./revoice.mjs'); info = await revoice(key); cost.revoice_chars += info.chars ?? 0; }
    const h2 = await transcribe(out, lang, join(HERE, 'fixtures/transcripts', `${key}.revoiced.json`));
    const bt2 = await backTranslate(langName, h2.text, join(btDir, `${key}.revoiced.json`), { live });
    const again = checkDub({ video, lang, heard: h2, script, timing: timing.segments, duration: { source: timing.duration, dub: timing.duration }, backTranslation: bt2 }, { factCheck });
    remediated = { model: info.model ?? 'eleven_v3', original_issues: audio.issues.map((i) => i.code), speedups: info.speedups };
    final = again; candidate = out; finalHeard = h2;
  }

  const issues = [...translation.issues.map((i) => ({ ...i, code: `translation_${i.code}` })), ...final.issues];
  const qa = {
    key: recordKey, video: id, lang, variant, status: decide(issues), issues, facts: final.facts.map(({ segment, ...f }) => f),
    intelligibility: final.intelligibility, candidate_file: relative(HERE, candidate), candidate_sha256: sha256(readFileSync(candidate)),
    remediated, back_translation: bt?.back_translation ?? null, at: new Date().toISOString(),
  };
  writeFileSync(join(ensure(join(WORK, 'qa')), `${recordKey}.json`), JSON.stringify(qa, null, 2) + '\n');
  if (writePacket) writeFileSync(join(ensure(join(HERE, 'review')), `${recordKey}.md`), packet({ video, lang, langName, qa, script, heard: finalHeard }));
  return qa;
}
