#!/usr/bin/env node
// Step 1: send each source video to the ElevenLabs Dubbing API, one job per target language,
// poll until dubbed, then download the dubbed video. Job ids are kept in agents/dubbing/.state.json
// so a re-run resumes instead of paying for a second dub.
//   node agents/dubbing/scripts/dub.mjs [--only bridges] [--lang es]
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { el, state, arg } from '../../../lib/el.mjs';

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..');
const spec = JSON.parse(readFileSync(join(HERE, 'fixtures/videos.json'), 'utf8'));
const OUT = join(HERE, 'media/out/dubs'); mkdirSync(OUT, { recursive: true });
const st = state('dubbing'); st.jobs ??= {};
const only = arg('only'); const onlyLang = arg('lang');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const jobs = [];
for (const v of spec.videos) for (const l of spec.languages) {
  if ((only && only !== v.id) || (onlyLang && onlyLang !== l.code)) continue;
  const key = `${v.id}.${l.code}`;
  if (existsSync(join(OUT, `${key}.mp4`))) { console.log(`${key}: already downloaded`); continue; }
  if (!st.jobs[key]) {
    const fd = new FormData();
    fd.append('file', new Blob([readFileSync(join(HERE, 'media/source', `${v.id}.mp4`))], { type: 'video/mp4' }), `${v.id}.mp4`);
    fd.append('name', `Riverbend ${v.title} (${l.name})`);
    fd.append('source_lang', 'en'); fd.append('target_lang', l.code); fd.append('num_speakers', '1');
    fd.append('watermark', 'false');
    const r = await el('POST', '/v1/dubbing', fd);
    st.jobs[key] = { dubbing_id: r.dubbing_id, submitted_at: new Date().toISOString(), expected_duration_sec: r.expected_duration_sec }; st.save();
    console.log(`${key}: submitted ${r.dubbing_id} (expected ${r.expected_duration_sec}s)`);
  }
  jobs.push(key);
}

for (const key of jobs) {
  const job = st.jobs[key];
  for (let i = 0; ; i++) {
    const s = await el('GET', `/v1/dubbing/${job.dubbing_id}`);
    if (s.status === 'dubbed') break;
    if (s.status === 'failed') throw new Error(`${key}: dubbing failed: ${JSON.stringify(s.error ?? s).slice(0, 300)}`);
    if (i > 120) throw new Error(`${key}: still ${s.status} after 10 minutes`);
    await sleep(5000);
  }
  const [, lang] = key.split('.');
  const res = await el('GET', `/v1/dubbing/${job.dubbing_id}/audio/${lang}`, undefined, { raw: true });
  writeFileSync(join(OUT, `${key}.mp4`), Buffer.from(await res.arrayBuffer()));
  job.downloaded_at = new Date().toISOString(); job.content_type = res.headers.get('content-type'); st.save();
  console.log(`${key}: downloaded (${job.content_type})`);
}
