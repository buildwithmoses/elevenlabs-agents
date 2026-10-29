#!/usr/bin/env node
// Save each dubbing job's own translated script (what the dub was supposed to say) as plain text:
// agents/dubbing/fixtures/scripts/<id>.<lang>.txt. Small, committed, so tests and QA run offline.
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { el, state } from '../../../lib/el.mjs';
const HERE = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(HERE, 'fixtures/scripts'); mkdirSync(OUT, { recursive: true });
const st = state('dubbing');
export const srtToText = (srt) => srt.split(/\r?\n/).filter((l) => l.trim() && !/^\d+$/.test(l.trim()) && !/-->/.test(l)).join(' ').replace(/\s+/g, ' ').trim();
for (const [key, job] of Object.entries(st.jobs ?? {})) {
  const f = join(OUT, `${key}.txt`);
  if (existsSync(f) && !process.argv.includes('--force')) continue;
  const lang = key.split('.').pop();
  const res = await el('GET', `/v1/dubbing/${job.dubbing_id}/transcript/${lang}?format_type=srt`, undefined, { raw: true });
  writeFileSync(f, srtToText(await res.text()) + '\n');
  console.log(`${key}: saved`);
}
