// The new-patient line's tools, as plain functions over an in-memory state. tools.mjs exposes them to the
// gateway; tests call them directly. Every consequential check happens here, not in the prompt.
import * as defaultPolicy from './policy.js';

// The policy module is injectable so the gateway adapter (tools.mjs) can load a fresh copy when policy
// files change; the gateway only hot-reloads tools.mjs itself, not the modules it imports.
let P = defaultPolicy;
export const usePolicy = (mod) => { P = mod; };
const decide = (...a) => P.decide(...a);
const scriptFor = (...a) => P.scriptFor(...a);
const normPhone = (...a) => P.normPhone(...a);
const pad = (n) => String(n).padStart(2, '0');

export function makeSlots(seed, today = new Date()) {
  const CLINICS = P.POLICY.clinics;
  // Next 8 business days after today, slot_times at each clinic. Every slot index in booked_pattern is taken.
  const slots = [];
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  let added = 0;
  while (added < 8) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    added++;
    const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    for (const clinic of CLINICS) {
      seed.slot_times.forEach((t, i) => {
        const therapists = seed.therapists[clinic];
        slots.push({ slot_id: `${clinic.slice(0, 3).toUpperCase()}-${date.replace(/-/g, '')}-${t.replace(':', '')}`, clinic, date, time: t,
          weekday: d.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }),
          therapist: therapists[(added + i) % therapists.length], open: !seed.booked_pattern.includes(i) || (added % 3 === 0) });
      });
    }
  }
  return slots;
}

export function initState(seed, today) {
  return {
    seed, slots: makeSlots(seed, today), referrals: seed.referrals_on_file,
    leads: seed.existing_leads.map((l) => ({ ...l, history: [] })), qualifications: {}, bookings: [], callbacks: [], nextLead: 2001, nextConf: 410200,
  };
}

const bucket = (t) => { const h = Number(t.slice(0, 2)); return h < 12 ? 'morning' : h < 16 ? 'afternoon' : 'evening'; };

export const core = {
  check_coverage(b, s) {
    const phone = normPhone(b.caller_phone);
    if (phone.length !== 10) return { ok: false, error: 'caller_phone must be a 10-digit number; ask the caller for it first' };
    const r = decide(b, s.referrals);
    s.qualifications[phone] = { ...r, at: new Date().toISOString(), input: b };
    return { ok: true, decision: r.decision, bookable: r.bookable, plan: r.plan, missing: r.missing, instructions: scriptFor(r),
      ...(r.self_pay_price ? { self_pay_price: r.self_pay_price } : {}) };
  },
  // Regression variant only: same rules but the HMO referral requirement is skipped.
  check_coverage_noref(b, s) {
    const out = core.check_coverage(b, s);
    const phone = normPhone(b.caller_phone);
    if (out.ok && out.decision === 'need_referral') {
      s.qualifications[phone] = { ...s.qualifications[phone], decision: 'book', bookable: true };
      return { ...out, decision: 'book', bookable: true, instructions: scriptFor({ decision: 'book' }) };
    }
    return out;
  },
  find_evaluation_slots(b, s) {
    const CLINICS = P.POLICY.clinics;
    const clinic = CLINICS.find((c) => c.toLowerCase() === String(b.clinic ?? '').toLowerCase().trim());
    if (!clinic) return { ok: false, error: `clinic must be one of ${CLINICS.join(', ')}` };
    const pref = String(b.preferred_time ?? 'any').toLowerCase();
    const lang = String(b.language ?? 'en').toLowerCase();
    let open = s.slots.filter((x) => x.clinic === clinic && x.open && (pref === 'any' || bucket(x.time) === pref));
    if (lang.startsWith('es')) { const es = open.filter((x) => /español/.test(x.therapist)); if (es.length) open = es; }
    return { ok: true, clinic, slots: open.slice(0, 3).map(({ open: _o, ...x }) => x), note: 'Evaluations are 60 minutes. Offer only these slots, by weekday, date and time.' };
  },
  book_evaluation(b, s, { trust = false } = {}) {
    const phone = normPhone(b.caller_phone);
    const q = s.qualifications[phone];
    if (!trust) {
      if (!q) return { ok: false, error: 'Call check_coverage for this caller before booking.' };
      if (!q.bookable) return { ok: false, error: `Not bookable: ${q.decision}. ${scriptFor(q)}` };
      if (q.decision === 'book_self_pay' && b.payment !== 'self_pay') return { ok: false, error: 'This caller is self-pay. Confirm they agree to the self-pay price, then pass payment "self_pay".' };
    }
    const slot = s.slots.find((x) => x.slot_id === b.slot_id);
    if (!slot) return { ok: false, error: 'Unknown slot_id. Use a slot_id returned by find_evaluation_slots.' };
    if (!slot.open) return { ok: false, error: 'That slot was just taken. Call find_evaluation_slots again.' };
    if (!String(b.patient_first_name ?? '').trim() || !String(b.patient_last_name ?? '').trim()) return { ok: false, error: 'Patient first and last name are required.' };
    if (s.bookings.some((x) => x.phone === phone)) return { ok: false, error: 'This caller already has an evaluation booked today. Do not book twice.' };
    slot.open = false;
    const booking = { confirmation: String(s.nextConf++), phone, slot_id: slot.slot_id, clinic: slot.clinic, date: slot.date, time: slot.time, therapist: slot.therapist,
      patient: `${b.patient_first_name} ${b.patient_last_name}`, dob: b.date_of_birth ?? '', payment: b.payment ?? 'insurance', decision_at_booking: q?.decision ?? 'none' };
    s.bookings.push(booking);
    return { ok: true, confirmation_code: booking.confirmation, clinic: slot.clinic, weekday: slot.weekday, date: slot.date, time: slot.time, therapist: slot.therapist,
      arrive: 'Arrive 15 minutes early with photo ID, insurance card (or claim number for work injuries), and comfortable clothes.' };
  },
  create_crm_lead(b, s) {
    const phone = normPhone(b.caller_phone);
    if (phone.length !== 10) return { ok: false, error: 'caller_phone must be a 10-digit number' };
    const fields = { name: b.caller_name ?? '', status: b.status ?? 'new', concern: b.concern ?? '', insurance_plan: b.insurance_plan ?? '',
      language: b.language ?? 'en', decision: s.qualifications[phone]?.decision ?? b.decision ?? '', source: b.source ?? 'phone' };
    const existing = s.leads.find((l) => l.phone === phone);
    if (existing) {
      existing.history.push({ at: new Date().toISOString(), ...fields });
      Object.assign(existing, Object.fromEntries(Object.entries(fields).filter(([k, v]) => v !== '' && k !== 'source')));
      return { ok: true, lead_id: existing.lead_id, created: false, note: 'Existing lead updated (deduped by phone).' };
    }
    const lead = { lead_id: `L-${s.nextLead++}`, phone, ...fields, created_at: new Date().toISOString(), history: [] };
    s.leads.push(lead);
    return { ok: true, lead_id: lead.lead_id, created: true };
  },
  request_callback(b, s) {
    const phone = normPhone(b.caller_phone);
    if (phone.length !== 10) return { ok: false, error: 'caller_phone must be a 10-digit number' };
    const cb = { id: `CB-${s.callbacks.length + 301}`, phone, name: b.caller_name ?? '', reason: b.reason ?? '', best_time: b.best_time ?? '', language: b.language ?? 'en' };
    s.callbacks.push(cb);
    return { ok: true, callback_id: cb.id, message: 'The front desk will call back within one business day.' };
  },
};
