// One call -> scorecard. Baseline: Scribe (diarized) -> code checks -> judge for soft items -> evidence check.
// Variants (regressions the eval compares against):
//   judge-only      no diarization, no code checks, the judge scores all seven items
//   no-diarization  same code checks + judge, but Scribe's speaker labels are thrown away
//   code-only       code checks only; the judge (and its HIPAA second opinion) is removed to save cost
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toTurns, toFlatTurns } from './turns.js';
import { codeChecks, quoteFound } from './checks.js';
import { judgeSoft, judgeAll } from './judge.mjs';

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..');
export const RUBRIC = JSON.parse(readFileSync(join(HERE, 'rubric.json'), 'utf8'));
export const ITEMS = RUBRIC.items.map((i) => i.id);

export async function scoreCall({ id, scribe, variant = 'baseline' }) {
  const judgeOnly = variant === 'judge-only';
  const turns = judgeOnly || variant === 'no-diarization' ? toFlatTurns(scribe) : toTurns(scribe);
  let items, cost = 0;
  if (judgeOnly) {
    const j = await judgeAll(turns, RUBRIC); cost += j.cost;
    items = Object.fromEntries(ITEMS.map((k) => [k, { checked_by: 'judge', ...normalize(j.items[k]) }]));
  } else {
    const code = codeChecks(turns, RUBRIC.policy);
    const j = variant === 'code-only' ? { items: {}, cost: 0 } : await judgeSoft(turns, RUBRIC); cost += j.cost;
    items = {};
    for (const k of ITEMS) items[k] = code[k] ? { checked_by: 'code', ...code[k] } : { checked_by: 'judge', ...normalize(j.items[k]) };
    // HIPAA: fail if EITHER detector fails (union favours recall). The judge's fail still needs a verified quote.
    const second = normalize(j.items.identity_before_phi);
    if (items.identity_before_phi.result !== 'fail' && second.result === 'fail' && quoteFound(second.quote, turns)) {
      items.identity_before_phi = { checked_by: 'code+judge', ...second, reason: `judge: ${second.reason}` };
    } else items.identity_before_phi.checked_by = 'code+judge';
  }
  // Evidence rule: a failure must quote a line that is really in the transcript. Baseline drops unsupported
  // failures (and counts them); the regression keeps them, so the eval can measure how often that happens.
  const unsupported = [];
  for (const [k, v] of Object.entries(items)) {
    if (v.result !== 'fail') continue;
    v.evidence_verified = quoteFound(v.quote, turns);
    if (!v.evidence_verified) {
      unsupported.push({ item: k, quote: v.quote ?? '' });
      if (variant === 'baseline') Object.assign(items[k], { result: 'pass', reason: `judge said fail without a quote found in the transcript (dropped): ${v.reason ?? ''}` });
    }
  }
  const flags = Object.entries(items).filter(([k, v]) => v.result === 'fail' && RUBRIC.flag_to_review.includes(k))
    .map(([k, v]) => ({ call: id, item: k, quote: v.quote, reason: v.reason, status: 'pending' }));
  return { id, variant, language: scribe.language_code, duration_s: Math.round(scribe.audio_duration_secs ?? 0), turns, items, flags, unsupported, judge_cost_usd: cost };
}

function normalize(v) {
  const r = String(v?.result ?? 'pass').toLowerCase();
  return { result: ['pass', 'fail', 'na'].includes(r) ? r : 'pass', quote: v?.quote || null, reason: v?.reason ?? '' };
}

export function toMarkdown(card) {
  const icon = { pass: 'pass', fail: '**FAIL**', na: 'n/a' };
  const rows = ITEMS.map((k) => {
    const v = card.items[k];
    return `| ${k} | ${v.checked_by} | ${icon[v.result]} | ${v.result === 'fail' ? `"${(v.quote ?? '').slice(0, 160)}"` : ''} | ${(v.reason ?? '').replace(/\|/g, '/')} |`;
  });
  return [`# Call ${card.id} (${card.language}, ${card.duration_s}s)`, '',
    '| Item | Checked by | Result | Evidence | Why |', '|---|---|---|---|---|', ...rows, '',
    card.flags.length ? `**Sent to Hannah's review queue:** ${card.flags.map((f) => f.item).join(', ')}. Nothing counts against staff until she confirms it.` : 'No review flags.',
    '', '## Transcript', '', ...card.turns.map((t) => `- [${t.i}] **${t.role}**: ${t.text}`), ''].join('\n');
}
