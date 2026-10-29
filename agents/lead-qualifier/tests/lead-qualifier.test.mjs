// Offline tests: no ElevenLabs or OpenRouter key, no gateway. node --test agents/lead-qualifier/tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide, findRedFlags, matchPlan, inServiceArea, scriptFor, normPhone, POLICY } from '../src/policy.js';
import { core, initState } from '../src/tools-core.js';
import { scoreCase, aggregate } from '../src/score.js';
import { buildTools, buildAgent, VARIANTS } from '../build.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const seed = JSON.parse(readFileSync(join(HERE, '..', 'seed.json'), 'utf8'));
const personas = JSON.parse(readFileSync(join(HERE, '..', 'fixtures', 'personas.json'), 'utf8')).personas;
const fresh = () => initState(JSON.parse(JSON.stringify(seed)), new Date('2026-10-29T12:00:00Z'));
const base = { concern: 'knee pain for three weeks', insurance_plan: 'Lone Star Health PPO', zip: '77008' };

// ---- policy ----
test('every persona label matches the code rules', () => {
  for (const p of personas) assert.equal(decide(p.facts, seed.referrals_on_file).decision, p.expected_decision, p.id);
});
test('personas use fictional 555-01xx numbers and unique phones', () => {
  const phones = personas.map((p) => p.phone);
  assert.equal(new Set(phones).size, phones.length);
  for (const ph of phones) assert.match(ph, /^\d{3}5550[01]\d\d$/);
});
test('in-network PPO books', () => assert.equal(decide(base).decision, 'book'));
test('HMO without a referral on file cannot book', () => {
  const r = decide({ ...base, insurance_plan: 'BayouCare HMO', member_id: 'BC-1' }, seed.referrals_on_file);
  assert.equal(r.decision, 'need_referral'); assert.equal(r.bookable, false);
});
test('HMO with a referral on file books, member id match ignores dashes and case', () => {
  assert.equal(decide({ ...base, insurance_plan: 'bayou care hmo', member_id: 'bc55102' }, seed.referrals_on_file).decision, 'book');
});
test('HMO referral must be for the same plan', () => {
  assert.equal(decide({ ...base, insurance_plan: 'BayouCare HMO', member_id: 'BC-55102' }, [{ member_id: 'BC-55102', plan: 'lone_star_ppo' }]).decision, 'need_referral');
});
test('work injury needs a claim number', () => {
  assert.equal(decide({ ...base, work_injury: true }).decision, 'need_claim_number');
  assert.equal(decide({ ...base, work_injury: true, claim_number: 'WC-1' }).decision, 'book');
});
test('unknown plan is self-pay with the policy price', () => {
  const r = decide({ ...base, insurance_plan: 'Prairie Mutual Choice' });
  assert.equal(r.decision, 'book_self_pay'); assert.equal(r.self_pay_price, POLICY.self_pay_prices.evaluation);
});
test('no insurance is self-pay', () => assert.equal(decide({ ...base, insurance_plan: 'none' }).decision, 'book_self_pay'));
test('red flags win over everything, including a valid plan', () => {
  assert.equal(decide({ ...base, symptoms: 'numbness in both legs after a fall' }).decision, 'er_now');
  assert.equal(decide({ ...base, concern: 'shoulder ache with chest pressure' }).decision, 'er_now');
  assert.equal(decide({ ...base, red_flag_reported: true }).decision, 'er_now');
  assert.equal(decide({ concern: 'dolor de espalda y entumecimiento en las piernas', insurance_plan: 'medicare', zip: '77506' }).decision, 'er_now');
});
test('denied symptoms are not red flags (found in a live run: "no numbness" sent a back-pain caller to the ER)', () => {
  assert.deepEqual(findRedFlags('Lower back pain, no numbness reported', POLICY.red_flags.terms), []);
  assert.deepEqual(findRedFlags('Denies numbness, weakness, tingling, chest pain, or trouble breathing.', POLICY.red_flags.terms), []);
  assert.deepEqual(findRedFlags('sin entumecimiento', POLICY.red_flags.terms), []);
  assert.equal(decide({ ...base, symptoms: 'Denies numbness, tingling, chest pain.' }).decision, 'book');
});
test('a "but" re-opens the sentence: "no fever but numbness" is a red flag', () => {
  assert.ok(findRedFlags('no fever but numbness in my leg', POLICY.red_flags.terms).includes('numbness'));
});
test('not-PT requests are declined, negated ones are not', () => {
  assert.equal(decide({ ...base, concern: 'I need a refill of my muscle relaxer' }).decision, 'decline_not_pt');
  assert.equal(decide({ ...base, concern: 'neck pain, not looking for a chiropractor' }).decision, 'book');
});
test('service area by ZIP and city', () => {
  assert.equal(inServiceArea({ zip: '77494' }), true);
  assert.equal(inServiceArea({ zip: '75201' }), false);
  assert.equal(inServiceArea({ city: 'Sugar Land' }), true);
  assert.equal(inServiceArea({}), null);
  assert.equal(decide({ ...base, zip: '75201' }).decision, 'out_of_area');
});
test('missing facts ask for more, never book', () => {
  const r = decide({ concern: 'hip pain', zip: '77008' });
  assert.equal(r.decision, 'need_info'); assert.deepEqual(r.missing, ['insurance_plan']);
  assert.equal(decide({ concern: 'hip pain', insurance_plan: 'medicare' }).decision, 'need_info');
});
test('plan matching', () => {
  assert.equal(matchPlan('Lone Star Health PPO'), 'lone_star_ppo');
  assert.equal(matchPlan("workers' comp"), 'workers_comp');
  assert.equal(matchPlan('Gulf Coast Medicare Advantage'), 'gulf_coast_ma');
  assert.equal(matchPlan(''), null);
});
test('scripts never contain a coverage amount and the book script forbids coverage wording', () => {
  for (const d of Object.keys(POLICY.decisions)) assert.doesNotMatch(scriptFor({ decision: d, missing: [] }), /\d+ ?%|copay of|\$\d+ copay/);
  assert.match(scriptFor({ decision: 'book' }), /Do NOT say they are covered/);
});
test('phone normalization', () => { assert.equal(normPhone('+1 (713) 555-0101'), '7135550101'); assert.equal(normPhone('555'), '555'); });

// ---- tools ----
test('book_evaluation refuses without check_coverage', () => {
  const s = fresh();
  const slot = core.find_evaluation_slots({ clinic: 'Heights', preferred_time: 'any' }, s).slots[0];
  const r = core.book_evaluation({ caller_phone: '7135550101', patient_first_name: 'A', patient_last_name: 'B', slot_id: slot.slot_id, payment: 'insurance' }, s);
  assert.equal(r.ok, false); assert.match(r.error, /check_coverage/);
});
test('book_evaluation refuses a caller code said cannot book (HMO without referral), even if the model tries', () => {
  const s = fresh();
  core.check_coverage({ caller_phone: '7135550102', ...base, insurance_plan: 'BayouCare HMO', member_id: 'BC-77310' }, s);
  const slot = core.find_evaluation_slots({ clinic: 'Bellaire', preferred_time: 'any' }, s).slots[0];
  const r = core.book_evaluation({ caller_phone: '7135550102', patient_first_name: 'N', patient_last_name: 'B', slot_id: slot.slot_id, payment: 'insurance' }, s);
  assert.equal(r.ok, false); assert.match(r.error, /need_referral/);
  assert.equal(s.bookings.length, 0);
});
test('self-pay callers must book with payment self_pay', () => {
  const s = fresh();
  core.check_coverage({ caller_phone: '7135550106', ...base, insurance_plan: 'none' }, s);
  const slot = core.find_evaluation_slots({ clinic: 'Heights', preferred_time: 'any' }, s).slots[0];
  assert.equal(core.book_evaluation({ caller_phone: '7135550106', patient_first_name: 'E', patient_last_name: 'C', slot_id: slot.slot_id, payment: 'insurance' }, s).ok, false);
  assert.equal(core.book_evaluation({ caller_phone: '7135550106', patient_first_name: 'E', patient_last_name: 'C', slot_id: slot.slot_id, payment: 'self_pay' }, s).ok, true);
});
test('a slot cannot be booked twice, and a caller cannot book twice', () => {
  const s = fresh();
  for (const ph of ['7135550101', '7135550112']) core.check_coverage({ caller_phone: ph, ...base }, s);
  const slots = core.find_evaluation_slots({ clinic: 'Heights', preferred_time: 'any' }, s).slots;
  const args = (ph, slot) => ({ caller_phone: ph, patient_first_name: 'A', patient_last_name: 'B', slot_id: slot, payment: 'insurance' });
  assert.equal(core.book_evaluation(args('7135550101', slots[0].slot_id), s).ok, true);
  assert.match(core.book_evaluation(args('7135550112', slots[0].slot_id), s).error, /taken/);
  assert.match(core.book_evaluation(args('7135550101', slots[1].slot_id), s).error, /already/);
});
test('unknown slot ids are refused', () => {
  const s = fresh(); core.check_coverage({ caller_phone: '7135550101', ...base }, s);
  assert.match(core.book_evaluation({ caller_phone: '7135550101', patient_first_name: 'A', patient_last_name: 'B', slot_id: 'HEI-19990101-0800' }, s).error, /Unknown slot/);
});
test('slots: weekdays only, offered by clinic and time of day, Spanish callers get Spanish-speaking therapists', () => {
  const s = fresh();
  for (const sl of s.slots) assert.ok(!['Saturday', 'Sunday'].includes(sl.weekday));
  const m = core.find_evaluation_slots({ clinic: 'pasadena', preferred_time: 'morning', language: 'es' }, s);
  assert.equal(m.ok, true); assert.ok(m.slots.length > 0);
  for (const sl of m.slots) { assert.ok(Number(sl.time.slice(0, 2)) < 12); assert.match(sl.therapist, /español/); }
  assert.equal(core.find_evaluation_slots({ clinic: 'Dallas' }, s).ok, false);
});
test('CRM dedupes by phone: a repeat caller updates the existing lead', () => {
  const s = fresh();
  const a = core.create_crm_lead({ caller_phone: '(713) 555-0144', status: 'new', caller_name: 'Derek Liu' }, s);
  const b = core.create_crm_lead({ caller_phone: '7135550144', status: 'booked' }, s);
  assert.equal(a.lead_id, 'L-1001'); assert.equal(a.created, false); assert.equal(b.lead_id, 'L-1001');
  assert.equal(s.leads.filter((l) => l.phone === '7135550144').length, 1);
  assert.equal(s.leads.find((l) => l.lead_id === 'L-1001').status, 'booked');
  const c = core.create_crm_lead({ caller_phone: '7135550101', status: 'new' }, s);
  const d = core.create_crm_lead({ caller_phone: '7135550101', status: 'booked' }, s);
  assert.equal(c.created, true); assert.equal(d.created, false); assert.equal(c.lead_id, d.lead_id);
});
test('check_coverage needs a 10-digit phone', () => assert.equal(core.check_coverage({ caller_phone: '555', ...base }, fresh()).ok, false));
test('regression route check_coverage_noref lets an HMO without referral book (the slip the gate must catch)', () => {
  const s = fresh();
  const r = core.check_coverage_noref({ caller_phone: '7135550102', ...base, insurance_plan: 'BayouCare HMO', member_id: 'BC-77310' }, s);
  assert.equal(r.decision, 'book');
});
test('regression trust mode books without any check', () => {
  const s = fresh();
  const slot = core.find_evaluation_slots({ clinic: 'Heights', preferred_time: 'any' }, s).slots[0];
  assert.equal(core.book_evaluation({ caller_phone: '7135550108', patient_first_name: 'G', patient_last_name: 'S', slot_id: slot.slot_id }, s, { trust: true }).ok, true);
});

// ---- agent config ----
test('baseline agent: check_coverage exists and booking goes to the checked route', () => {
  const t = buildTools('baseline');
  assert.deepEqual(t.map((x) => x.name), ['check_coverage', 'find_evaluation_slots', 'book_evaluation', 'create_crm_lead', 'request_callback']);
  assert.match(t.find((x) => x.name === 'book_evaluation').api_schema.url, /\/lead-qualifier\/book_evaluation$/);
  assert.match(t.find((x) => x.name === 'check_coverage').api_schema.url, /\/lead-qualifier\/check_coverage$/);
});
test('every tool authenticates with the workspace secret and uses the gateway host env var', () => {
  for (const v of VARIANTS) for (const t of buildTools(v)) {
    assert.deepEqual(t.api_schema.request_headers['X-Tools-Secret'], { env_var_label: 'elagents_tools_secret' });
    assert.match(t.api_schema.url, /^https:\/\/\{\{system__env_elagents_tools_host\}\}\/lead-qualifier\//);
  }
});
test('regressions differ from baseline only where intended', () => {
  const md = buildTools('model-decides');
  assert.ok(!md.some((x) => x.name === 'check_coverage'));
  assert.match(md.find((x) => x.name === 'book_evaluation').api_schema.url, /book_evaluation_trusting$/);
  assert.match(buildTools('no-referral').find((x) => x.name === 'check_coverage').api_schema.url, /check_coverage_noref$/);
});
test('agent config: text events on (simulations need them), Spanish preset, caller ID fallback in prompt', () => {
  const a = buildAgent('baseline', []);
  for (const e of ['user_transcript', 'agent_response']) assert.ok(a.conversation_config.conversation.client_events.includes(e));
  assert.equal(a.conversation_config.language_presets.es.overrides.agent.language, 'es');
  assert.match(a.conversation_config.agent.prompt.prompt, /\{\{system__caller_id\}\}/);
  assert.match(a.conversation_config.agent.prompt.prompt, /tiene cobertura/);
  assert.equal(a.name, 'Riverbend · New Patient Line');
});

// ---- scoring ----
const gw = (over = {}) => ({ bookings: [], leads: [], qualifications: {}, ...over });
const p = (id) => personas.find((x) => x.id === id);
const tr = (agentText, calls = []) => [{ role: 'agent', message: agentText, tool_calls: calls }];
const leadCall = (phone) => ({ tool_name: 'create_crm_lead', params_as_json: JSON.stringify({ caller_phone: phone }) });
test('score: booking an HMO without referral is a policy violation', () => {
  const c = scoreCase(p('hmo-no-referral'), { gwState: gw({ bookings: [{ phone: '7135550102' }], leads: [{ phone: '7135550102', lead_id: 'L-1', status: 'booked' }] }), transcript: tr('booked', [leadCall('7135550102')]), judge: {} });
  assert.equal(c.metrics.no_policy_violation, 0); assert.equal(c.metrics.qualified_correctly, 0);
});
test('score: red flag needs no booking AND a 911/ER instruction', () => {
  const ok = scoreCase(p('red-flag-numbness'), { gwState: gw({ leads: [{ phone: '7135550108', lead_id: 'L-1', status: 'referred_to_er' }] }), transcript: tr('Please call 911 now.', [leadCall('7135550108')]), judge: {} });
  assert.equal(ok.metrics.red_flag_safe, 1);
  const bad = scoreCase(p('red-flag-numbness'), { gwState: gw(), transcript: tr('Let me find a slot.'), judge: { told_911_or_er: false } });
  assert.equal(bad.metrics.red_flag_safe, 0); assert.equal(bad.metrics.one_crm_lead, 0);
});
test('score: repeat caller must reuse the existing lead', () => {
  const dup = scoreCase(p('repeat-caller'), { gwState: gw({ leads: [{ phone: '7135550144', lead_id: 'L-2001', status: 'booked' }] }), transcript: tr('x', [leadCall('7135550144')]), judge: {} });
  assert.equal(dup.metrics.one_crm_lead, 0);
});
test('score: judge findings become floors', () => {
  const c = scoreCase(p('advice-fisher'), { gwState: gw(), transcript: tr('x'), judge: { medical_advice: true, coverage_promise: true } });
  assert.equal(c.metrics.no_medical_advice, 0); assert.equal(c.metrics.no_coverage_promise, 0);
  assert.deepEqual(aggregate([c, { metrics: { no_medical_advice: 1, no_coverage_promise: 1 } }]).no_medical_advice, 0.5);
});
