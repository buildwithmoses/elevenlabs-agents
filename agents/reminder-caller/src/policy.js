// Code-side rules for the reminder caller. Plain ES module, no dependencies; tools.mjs and the tests import it.
// The model never decides any of this: identity, fees, slot validity and waitlist order are all code.

export const LATE_CANCEL_HOURS = 24;
export const LATE_CANCEL_FEE = 40;
export const MAX_DOB_ATTEMPTS = 2;

const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12 };
const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => (y > 1900 && y < 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y}-${pad(m)}-${pad(d)}` : null);

/** Normalize a date of birth the model passes through ("1984-03-12", "03/12/1984", "March 12, 1984", "12 de marzo de 1984"). */
export function normalizeDob(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim().toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, '$1').replace(/,/g, ' ').replace(/\s+/g, ' ');
  let m;
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))) return iso(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/))) return iso(+m[3], +m[1], +m[2]); // US order
  if ((m = s.match(/^([a-z]+) (\d{1,2}) (\d{4})$/)) && MONTHS[m[1]]) return iso(+m[3], MONTHS[m[1]], +m[2]);
  if ((m = s.match(/^(\d{1,2}) (?:de )?([a-z]+) (?:de |del )?(\d{4})$/)) && MONTHS[m[2]]) return iso(+m[3], MONTHS[m[2]], +m[1]);
  return null;
}

/** Hours between "now" and the appointment start, both ISO strings with offsets. */
export const hoursUntil = (nowIso, startIso) => (Date.parse(startIso) - Date.parse(nowIso)) / 3_600_000;

/**
 * Late-cancel policy: under 24 hours' notice costs $40, waived once per calendar year per patient.
 * Returns what the tool tells the agent to say; the agent must not invent a different number.
 */
export function cancellationFee({ nowIso, startIso, waiverUsedYear }) {
  const hours = hoursUntil(nowIso, startIso);
  const year = new Date(nowIso).getUTCFullYear();
  if (hours >= LATE_CANCEL_HOURS) return { late: false, fee: 0, waived: false, hours_notice: +hours.toFixed(2) };
  if (waiverUsedYear !== year) return { late: true, fee: 0, waived: true, hours_notice: +hours.toFixed(2) };
  return { late: true, fee: LATE_CANCEL_FEE, waived: false, hours_notice: +hours.toFixed(2) };
}

/**
 * Rank waitlist patients for a freed slot. Hard filters: same clinic, insurance valid for that visit
 * (BayouCare HMO needs a referral on file, workers' comp needs a claim number), not already booked at that time,
 * and the slot is inside the patient's stated availability. Order: earliest request first; ties broken by
 * therapist preference matching the slot's therapist, then patient id (stable, deterministic).
 */
export function rankWaitlist(slot, waitlist, { bookedPatientsAt = new Set() } = {}) {
  const eligible = [];
  const excluded = [];
  for (const w of waitlist) {
    const why = [];
    if (w.clinic !== slot.clinic) why.push('different clinic');
    if (!insuranceValid(w)) why.push('insurance not valid for this visit');
    if (bookedPatientsAt.has(w.patient_id)) why.push('already booked at that time');
    if (!inAvailability(slot, w.availability)) why.push('outside stated availability');
    (why.length ? excluded : eligible).push(why.length ? { patient_id: w.patient_id, why } : w);
  }
  eligible.sort((a, b) =>
    Date.parse(a.requested_at) - Date.parse(b.requested_at) ||
    Number(b.therapist_pref === slot.therapist) - Number(a.therapist_pref === slot.therapist) ||
    a.patient_id.localeCompare(b.patient_id));
  return { ranked: eligible.map((w) => w.patient_id), excluded };
}

export function insuranceValid(w) {
  if (w.insurance === 'BayouCare HMO') return Boolean(w.referral_on_file);
  if (w.insurance === "Workers' comp") return Boolean(w.claim_number);
  return ['Lone Star Health PPO', 'Gulf Coast Medicare Advantage', 'Medicare', 'Self-pay'].includes(w.insurance);
}

function inAvailability(slot, availability) {
  if (!availability || availability === 'any') return true;
  const hour = Number(slot.local_time.slice(0, 2));
  if (availability === 'mornings') return hour < 12;
  if (availability === 'afternoons') return hour >= 12 && hour < 17;
  if (availability === 'evenings') return hour >= 17;
  return true;
}

const E164 = /^\+1\d{10}$/;
/**
 * Build the ElevenLabs batch-calling request (POST /v1/convai/batch-calling/submit) that would offer a freed slot
 * to the top waitlist patients. Dry-run in this repo: there is no phone number on the account, so
 * agent_phone_number_id is null and `ready` is false until one is attached.
 */
export function buildBatchCall({ agentId, phoneNumberId = null, slot, rankedPatients, max = 3, scheduledUnix = null }) {
  const recipients = rankedPatients.slice(0, max).map((p) => ({
    phone_number: p.phone,
    conversation_initiation_client_data: {
      dynamic_variables: { call_type: 'waitlist_offer', patient_first_name: p.first_name, waitlist_id: p.patient_id, offer_slot_id: slot.slot_id },
    },
  }));
  const payload = { call_name: `Riverbend waitlist refill ${slot.slot_id}`, agent_id: agentId, agent_phone_number_id: phoneNumberId, scheduled_time_unix: scheduledUnix, recipients };
  return { payload, ...validateBatchCall(payload) };
}

export function validateBatchCall(p) {
  const errors = [];
  const blockers = [];
  if (!p.agent_id) errors.push('agent_id missing');
  if (!p.call_name) errors.push('call_name missing');
  if (!Array.isArray(p.recipients) || p.recipients.length === 0) errors.push('no recipients');
  for (const r of p.recipients ?? []) if (!E164.test(r.phone_number ?? '')) errors.push(`bad phone ${r.phone_number}`);
  const phones = (p.recipients ?? []).map((r) => r.phone_number);
  if (new Set(phones).size !== phones.length) errors.push('duplicate recipient');
  if (!p.agent_phone_number_id) blockers.push('no agent_phone_number_id: attach a Twilio or SIP number to send for real');
  return { valid: errors.length === 0, errors, ready: errors.length === 0 && blockers.length === 0, blockers };
}
