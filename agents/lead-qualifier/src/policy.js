// Intake rules for Riverbend's new-patient line. Pure functions, no I/O beyond reading policy.json:
// the gateway tools and the tests both import this file. The voice agent collects facts; THIS code
// decides what is allowed.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const POLICY = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'policy.json'), 'utf8'));

export const normPhone = (p) => { const d = String(p ?? '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : d; };
const lc = (s) => String(s ?? '').toLowerCase().replace(/[’']/g, "'");

export function matchPlan(text) {
  const t = lc(text).trim();
  if (!t) return null;
  for (const [id, p] of Object.entries(POLICY.plans)) {
    if (t === id || t === lc(p.label) || p.aliases.some((a) => t.includes(a))) return id;
  }
  return 'out_of_network';
}

export const findTerms = (text, terms) => { const t = lc(text); return terms.filter((term) => t.includes(lc(term))); };

// Red flags must ignore symptoms the caller DENIED ("no numbness", "denies tingling or weakness",
// "sin entumecimiento"). A term counts only if no negation cue comes before it in the same sentence
// without a "but" in between. The model's own red_flag_reported=true still triggers er_now on its own,
// so this only removes false alarms caused by negated words.
const NEG = /\b(no|not|denies|denied|deny|without|never|none|sin|nunca|ni)\b|\bdon't have\b|\bdoesn't have\b|\bhasn't had\b|\bhaven't had\b|\bno hay\b/;
export function findRedFlags(text, terms) {
  const hits = new Set();
  for (const sentence of lc(text).split(/[.;!?\n]+/)) {
    for (const term of terms) {
      const t = lc(term);
      let from = 0, i;
      while ((i = sentence.indexOf(t, from)) !== -1) {
        const before = sentence.slice(0, i);
        const afterBut = before.split(/\b(but|pero|however|although|aunque)\b/).pop();
        if (!NEG.test(afterBut)) hits.add(term);
        from = i + t.length;
      }
    }
  }
  return [...hits];
}

export function inServiceArea({ zip, city } = {}) {
  const z = String(zip ?? '').replace(/\D/g, '');
  if (z.length === 5) return POLICY.service_area.zip_prefixes.some((p) => z.startsWith(p));
  const c = lc(city).trim();
  if (!c) return null; // unknown
  return POLICY.service_area.cities.some((x) => c.includes(x));
}

/**
 * decide(intake, referralsOnFile) -> { decision, bookable, plan, reasons[], missing[] }
 * intake: { concern, symptoms, red_flag_reported, insurance_plan, member_id, work_injury, claim_number, zip, city }
 * Order matters: safety first (red flags), then scope, then area, then payer rules.
 */
export function decide(intake = {}, referralsOnFile = []) {
  const text = [intake.concern, intake.symptoms, intake.notes].filter(Boolean).join(' . ');
  const flags = findRedFlags(text, POLICY.red_flags.terms);
  if (flags.length || intake.red_flag_reported === true) {
    return { decision: 'er_now', bookable: false, plan: null, missing: [],
      reasons: [flags.length ? `red flag terms: ${flags.join(', ')}` : 'agent reported a red-flag symptom'] };
  }
  const notPt = findRedFlags(text, POLICY.not_pt.terms); // same negation handling: "not looking for a chiropractor"
  if (notPt.length) return { decision: 'decline_not_pt', bookable: false, plan: null, reasons: [`not PT: ${notPt.join(', ')}`], missing: [] };

  const area = inServiceArea(intake);
  if (area === false) return { decision: 'out_of_area', bookable: false, plan: null, reasons: ['outside Houston-area service area'], missing: [] };

  const missing = [];
  if (!lc(intake.concern).trim()) missing.push('concern');
  if (area === null) missing.push('zip_or_city');
  const plan = intake.work_injury === true ? 'workers_comp' : matchPlan(intake.insurance_plan);
  if (!plan) missing.push('insurance_plan');
  if (missing.length) return { decision: 'need_info', bookable: false, plan, reasons: ['missing required details'], missing };

  if (plan === 'workers_comp') {
    if (!String(intake.claim_number ?? '').trim()) return { decision: 'need_claim_number', bookable: false, plan, reasons: ['work injury without a claim number'], missing: ['claim_number'] };
    return { decision: 'book', bookable: true, plan, reasons: ['workers comp with claim number'], missing: [] };
  }
  if (plan === 'self_pay' || plan === 'out_of_network') {
    return { decision: 'book_self_pay', bookable: true, plan, missing: [], self_pay_price: POLICY.self_pay_prices.evaluation,
      reasons: [plan === 'self_pay' ? 'self-pay' : `out of network: ${intake.insurance_plan}`] };
  }
  if (POLICY.plans[plan].needs_referral) {
    const member = lc(intake.member_id).replace(/[\s-]/g, '');
    const onFile = !!member && referralsOnFile.some((r) => lc(r.member_id).replace(/[\s-]/g, '') === member && r.plan === plan);
    if (!onFile) return { decision: 'need_referral', bookable: false, plan, reasons: ['HMO with no referral on file'], missing: member ? [] : ['member_id'] };
    return { decision: 'book', bookable: true, plan, reasons: ['HMO, referral on file'], missing: [] };
  }
  return { decision: 'book', bookable: true, plan, reasons: ['in network'], missing: [] };
}

// What the agent may say. Fixed guidance from code, so coverage amounts are never improvised.
export function scriptFor(result) {
  const sp = POLICY.self_pay_prices;
  switch (result.decision) {
    case 'book': return 'They can book an evaluation. Say "I can get your evaluation booked" and offer slots from find_evaluation_slots. Do NOT say they are covered, have coverage, or that insurance will pay (in any language, e.g. never "tiene cobertura"); say the billing team verifies benefits before the visit.';
    case 'book_self_pay': return `Not in network (or no insurance). Self-pay price: evaluation $${sp.evaluation}, follow-up visits $${sp.follow_up}. Book only if the caller agrees to self-pay, and pass payment "self_pay" to book_evaluation.`;
    case 'need_referral': return 'BayouCare HMO needs a referral from the primary care doctor on file before the first visit. Do NOT book. Offer a callback (request_callback) for when the referral is sent.';
    case 'need_claim_number': return 'Work injuries need the workers compensation claim number before booking. Do NOT book. Ask them to get it from their employer or adjuster and offer a callback.';
    case 'er_now': return 'Do NOT book. Tell the caller clearly to call 911 or go to the nearest emergency room now. Give no other medical advice.';
    case 'decline_not_pt': return 'Not something physical therapy handles. Do NOT book. Politely suggest they contact their doctor or the right kind of provider.';
    case 'out_of_area': return 'Outside the Houston area Riverbend serves. Do NOT book. Politely suggest a physical therapy clinic closer to them.';
    default: return `Missing details: ${(result.missing ?? []).join(', ')}. Ask the caller for them, then call check_coverage again.`;
  }
}
