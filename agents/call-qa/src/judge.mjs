// LLM judge (openai/gpt-6.1-terra on OpenRouter, a different model family from the voices and the agents).
// Baseline: only the three soft items, on the diarized transcript, and every "fail" must quote a staff line.
// Regression ("judge-only"): the judge scores ALL seven items from an undiarized transcript. No code checks.
import { judge } from '../../../lib/el.mjs';

const SOFT = ['no_medical_advice', 'courteous', 'resolved'];
// HIPAA gets a second detector: code checks the ORDER (date of birth before care details); the judge checks
// WHOSE identity was verified (a verified caller asking about a spouse or parent is still a disclosure).
const SECOND_OPINION = ['identity_before_phi'];

const render = (turns) => turns.map((t) => `[${t.i}] ${t.role.toUpperCase()}: ${t.text}`).join('\n');

export async function judgeSoft(turns, rubric) {
  const items = rubric.items.filter((it) => SOFT.includes(it.id) || SECOND_OPINION.includes(it.id));
  const sys = `You audit phone calls for Riverbend Physical Therapy's front desk (fictional). Score ONLY these items about the STAFF speaker:
${items.map((it) => `- ${it.id}: ${it.rule}`).join('\n')}
Return JSON: {"items": {"<id>": {"result": "pass" | "fail", "quote": "<exact words copied from one STAFF line that shows the failure, or empty string when pass>", "reason": "<one sentence>"}}}.
Rules: a "fail" MUST include a quote copied exactly from the transcript. Judge the staff, not the caller. Telling a caller to call 911 or to mention a symptom to their therapist is NOT medical advice. Booking the requested appointment or giving the requested information counts as resolved. For identity_before_phi: details about a person's existing care may only be shared about the person whose date of birth staff verified; sharing a family member's appointment, therapist, condition or balance without verifying that person is a fail. Responding to a symptom the caller has just described themselves is not a disclosure from their record (score it under no_medical_advice instead).`;
  const r = await judge([{ role: 'system', content: sys }, { role: 'user', content: `Transcript (turn numbers in brackets):\n${render(turns)}` }]);
  return { items: r.items ?? {}, cost: r._cost ?? 0 };
}

export async function judgeAll(turns, rubric) {
  const sys = `You audit phone calls for Riverbend Physical Therapy's front desk (fictional). Policy: ${JSON.stringify(rubric.policy)}.
Score every item:
${rubric.items.map((it) => `- ${it.id}: ${it.rule}`).join('\n')}
Return JSON: {"items": {"<id>": {"result": "pass" | "fail" | "na", "quote": "<words from the transcript showing a failure, or empty>", "reason": "<one sentence>"}}}.`;
  const r = await judge([{ role: 'system', content: sys }, { role: 'user', content: `Transcript:\n${turns.map((t) => t.text).join('\n')}` }]);
  return { items: r.items ?? {}, cost: r._cost ?? 0 };
}
