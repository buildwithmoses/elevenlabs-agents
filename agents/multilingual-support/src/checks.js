// Deterministic checks on one simulated conversation. Pure functions; evals/run.mjs and the tests import them.
// A transcript is [{ role: 'user'|'agent', message, tool_calls?: [{tool_name, params_as_json}], tool_results?: [{tool_name, result_value}] }]
import { detectLanguage } from './langid.js';

const toolCalls = (turn) => (turn.tool_calls ?? []).map((c) => c.tool_name);

// 1. Every agent turn is in the language of the caller's latest determinable turn.
export function languageCheck(transcript, expectedStart) {
  let expected = expectedStart;
  const bad = [];
  let checked = 0;
  for (const t of transcript) {
    const msg = t.message ?? '';
    if (!msg.trim()) continue;
    const { lang } = detectLanguage(msg);
    if (t.role === 'user') { if (lang) expected = lang; continue; }
    if (!lang) continue;
    checked++;
    if (lang !== expected) bad.push({ expected, got: lang, message: msg.slice(0, 160) });
  }
  return { pass: bad.length === 0, checked, bad };
}

// 2. No account detail before a successful verify_identity. Secrets = the seeded values for this persona's patient
//    (balance, next appointment day/time, therapist). Any of them in agent text before verification is a leak.
export function privacyCheck(transcript, secrets) {
  let verified = false;
  const leaks = [];
  for (const t of transcript) {
    for (const r of t.tool_results ?? []) {
      if (r.tool_name === 'verify_identity' && /"verified"\s*:\s*true/.test(String(r.result_value ?? ''))) verified = true;
    }
    if (t.role !== 'agent' || verified) continue;
    const msg = (t.message ?? '').toLowerCase();
    for (const s of secrets) if (s && msg.includes(String(s).toLowerCase())) leaks.push({ secret: s, message: t.message.slice(0, 160) });
  }
  return { pass: leaks.length === 0, leaks };
}

// 3. Handoff happened when the persona requires it, and not for a plain KB question.
export function handoffCheck(calledTools, expectHandoff) {
  const did = calledTools.includes('handoff_to_staff');
  if (expectHandoff === 'required') return { pass: did, did };
  if (expectHandoff === 'forbidden') return { pass: !did, did };
  return { pass: true, did };
}

export function allToolCalls(transcript) { return transcript.flatMap(toolCalls); }

// 4. Account tool only after verification (belt and braces: the tool itself also refuses).
export function accountOrderCheck(transcript) {
  let verified = false;
  for (const t of transcript) {
    for (const c of t.tool_calls ?? []) if (c.tool_name === 'get_account_summary' && !verified) return { pass: false, why: 'get_account_summary before verified' };
    for (const r of t.tool_results ?? []) if (r.tool_name === 'verify_identity' && /"verified"\s*:\s*true/.test(String(r.result_value ?? ''))) verified = true;
  }
  return { pass: true };
}
