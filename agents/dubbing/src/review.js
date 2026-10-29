// Decision + review packet + approval + publish rules. Pure functions; the scripts do the I/O.
import { createHash } from 'node:crypto';
import { alignToSegments } from './align.js';

export const APPROVER = 'Dr. Elena Ruiz';
export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Final status for one dub: issues block review; only a clean dub is ready for Dr. Ruiz. */
export const decide = (issues) => (issues.length ? 'blocked' : 'ready_for_review');

/** Approval rules. Returns { ok, reason }. */
export function canApprove({ qa, approver, sha }) {
  if (!qa) return { ok: false, reason: 'no QA record for this video and language' };
  if (approver !== APPROVER) return { ok: false, reason: `only ${APPROVER} can approve clinical content` };
  if (qa.status !== 'ready_for_review') return { ok: false, reason: `QA status is ${qa.status}; fix the issues first` };
  if (sha !== qa.candidate_sha256) return { ok: false, reason: 'the file changed after QA; re-run QA' };
  return { ok: true };
}

/** Publish rules: an approval for this exact key and file, and QA still clean. */
export function canPublish({ qa, approval, sha }) {
  if (!approval || approval.decision !== 'approved') return { ok: false, reason: 'not approved' };
  if (approval.key !== qa?.key) return { ok: false, reason: 'approval is for a different video or language' };
  if (approval.approver !== APPROVER) return { ok: false, reason: 'approval not from the clinical director' };
  if (approval.sha256 !== sha || qa.candidate_sha256 !== sha) return { ok: false, reason: 'file changed since approval' };
  if (qa.status !== 'ready_for_review') return { ok: false, reason: `QA status is ${qa.status}` };
  return { ok: true };
}

const LABEL = { sets: 'sets', reps: 'reps', hold_seconds: 'hold (s)', rest_seconds: 'rest (s)', times_per_day: 'times a day', side: 'side', safety: 'safety line' };

/** Markdown review packet for Dr. Ruiz: side-by-side lines, every critical fact, every issue. */
export function packet({ video, lang, langName, qa, script, heard }) {
  const lines = script ? alignToSegments(video, script) : null;
  const rows = video.segments.map((s, i) => `| ${i + 1} | ${s.say} | ${lines ? lines[i] : (i === 0 ? '(could not split the translation by segment; full text below)' : '')} |`);
  const facts = qa.facts.map((f) => `| ${LABEL[f.kind] ?? f.kind} | ${f.value ?? ''} | ${f.found === true ? 'yes' : f.found === false ? '**NO**' : 'n/a'} |`);
  return `# Review: ${video.title} (${langName})

**Status: ${qa.status === 'ready_for_review' ? 'READY FOR YOUR REVIEW' : 'BLOCKED: do not approve'}**${qa.remediated ? `  \nThe original dub's audio failed QA. This version re-voices the dub's own translation with ${qa.remediated.model}.` : ''}

- Video: \`${qa.candidate_file}\`
- File fingerprint (sha256): \`${qa.candidate_sha256.slice(0, 16)}…\`
- Audio matches the translated script: ${qa.intelligibility == null ? 'n/a' : `${Math.round(qa.intelligibility * 100)}%`}

## Issues
${qa.issues.length ? qa.issues.map((i) => `- **${i.code}**: ${i.detail}`).join('\n') : '- None found by the automated checks. Please still watch the video before approving.'}

## Critical facts (checked against what is actually spoken)
| Fact | Value | Heard in the dub |
|---|---|---|
${facts.join('\n')}

## Side by side
| # | English (source) | ${langName} (translation) |
|---|---|---|
${rows.join('\n')}
${lines ? '' : `\nTranslation: ${script ?? '(none)'}\n`}
**What the speech-to-text heard:** ${heard.text}

## Approve
${qa.status === 'ready_for_review'
    ? `\`\`\`\nnode agents/dubbing/scripts/approve.mjs --key ${qa.key} --approver "${APPROVER}"\n\`\`\``
    : 'Approval is disabled until every issue above is resolved.'}
`;
}
