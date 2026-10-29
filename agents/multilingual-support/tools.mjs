// Webhook tools for the multilingual support agent, served by gateway/server.mjs at /multilingual-support/<tool>.
// Code, not the prompt, enforces the privacy rule: get_account_summary returns nothing unless
// verify_identity succeeded earlier IN THE SAME CONVERSATION (conversation_id comes from a system dynamic variable).
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verify } from './src/identity.js';
import { cancellationFee } from './src/fees.js';

const HERE = dirname(fileURLToPath(import.meta.url));

export function seed() {
  const { patients } = JSON.parse(readFileSync(join(HERE, 'fixtures', 'patients.json'), 'utf8'));
  return { patients, verified: {}, attempts: {}, handoffs: [] };
}

const MAX_ATTEMPTS = 3;
// What the agent may tell the caller about a handoff. Tool output, so the promise comes from code, not the model.
const READ_BACK = 'In the caller\'s language, tell them which questions staff will call back about, covering every item in read_back_these_questions, and ask if anything is missing. If something is missing, call handoff_to_staff again with the full list.';

const SAY = {
  tell_caller_in_their_language: 'Meaning to convey, translated into the language the caller is speaking (never read this English text aloud to a Spanish or Vietnamese caller): a staff member will call you back within one business day.',
  do_not_say: 'Do not say the request is urgent or prioritized, do not promise a time today, and do not say you will connect or transfer the caller. Those things are not available.',
};

export const tools = {
  async check_cancellation_fee(args) { return cancellationFee(args); },

  async verify_identity({ full_name, date_of_birth, conversation_id }, { state }) {
    const cid = conversation_id || 'unknown';
    state.attempts[cid] = (state.attempts[cid] ?? 0) + 1;
    if (state.attempts[cid] > MAX_ATTEMPTS) return { verified: false, reason: 'too_many_attempts', next_step: 'offer handoff_to_staff' };
    const r = verify(state.patients, full_name, date_of_birth);
    if (r.verified) state.verified[cid] = r.patient_id;
    // Never say which part was wrong, and never confirm whether a person is a patient.
    return r.verified ? { verified: true } : { verified: false, reason: r.reason === 'no_match' ? 'could_not_verify' : r.reason };
  },

  async get_account_summary({ conversation_id }, { state }) {
    const pid = state.verified[conversation_id || 'unknown'];
    if (!pid) return { ok: false, error: 'identity_not_verified', next_step: 'call verify_identity first' };
    const p = state.patients.find((x) => x.patient_id === pid);
    return { ok: true, first_name: p.full_name.split(' ')[0], clinic: p.clinic, balance: p.balance, next_appointment: p.next_appointment, therapist: p.therapist };
  },

  async handoff_to_staff({ language, reason, summary, questions, callback_phone, conversation_id }, { state }) {
    const digits = String(callback_phone ?? '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
    if (digits.length !== 10) return { ok: false, error: 'callback_phone_required', next_step: 'Ask the caller for the 10-digit number staff should call back, read it back, then call handoff_to_staff again.' };
    const qs = (Array.isArray(questions) ? questions : []).map((q) => String(q).trim()).filter(Boolean).slice(0, 8);
    if (!qs.length) return { ok: false, error: 'questions_required', next_step: 'List every separate question or request the caller made in `questions`, one per item, then call handoff_to_staff again.' };
    const full = `${String(summary ?? '').slice(0, 400)} Questions: ${qs.map((q, i) => `(${i + 1}) ${q}`).join(' ')}`;
    const allowed = ['billing_dispute', 'not_in_knowledge_base', 'caller_upset', 'caller_requested_person', 'identity_failed', 'clinical_question', 'other'];
    const r = allowed.includes(reason) ? reason : 'other';
    const lang = ['en', 'es', 'vi'].includes(language) ? language : 'en';
    // One ticket per call: a repeat handoff in the same conversation adds a note to the existing ticket.
    const existing = conversation_id && state.handoffs.find((h) => h.conversation_id === conversation_id);
    if (existing) {
      existing.notes.push({ reason: r, summary: full.slice(0, 900), questions: qs });
      return { ok: true, ticket: existing.ticket, updated_existing_ticket: true, ...SAY, read_back_these_questions: qs, read_back_instruction: READ_BACK };
    }
    const ticket = `HS-${String(state.handoffs.length + 1001)}`;
    state.handoffs.push({ ticket, language: lang, reason: r, summary: full.slice(0, 900), questions: qs, callback_phone: digits, conversation_id, notes: [] });
    const queue = { en: 'front desk', es: 'Spanish-speaking staff', vi: 'Vietnamese-speaking staff (Alief)' }[lang];
    return { ok: true, ticket, queue, ...SAY, read_back_these_questions: qs, read_back_instruction: READ_BACK };
  },
};
