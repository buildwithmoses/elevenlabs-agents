#!/usr/bin/env node
// Dr. Ruiz approves (or rejects) one exact video + language. Refused unless QA is clean and the file is
// byte-for-byte the one QA checked.
//   node agents/dubbing/scripts/approve.mjs --key bridges.es --approver "Dr. Elena Ruiz" [--reject --note "..."]
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { arg } from '../../../lib/el.mjs';
import { HERE, WORK } from './pipeline.mjs';
import { canApprove, sha256 } from '../src/review.js';

export function approve({ key, approver, reject = false, note = '' }) {
  const qaFile = join(WORK, 'qa', `${key}.json`);
  const qa = existsSync(qaFile) ? JSON.parse(readFileSync(qaFile, 'utf8')) : null;
  const sha = qa ? sha256(readFileSync(join(HERE, qa.candidate_file))) : null;
  if (!reject) { const c = canApprove({ qa, approver, sha }); if (!c.ok) return { ok: false, reason: c.reason }; }
  mkdirSync(join(WORK, 'approvals'), { recursive: true });
  const rec = { key, approver, decision: reject ? 'rejected' : 'approved', sha256: sha, note, at: new Date().toISOString() };
  writeFileSync(join(WORK, 'approvals', `${key}.json`), JSON.stringify(rec, null, 2) + '\n');
  return { ok: true, record: rec };
}

if (process.argv[1]?.endsWith('approve.mjs')) {
  const r = approve({ key: arg('key'), approver: arg('approver'), reject: process.argv.includes('--reject'), note: arg('note', '') });
  console.log(r.ok ? `${r.record.decision}: ${r.record.key}` : `refused: ${r.reason}`); process.exitCode = r.ok ? 0 : 1;
}
