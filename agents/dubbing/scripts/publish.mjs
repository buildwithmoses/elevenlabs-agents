#!/usr/bin/env node
// Publish only what Dr. Ruiz approved, file unchanged since approval, QA still clean.
// Copies to WORK/published/ and writes WORK/published/manifest.json.
//   node agents/dubbing/scripts/publish.mjs [--key bridges.es]
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { arg } from '../../../lib/el.mjs';
import { HERE, WORK } from './pipeline.mjs';
import { canPublish, sha256 } from '../src/review.js';

export function publish(key) {
  const read = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);
  const qa = read(join(WORK, 'qa', `${key}.json`)); const approval = read(join(WORK, 'approvals', `${key}.json`));
  const sha = qa ? sha256(readFileSync(join(HERE, qa.candidate_file))) : null;
  const c = canPublish({ qa, approval, sha });
  if (!c.ok) return { ok: false, key, reason: c.reason };
  const dir = join(WORK, 'published'); mkdirSync(dir, { recursive: true });
  copyFileSync(join(HERE, qa.candidate_file), join(dir, `${key}.mp4`));
  const mf = join(dir, 'manifest.json'); const m = read(mf) ?? { items: [] };
  m.items = m.items.filter((x) => x.key !== key).concat({ key, sha256: sha, approved_by: approval.approver, approved_at: approval.at, published_at: new Date().toISOString(), remediated: !!qa.remediated });
  writeFileSync(mf, JSON.stringify(m, null, 2) + '\n');
  return { ok: true, key };
}

if (process.argv[1]?.endsWith('publish.mjs')) {
  const only = arg('key');
  const keys = only ? [only] : readdirSync(join(WORK, 'qa')).map((f) => f.replace(/\.json$/, ''));
  for (const k of keys) { const r = publish(k); console.log(r.ok ? `published ${k}` : `not published ${k}: ${r.reason}`); }
}
