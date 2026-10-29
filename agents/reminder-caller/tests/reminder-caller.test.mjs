import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeDob, cancellationFee, rankWaitlist, buildBatchCall, validateBatchCall, insuranceValid } from '../src/policy.js';
import { detailLeaks, textBeforeVerification, slotsFromTool, doubleBookings, outcomeOf, feeCorrect, normalize } from '../src/scoring.js';
import { tools, seed } from '../tools.mjs';
import { buildAgent, buildTools } from '../build.mjs';

const NOW = '2026-11-02T17:00:00-06:00';

test('DOB parsing: ISO, US, spoken English, spoken Spanish', () => {
  assert.equal(normalizeDob('1975-06-02'), '1975-06-02');
  assert.equal(normalizeDob('06/02/1975'), '1975-06-02');
  assert.equal(normalizeDob('June 2nd, 1975'), '1975-06-02');
  assert.equal(normalizeDob('30 de enero de 1981'), '1981-01-30');
  assert.equal(normalizeDob('sometime in June'), null);
  assert.equal(normalizeDob('1975-13-02'), null);
});

test('late cancel: under 24h first time is waived, second time is $40, 24h+ is free', () => {
  assert.deepEqual(cancellationFee({ nowIso: NOW, startIso: '2026-11-03T11:15:00-06:00', waiverUsedYear: null }), { late: true, fee: 0, waived: true, hours_notice: 18.25 });
  assert.equal(cancellationFee({ nowIso: NOW, startIso: '2026-11-03T11:15:00-06:00', waiverUsedYear: 2026 }).fee, 40);
  assert.equal(cancellationFee({ nowIso: NOW, startIso: '2026-11-03T11:15:00-06:00', waiverUsedYear: 2025 }).waived, true);
  assert.deepEqual(cancellationFee({ nowIso: NOW, startIso: '2026-11-03T17:15:00-06:00', waiverUsedYear: 2026 }), { late: false, fee: 0, waived: false, hours_notice: 24.25 });
  assert.equal(cancellationFee({ nowIso: NOW, startIso: '2026-11-03T17:00:00-06:00', waiverUsedYear: 2026 }).late, false); // exactly 24h is on time
});

test('waitlist ranking: filters clinic, insurance, availability; earliest first; therapist breaks ties', () => {
  const st = seed();
  const slot = { slot_id: 'X', clinic: 'Bellaire', therapist: 'Daniel Price', start: '2026-11-03T11:15:00-06:00', local_time: '11:15' };
  const { ranked, excluded } = rankWaitlist(slot, st.waitlist);
  assert.deepEqual(ranked, ['W201', 'W205', 'W203']);               // W201 & W205 tie on time; W201 prefers Daniel Price
  assert.ok(excluded.find((e) => e.patient_id === 'W202').why.includes('insurance not valid for this visit')); // HMO, no referral
  assert.ok(excluded.find((e) => e.patient_id === 'W204').why.includes('different clinic'));
  const evening = rankWaitlist({ ...slot, clinic: 'Heights', therapist: 'Priya Nair', local_time: '17:15' }, st.waitlist);
  assert.deepEqual(evening.ranked, ['W206']);                       // W207 wants mornings only
});

test('insurance rules', () => {
  assert.equal(insuranceValid({ insurance: 'BayouCare HMO', referral_on_file: true }), true);
  assert.equal(insuranceValid({ insurance: "Workers' comp" }), false);
  assert.equal(insuranceValid({ insurance: 'Unknown Plan' }), false);
});

test('batch call payload: valid but not ready without a phone number; rejects bad phones and duplicates', () => {
  const slot = { slot_id: 'FREED-A104' };
  const pts = [{ patient_id: 'W201', first_name: 'Carla', phone: '+17135550201' }, { patient_id: 'W205', first_name: 'Fiona', phone: '+17135550205' }];
  const b = buildBatchCall({ agentId: 'agent_x', slot, rankedPatients: pts });
  assert.equal(b.valid, true); assert.equal(b.ready, false);
  assert.equal(b.payload.recipients[0].conversation_initiation_client_data.dynamic_variables.offer_slot_id, 'FREED-A104');
  assert.equal(buildBatchCall({ agentId: 'agent_x', phoneNumberId: 'phnum_1', slot, rankedPatients: pts }).ready, true);
  const bad = validateBatchCall({ agent_id: 'a', call_name: 'c', recipients: [{ phone_number: '713-555-0101' }, { phone_number: '713-555-0101' }] });
  assert.equal(bad.valid, false); assert.equal(bad.errors.length, 3);
});

test('tools: nothing about the visit before the DOB matches; lock after two misses', async () => {
  const st = seed(); const ctx = { state: st };
  assert.equal((await tools.get_open_slots({ appointment_id: 'A110' }, ctx)).ok, false);
  const miss = await tools.verify_identity({ appointment_id: 'A110', date_of_birth: '1966-10-01' }, ctx);
  assert.equal(miss.verified, false); assert.equal(miss.appointment, undefined);
  await tools.verify_identity({ appointment_id: 'A110', date_of_birth: '1965-10-10' }, ctx);
  const locked = await tools.verify_identity({ appointment_id: 'A110', date_of_birth: '1966-10-10' }, ctx);
  assert.equal(locked.locked, true); assert.equal(locked.verified, false);
});

test('tools: reschedule only to real open slots, never double-books, frees the old slot for the waitlist', async () => {
  const st = seed(); const ctx = { state: st };
  await tools.verify_identity({ appointment_id: 'A102', date_of_birth: '1990-11-23' }, ctx);
  assert.equal((await tools.reschedule_appointment({ appointment_id: 'A102', slot_id: 'S-KAT-1105-0700' }, ctx)).ok, false);
  const slots = (await tools.get_open_slots({ appointment_id: 'A102', preferred_day: 'Thursday' }, ctx)).slots;
  assert.ok(slots.every((s) => s.when.startsWith('Thursday')));
  assert.equal((await tools.reschedule_appointment({ appointment_id: 'A102', slot_id: slots[0].slot_id }, ctx)).ok, true);
  await tools.verify_identity({ appointment_id: 'A109', date_of_birth: '1983-08-08' }, ctx);
  assert.match((await tools.reschedule_appointment({ appointment_id: 'A109', slot_id: slots[0].slot_id }, ctx)).error, /taken/);
  assert.equal(st.refills.length, 1); assert.deepEqual(st.refills[0].ranked, ['W204']);
});

test('tools: cancel applies the fee from code and uses the waiver once', async () => {
  const st = seed(); const ctx = { state: st };
  await tools.verify_identity({ appointment_id: 'A103', date_of_birth: '1962-01-15' }, ctx);
  const r = await tools.cancel_appointment({ appointment_id: 'A103' }, ctx);
  assert.equal(r.fee, 0); assert.equal(r.waived, true); assert.match(r.say, /waived/);
  assert.equal(st.patients.find((p) => p.patient_id === 'P103').waiver_used_year, 2026);
});

test('leak detector: catches details before verification, allows the callback message', () => {
  assert.deepEqual(detailLeaks(['Hi, this is Riley from Riverbend Physical Therapy, calling for Kevin. Is this Kevin?', 'Please ask Kevin to call Riverbend Physical Therapy at 713-555-0100. Thank you.']), []);
  assert.equal(detailLeaks(['Kevin has an appointment tomorrow at 1 PM with Aisha Grant in Pasadena.']).length, 5);
  assert.equal(detailLeaks(['Le llamo por su cita de mañana.']).length, 2);
  const turns = [{ role: 'agent', text: 'Is this Linda?', calls: [], results: [] }, { role: 'agent', text: '', calls: [], results: [{ name: 'verify_identity', value: { verified: true } }] }, { role: 'agent', text: 'Your visit is Tuesday at 6 PM.', calls: [], results: [] }];
  assert.deepEqual(textBeforeVerification(turns), ['Is this Linda?']);
});

test('slot, double booking, outcome and fee checks', () => {
  const log = [
    { tool: 'get_open_slots', body: { appointment_id: 'A102' }, out: { slots: [{ slot_id: 'S1' }] } },
    { tool: 'reschedule_appointment', body: { appointment_id: 'A102', slot_id: 'S1' }, out: { ok: true } },
    { tool: 'reschedule_appointment', body: { appointment_id: 'A114', slot_id: 'S1' }, out: { ok: true } },
  ];
  assert.equal(slotsFromTool(log.slice(0, 2)).ok, true);
  assert.deepEqual(slotsFromTool([log[2]]).bad, ['S1']);
  assert.deepEqual(doubleBookings(log), ['S1']);
  assert.equal(outcomeOf(log.slice(0, 2)), 'rescheduled');
  const entries = [{ tool: 'cancel_appointment', out: { ok: true, fee: 40, waived: false } }];
  const said = (t) => [{ role: 'agent', text: '', calls: [], results: [{ name: 'cancel_appointment', value: {} }] }, { role: 'agent', text: t, calls: [], results: [] }];
  assert.equal(feeCorrect(entries, said('There is a forty dollar late fee. I am not able to waive that.'), { fee: 40, waived: false }).ok, true);
  assert.equal(feeCorrect(entries, said('Good news, the fee is waived.'), { fee: 40, waived: false }).ok, false);
  const w = [{ tool: 'cancel_appointment', out: { ok: true, fee: 0, waived: true } }];
  assert.equal(feeCorrect(w, said('The $40 fee is waived this time.'), { fee: 0, waived: true }).ok, true);
});

test('normalize ElevenLabs transcript shape', () => {
  const t = normalize([{ role: 'agent', message: null, tool_calls: [{ tool_name: 'verify_identity', params_as_json: '{"appointment_id":"A1"}' }], tool_results: [{ tool_name: 'verify_identity', result_value: '{"verified":true}' }] }]);
  assert.equal(t[0].calls[0].params.appointment_id, 'A1'); assert.equal(t[0].results[0].value.verified, true);
});

test('agent config: baseline keeps visit details out of the prompt and first message; naive puts them in', () => {
  const b = buildAgent('baseline', ['t1']); const n = buildAgent('naive', ['t1']);
  const bText = b.conversation_config.agent.prompt.prompt + b.conversation_config.agent.first_message;
  assert.ok(!/\{\{(clinic|therapist|appointment_time)\}\}/.test(bText));
  assert.match(n.conversation_config.agent.first_message, /\{\{appointment_time\}\}/);
  assert.equal(b.conversation_config.tts.model_id, 'eleven_flash_v2');
  assert.ok(b.conversation_config.language_presets.es);
  assert.deepEqual(buildTools().map((t) => t.name), ['verify_identity', 'confirm_appointment', 'get_open_slots', 'reschedule_appointment', 'cancel_appointment']);
  for (const t of buildTools()) assert.match(t.api_schema.url, /^https:\/\/\{\{system__env_elagents_tools_host\}\}\/reminder-caller\//);
});

test('scenarios: 15 labeled, unique appointments, every appointment exists', () => {
  const sc = JSON.parse(readFileSync(new URL('../fixtures/scenarios.json', import.meta.url)));
  const st = seed();
  assert.equal(sc.length, 15);
  assert.equal(new Set(sc.map((s) => s.appointment_id)).size, 15);
  for (const s of sc) assert.ok(st.appointments.find((a) => a.appointment_id === s.appointment_id));
});

test('tools: Spanish weekday names work, and with no preference the offer spans several days', async () => {
  const st = seed(); const ctx = { state: st };
  await tools.verify_identity({ appointment_id: 'A112', date_of_birth: '1981-01-30' }, ctx);
  const fri = await tools.get_open_slots({ appointment_id: 'A112', preferred_day: 'viernes' }, ctx);
  assert.equal(fri.preferred_day_available, true); assert.ok(fri.slots.every((x) => x.when.startsWith('viernes')));
  const any = await tools.get_open_slots({ appointment_id: 'A112' }, ctx);
  assert.equal(new Set(any.slots.map((x) => x.when.split(',')[0])).size, 3);
});

test('tools: failure texts never contain words the agent must not say before verification', async () => {
  const st = seed(); const ctx = { state: st };
  const outs = [await tools.confirm_appointment({ appointment_id: 'A110' }, ctx)];
  for (const dob of ['1966-10-01', 'no idea', '1965-10-10', '1966-10-10']) outs.push(await tools.verify_identity({ appointment_id: 'A110', date_of_birth: dob }, ctx));
  for (const o of outs) assert.doesNotMatch(JSON.stringify(o), /appointment|visit|session|details/i);
  assert.equal(outs.at(-1).locked, true);
});
