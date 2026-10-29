// Webhook tools for the reminder caller, served by gateway/server.mjs at POST /reminder-caller/<tool>.
// Code enforces the rules the prompt also states: nothing about an appointment is returned until the date of
// birth matches; writes need a verified session; only real open slots can be booked; fees come from policy.js.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeDob, cancellationFee, rankWaitlist, buildBatchCall, MAX_DOB_ATTEMPTS } from './src/policy.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export function seed() {
  const s = JSON.parse(readFileSync(join(HERE, 'fixtures', 'seed.json'), 'utf8'));
  return { ...s, verified: {}, attempts: {}, refills: [], agentId: null };
}

const fmt = (iso, lang = 'en') => new Date(iso).toLocaleString(lang === 'es' ? 'es-US' : 'en-US', { timeZone: 'America/Chicago', weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const appt = (st, id) => st.appointments.find((a) => a.appointment_id === String(id ?? '').trim().toUpperCase());
const patient = (st, pid) => st.patients.find((p) => p.patient_id === pid);
// Failure texts never contain the words the agent must not say yet (the model tends to echo tool text).
const needVerified = (st, a) => (!a ? { ok: false, error: 'unknown id' } : !st.verified[a.appointment_id] ? { ok: false, error: 'not verified yet: call verify_identity first and share nothing' } : null);
const DAY_ALIASES = { lunes: 'monday', martes: 'tuesday', 'miércoles': 'wednesday', miercoles: 'wednesday', jueves: 'thursday', viernes: 'friday', 'sábado': 'saturday', sabado: 'saturday' };
const dayKey = (d) => { const k = String(d ?? '').trim().toLowerCase(); return DAY_ALIASES[k] ?? k; };

function freeSlot(st, a) {
  // The freed time becomes a slot, and code ranks the waitlist for it (dry-run batch call, no phone number on the account).
  const slot = { slot_id: `FREED-${a.appointment_id}`, clinic: a.clinic, therapist: a.therapist, start: a.start, local_time: a.local_time, patient_id: null, freed: true };
  st.slots.push(slot);
  const booked = new Set(st.appointments.filter((x) => x.status === 'booked' && x.start === slot.start).map((x) => x.patient_id));
  const { ranked, excluded } = rankWaitlist(slot, st.waitlist, { bookedPatientsAt: booked });
  const batch = buildBatchCall({ agentId: st.agentId ?? 'REMINDER_AGENT_ID', slot, rankedPatients: ranked.map((id) => st.waitlist.find((w) => w.patient_id === id)) });
  const refill = { slot_id: slot.slot_id, ranked, excluded, batch };
  st.refills.push(refill);
  return refill;
}

export const tools = {
  async verify_identity({ appointment_id, date_of_birth }, { state: st }) {
    const a = appt(st, appointment_id);
    if (!a) return { verified: false, error: 'unknown appointment_id' };
    if (st.verified[a.appointment_id]) return { verified: true, already: true };
    st.attempts[a.appointment_id] = (st.attempts[a.appointment_id] ?? 0) + 1;
    const first = patient(st, a.patient_id).first_name;
    const lockedSay = `Say exactly this, then end the call: "I'm sorry, I wasn't able to confirm that. Please ask ${first} to call Riverbend Physical Therapy at ${st.clinic_callback}. Thank you."`;
    if (st.attempts[a.appointment_id] > MAX_DOB_ATTEMPTS) return { verified: false, locked: true, say: lockedSay };
    const p = patient(st, a.patient_id);
    const given = normalizeDob(date_of_birth);
    const left = Math.max(0, MAX_DOB_ATTEMPTS - st.attempts[a.appointment_id]);
    if (!given) return { verified: false, attempts_left: left, say: left ? 'Ask for the month, day and year of birth once more. Share nothing else.' : lockedSay };
    if (given !== p.dob) return { verified: false, attempts_left: left, say: left ? 'Ask for the date of birth once more. Share nothing else.' : lockedSay };
    st.verified[a.appointment_id] = true;
    return { verified: true, appointment: { clinic: `Riverbend ${a.clinic}`, when: fmt(a.start, p.language), therapist: a.therapist, visit: a.visit, status: a.status } };
  },

  async confirm_appointment({ appointment_id }, { state: st }) {
    const a = appt(st, appointment_id); const bad = needVerified(st, a); if (bad) return bad;
    if (a.status !== 'booked') return { ok: false, error: `appointment is ${a.status}` };
    a.status = 'confirmed';
    return { ok: true, status: 'confirmed', reminder: 'Arrive 10 minutes early in comfortable clothes.' };
  },

  async get_open_slots({ appointment_id, preferred_day }, { state: st }) {
    const a = appt(st, appointment_id); const bad = needVerified(st, a); if (bad) return bad;
    let open = st.slots.filter((s) => s.clinic === a.clinic && !s.patient_id && !s.freed && Date.parse(s.start) > Date.parse(a.start));
    let matched = null;
    if (preferred_day) { const f = open.filter((s) => (s.day ?? '').toLowerCase() === dayKey(preferred_day)); matched = f.length > 0; if (f.length) open = f; }
    // No day asked for (or none open that day): spread the offer across days, earliest first, instead of the first four rows.
    if (!matched) { const days = new Set(); const firsts = open.filter((s) => !days.has(s.date) && days.add(s.date)); open = [...firsts, ...open.filter((s) => !firsts.includes(s))]; }
    const p = patient(st, a.patient_id);
    return { ok: true, clinic: a.clinic, preferred_day_available: matched, slots: open.slice(0, 4).map((s) => ({ slot_id: s.slot_id, when: fmt(s.start, p.language), therapist: s.therapist })), note: 'Offer only these times. Use the slot_id when rescheduling.' };
  },

  async reschedule_appointment({ appointment_id, slot_id }, { state: st }) {
    const a = appt(st, appointment_id); const bad = needVerified(st, a); if (bad) return bad;
    const s = st.slots.find((x) => x.slot_id === slot_id);
    if (!s) return { ok: false, error: 'unknown slot_id: only offer slots returned by get_open_slots' };
    if (s.patient_id) return { ok: false, error: 'that slot was just taken; call get_open_slots again' };
    if (s.clinic !== a.clinic) return { ok: false, error: 'slot is at a different clinic' };
    const old = { start: a.start };
    s.patient_id = a.patient_id;
    a.start = s.start; a.local_time = s.local_time; a.therapist = s.therapist; a.status = 'confirmed';
    const refill = freeSlot(st, { ...a, ...old, appointment_id: a.appointment_id });
    const fee = cancellationFee({ nowIso: st.now, startIso: old.start, waiverUsedYear: 0 }); // reschedules never cost a fee
    return { ok: true, new_time: fmt(s.start, patient(st, a.patient_id).language), therapist: s.therapist, fee: 0, late_notice: fee.late, waitlist_offer_queued: refill.ranked.length > 0 };
  },

  async cancel_appointment({ appointment_id, reason }, { state: st }) {
    const a = appt(st, appointment_id); const bad = needVerified(st, a); if (bad) return bad;
    if (a.status === 'cancelled') return { ok: false, error: 'already cancelled' };
    const p = patient(st, a.patient_id);
    const fee = cancellationFee({ nowIso: st.now, startIso: a.start, waiverUsedYear: p.waiver_used_year });
    if (fee.waived) p.waiver_used_year = new Date(st.now).getUTCFullYear();
    a.status = 'cancelled'; a.cancel_reason = reason ?? null; a.fee = fee.fee;
    const refill = freeSlot(st, a);
    const say = fee.fee > 0 ? `This is less than 24 hours' notice, so there is a $${fee.fee} late-cancellation fee.`
      : fee.waived ? 'This is less than 24 hours\' notice. The $40 fee is waived this time, since it is the first late cancellation this year.'
      : 'There is no fee.';
    return { ok: true, status: 'cancelled', ...fee, say, waitlist_offer_queued: refill.ranked.length > 0 };
  },
};
