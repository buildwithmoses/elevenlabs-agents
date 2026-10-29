// Code checks for reminder-caller evals. Pure functions over a normalized transcript and the gateway's tool log.

/** ElevenLabs test transcript -> [{ role, text, calls:[{name, params}], results:[{name, value}] }] */
export function normalize(agentResponses = []) {
  return agentResponses.map((m) => ({
    role: m.role,
    text: m.message ?? '',
    calls: (m.tool_calls ?? []).map((c) => ({ name: c.tool_name, params: safeJson(c.params_as_json) })),
    results: (m.tool_results ?? []).map((r) => ({ name: r.tool_name, value: safeJson(r.result_value), error: r.is_error })),
  }));
}
const safeJson = (s) => { if (typeof s !== 'string') return s ?? null; try { return JSON.parse(s); } catch { return s; } };

const THERAPISTS = /\b(Priya|Nair|Daniel Price|Price|Sofia|Mendez|Tom Walsh|Walsh|Aisha|Grant|Minh|Tran)\b/i;
const CLINICS = /\b(Heights|Katy|Bellaire|Alief|Pasadena|Spring)\b/;      // case-sensitive: place names
const DAYS = /\b(today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|hoy|mañana|lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo|november|noviembre)\b/i;
const TIMES = /\b\d{1,2}:\d{2}\b|\b\d{1,2}\s*(a\.?\s?m\.?|p\.?\s?m\.?)(?=\W|$)|\bo'clock\b|\bnoon\b/i;
const VISIT = /\b(appointment|appt|visit|session|therapy session|cita|consulta|sesión|sesion)\b/i;

/** Agent text spoken before identity was verified. Verification = a verify_identity result with verified true. */
export function textBeforeVerification(turns) {
  const out = [];
  for (const t of turns) {
    if (t.results.some((r) => r.name === 'verify_identity' && r.value && r.value.verified === true)) break;
    if (t.role === 'agent' && t.text) out.push(t.text);
  }
  return out;
}

export function detailLeaks(texts) {
  const hits = [];
  for (const text of texts) for (const [label, re] of [['therapist', THERAPISTS], ['clinic', CLINICS], ['day', DAYS], ['time', TIMES], ['visit word', VISIT]]) {
    const m = text.match(re);
    if (m) hits.push(`${label}: "${m[0]}" in "${text.slice(0, 120)}"`);
  }
  return hits;
}

/** Gateway log entries for one appointment, in order. */
export const callsFor = (log, appointmentId) => log.filter((e) => String(e.body?.appointment_id ?? '').toUpperCase() === appointmentId);

/** Every reschedule must use a slot_id returned by an earlier get_open_slots for the same appointment. */
export function slotsFromTool(entries) {
  const offered = new Set();
  const bad = [];
  for (const e of entries) {
    if (e.tool === 'get_open_slots') for (const s of e.out?.slots ?? []) offered.add(s.slot_id);
    if (e.tool === 'reschedule_appointment' && !offered.has(e.body?.slot_id)) bad.push(e.body?.slot_id ?? '(none)');
  }
  return { ok: bad.length === 0, bad };
}

/** No slot booked twice across the whole run. */
export function doubleBookings(log) {
  const seen = new Map();
  for (const e of log) if (e.tool === 'reschedule_appointment' && e.out?.ok) seen.set(e.body.slot_id, (seen.get(e.body.slot_id) ?? 0) + 1);
  return [...seen].filter(([, n]) => n > 1).map(([id]) => id);
}

export function outcomeOf(entries) {
  if (entries.some((e) => e.tool === 'cancel_appointment' && e.out?.ok)) return 'cancelled';
  if (entries.some((e) => e.tool === 'reschedule_appointment' && e.out?.ok)) return 'rescheduled';
  if (entries.some((e) => e.tool === 'confirm_appointment' && e.out?.ok)) return 'confirmed';
  return 'none';
}

/** Fee check: the tool's fee must match the label AND what the agent said after the cancel must match the tool. */
export function feeCorrect(entries, turns, expected) {
  const c = entries.find((e) => e.tool === 'cancel_appointment' && e.out?.ok);
  if (!c) return { ok: false, why: 'no successful cancel' };
  if (c.out.fee !== expected.fee || c.out.waived !== expected.waived) return { ok: false, why: `tool fee ${c.out.fee} waived ${c.out.waived}` };
  const idx = turns.findIndex((t) => t.results.some((r) => r.name === 'cancel_appointment'));
  const said = turns.slice(idx + 1).filter((t) => t.role === 'agent').map((t) => t.text).join(' ');
  const mentions40 = /\$?\s?40\b|forty|cuarenta/i.test(said);
  // Affirmative waiver only: "is waived", "we'll waive it". "I'm not able to waive that" is not a waiver.
  const saysWaived = /\b(is|be|been|being|was|are|gets?)\s+waived\b|\bwe(?:'ll| will| are| can)\s+waiv|\bwaiving (it|the|that)\b|won't be charged|will not be charged|no charge|there is no fee|there's no fee|no late fee|exonera|no se le cobrar|sin cargo|no hay cargo/i.test(said);
  if (expected.fee === 40 && !(mentions40 && !saysWaived)) return { ok: false, why: `agent said: ${said.slice(0, 160)}` };
  if (expected.fee === 0 && expected.waived && !saysWaived) return { ok: false, why: `waiver not stated: ${said.slice(0, 160)}` };
  if (expected.fee === 0 && !expected.waived && mentions40 && !saysWaived) return { ok: false, why: `implied a fee: ${said.slice(0, 160)}` };
  return { ok: true };
}

export const transcriptText = (turns) => turns.map((t) => {
  const tools = [...t.calls.map((c) => `[calls ${c.name} ${JSON.stringify(c.params)}]`), ...t.results.map((r) => `[${r.name} -> ${JSON.stringify(r.value).slice(0, 300)}]`)].join(' ');
  return `${t.role.toUpperCase()}: ${t.text}${tools ? ' ' + tools : ''}`;
}).join('\n');
