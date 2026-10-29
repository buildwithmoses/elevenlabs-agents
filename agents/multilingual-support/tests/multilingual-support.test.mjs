// Offline tests: no ElevenLabs or OpenRouter key needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeDob, sameName, verify } from '../src/identity.js';
import { detectLanguage } from '../src/langid.js';
import { languageCheck, privacyCheck, handoffCheck, accountOrderCheck } from '../src/checks.js';
import { tools, seed } from '../tools.mjs';
import { buildAgent, TOOL_DEFS } from '../build.mjs';

const personas = JSON.parse(readFileSync(new URL('../fixtures/personas.json', import.meta.url), 'utf8')).personas;

test('dates of birth in English, Spanish, Vietnamese and numeric forms normalize', () => {
  assert.equal(normalizeDob('1981-03-14'), '1981-03-14');
  assert.equal(normalizeDob('03/14/1981'), '1981-03-14');
  assert.equal(normalizeDob('14/03/1981'), '1981-03-14');
  assert.equal(normalizeDob('March 14, 1981'), '1981-03-14');
  assert.equal(normalizeDob('14 de marzo de 1981'), '1981-03-14');
  assert.equal(normalizeDob('ngày 2 tháng 11 năm 1958'), '1958-11-02');
  assert.equal(normalizeDob('sometime in the eighties'), null);
});

test('names match across accents, case and word order, not partial names', () => {
  assert.ok(sameName('Nguyễn Văn Thành', 'thanh van nguyen'));
  assert.ok(sameName('María González', 'Maria Gonzalez'));
  assert.ok(!sameName('Maria', 'Maria Gonzalez'));
});

test('verify needs both name and DOB to match the same patient', () => {
  const { patients } = seed();
  assert.equal(verify(patients, 'Maria Gonzalez', '1981-03-14').verified, true);
  assert.equal(verify(patients, 'Maria Gonzalez', '1966-09-09').verified, false);   // Rosa's DOB
  assert.equal(verify(patients, 'Rosa Delgado', '').verified, false);
});

test('account tool refuses without verification in the same conversation', async () => {
  const state = seed();
  const ctx = { state };
  assert.equal((await tools.get_account_summary({ conversation_id: 'c1' }, ctx)).ok, false);
  assert.equal((await tools.verify_identity({ full_name: 'James Whitaker', date_of_birth: '1991-07-02', conversation_id: 'c1' }, ctx)).verified, false);
  assert.equal((await tools.get_account_summary({ conversation_id: 'c1' }, ctx)).ok, false);
  assert.equal((await tools.verify_identity({ full_name: 'James Whitaker', date_of_birth: 'July 22, 1990', conversation_id: 'c1' }, ctx)).verified, true);
  assert.equal((await tools.get_account_summary({ conversation_id: 'c1' }, ctx)).balance, '$220.00');
  assert.equal((await tools.get_account_summary({ conversation_id: 'c2' }, ctx)).ok, false, 'verification does not carry over to another call');
});

test('verification failure never says which field was wrong, and locks after 3 attempts', async () => {
  const ctx = { state: seed() };
  const r = await tools.verify_identity({ full_name: 'Maria Gonzalez', date_of_birth: '1990-01-01', conversation_id: 'x' }, ctx);
  assert.deepEqual(r, { verified: false, reason: 'could_not_verify' });
  await tools.verify_identity({ full_name: 'a', date_of_birth: '1990-01-01', conversation_id: 'x' }, ctx);
  await tools.verify_identity({ full_name: 'b', date_of_birth: '1990-01-01', conversation_id: 'x' }, ctx);
  const locked = await tools.verify_identity({ full_name: 'Maria Gonzalez', date_of_birth: '1981-03-14', conversation_id: 'x' }, ctx);
  assert.equal(locked.verified, false);
  assert.equal(locked.reason, 'too_many_attempts');
});

test('handoff tickets route by language and sanitize the reason', async () => {
  const ctx = { state: seed() };
  const r = await tools.handoff_to_staff({ language: 'vi', reason: 'made_up', summary: 's', callback_phone: '713-555-0199', conversation_id: 'c', questions: ['test question'] }, ctx);
  assert.equal(r.queue, 'Vietnamese-speaking staff (Alief)');
  assert.equal(ctx.state.handoffs[0].reason, 'other');
});

test('language ID: en, es, vi, and short replies are undetermined', () => {
  assert.equal(detectLanguage('Our Heights clinic is open on Saturday from eight to one.').lang, 'en');
  assert.equal(detectLanguage('La clínica de Pasadena está en Spencer Highway y el estacionamiento es gratis.').lang, 'es');
  assert.equal(detectLanguage('Dạ, phòng khám Alief không mở cửa vào thứ Bảy ạ.').lang, 'vi');
  assert.equal(detectLanguage('Dạ, phòng khám Alief ở 11800 Bellaire Boulevard, Suite 15 ạ, đậu xe miễn phí.').lang, 'vi');
  assert.equal(detectLanguage('OK gracias').lang, null);
});

test('language check follows the caller, including a mid-call switch', () => {
  const ok = [
    { role: 'user', message: 'Hi, what should I bring to my first visit?' },
    { role: 'agent', message: 'Please bring your photo ID and your insurance card to the visit.' },
    { role: 'user', message: 'Cho tôi hỏi ở phòng khám Alief thì đậu xe ở đâu vậy?' },
    { role: 'agent', message: 'Dạ, chị có thể đậu xe miễn phí ở bãi đậu xe chung với trung tâm mua sắm ạ.' },
  ];
  assert.equal(languageCheck(ok, 'en').pass, true);
  const bad = [...ok.slice(0, 3), { role: 'agent', message: 'You can park for free in the lot shared with the shopping center.' }];
  const r = languageCheck(bad, 'en');
  assert.equal(r.pass, false);
  assert.equal(r.bad[0].expected, 'vi');
});

test('privacy and ordering checks catch details before verification', () => {
  const leak = [{ role: 'agent', message: 'Your balance is $85.40.' }, { role: 'agent', tool_results: [{ tool_name: 'verify_identity', result_value: '{"verified":true}' }] }];
  assert.equal(privacyCheck(leak, ['$85.40']).pass, false);
  const fine = [leak[1], leak[0]];
  assert.equal(privacyCheck(fine, ['$85.40']).pass, true);
  assert.equal(accountOrderCheck([{ role: 'agent', tool_calls: [{ tool_name: 'get_account_summary' }] }]).pass, false);
});

test('handoff check: required, forbidden, any', () => {
  assert.equal(handoffCheck(['handoff_to_staff'], 'required').pass, true);
  assert.equal(handoffCheck([], 'required').pass, false);
  assert.equal(handoffCheck(['handoff_to_staff'], 'forbidden').pass, false);
  assert.equal(handoffCheck([], 'any').pass, true);
});

test('baseline config: ES/VI presets, language detection, three tools, KB, secret header from env var', () => {
  const c = buildAgent({ variant: 'baseline', kbDocs: [{ id: 'kb1', name: 'g' }], toolIds: ['a', 'b', 'c'] });
  assert.deepEqual(Object.keys(c.conversation_config.language_presets).sort(), ['es', 'vi']);
  assert.ok(c.conversation_config.agent.prompt.built_in_tools.language_detection);
  assert.equal(c.conversation_config.agent.prompt.tool_ids.length, 3);
  assert.equal(TOOL_DEFS.length, 4);
  assert.equal(c.conversation_config.agent.prompt.knowledge_base[0].usage_mode, 'prompt');
  for (const t of TOOL_DEFS) {
    assert.deepEqual(t.api_schema.request_headers['X-Tools-Secret'], { env_var_label: 'elagents_tools_secret' });
    assert.ok(t.api_schema.url.startsWith('https://{{system__env_elagents_tools_host}}/multilingual-support/'));
    if (t.name !== 'check_cancellation_fee') assert.equal(t.api_schema.request_body_schema.properties.conversation_id.dynamic_variable, 'system__conversation_id');
  }
});

test('regression config is English-only with no language detection and no presets', () => {
  const c = buildAgent({ variant: 'english-only', kbDocs: [], toolIds: [] });
  assert.deepEqual(c.conversation_config.language_presets, {}, 'explicitly cleared, because PATCH merges');
  assert.equal(c.conversation_config.agent.prompt.built_in_tools.language_detection, null);
  assert.match(c.conversation_config.agent.prompt.prompt, /Always respond in English/);
});

test('personas: 18, every language covered, every expectation labelled', () => {
  assert.equal(personas.length, 18);
  for (const l of ['en', 'es', 'vi']) assert.ok(personas.some((p) => p.lang === l));
  assert.ok(personas.some((p) => p.id.startsWith('switch-')));
  for (const p of personas) { assert.ok(['required', 'forbidden', 'any'].includes(p.expect.handoff)); assert.ok(p.answer_key.length > 10); }
  assert.ok(personas.filter((p) => p.expect.handoff === 'required').length >= 5);
});

test('no secrets or keys in committed config files', () => {
  for (const f of ['../build.mjs', '../tools.mjs', '../fixtures/personas.json', '../knowledge_base/riverbend-patient-guide.md']) {
    const raw = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.ok(!/sk-or-v1-|xi-api-key\s*[:=]\s*['"][a-z0-9]{20}|sk_[a-f0-9]{40}/i.test(raw), f);
  }
});

test('repeat handoffs in one call update a single ticket', async () => {
  const ctx = { state: seed() };
  const a = await tools.handoff_to_staff({ language: 'es', reason: 'caller_upset', summary: 'one', callback_phone: '7135550199', conversation_id: 'c9', questions: ['test question'] }, ctx);
  const b = await tools.handoff_to_staff({ language: 'es', reason: 'caller_upset', summary: 'two', callback_phone: '7135550199', conversation_id: 'c9', questions: ['test question'] }, ctx);
  assert.equal(a.ticket, b.ticket);
  assert.equal(b.updated_existing_ticket, true);
  assert.equal(ctx.state.handoffs.length, 1);
});

test('cancellation fee is decided in code: 4pm today to 9am tomorrow is late', async () => {
  const { cancellationFee } = await import('../src/fees.js');
  assert.deepEqual(
    (({ late, fee, hours_notice }) => ({ late, fee, hours_notice }))(cancellationFee({ now_hour: 16, appt_day_offset: 1, appt_hour: 9 })),
    { late: true, fee: 40, hours_notice: 17 });
  assert.equal(cancellationFee({ now_hour: 8, appt_day_offset: 2, appt_hour: 9 }).late, false);
  assert.equal(cancellationFee({ now_hour: 9, appt_day_offset: 1, appt_hour: 9 }).late, false, 'exactly 24 hours is on time');
  assert.equal(cancellationFee({ now_hour: 'four', appt_day_offset: 1, appt_hour: 9 }).ok, false);
});

test('a handoff without a 10-digit callback number is refused', async () => {
  const ctx = { state: seed() };
  const r = await tools.handoff_to_staff({ language: 'en', reason: 'other', summary: 's', callback_phone: '555-01', conversation_id: 'z', questions: ['test question'] }, ctx);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'callback_phone_required');
  assert.equal(ctx.state.handoffs.length, 0);
});

test('a handoff must list every question, and the list comes back for the agent to read to the caller', async () => {
  const state = await seed();
  const none = await tools.handoff_to_staff({ language: 'en', reason: 'clinical_question', summary: 'Knee question', callback_phone: '2815550123', conversation_id: 'q1' }, { state });
  assert.equal(none.ok, false);
  assert.equal(none.error, 'questions_required');
  const r = await tools.handoff_to_staff({ language: 'en', reason: 'clinical_question', summary: 'Knee swelling after exercises', questions: ['Should I keep doing my home exercises?', 'Can I take ibuprofen for the swelling?'], callback_phone: '2815550123', conversation_id: 'q1' }, { state });
  assert.equal(r.ok, true);
  assert.deepEqual(r.read_back_these_questions, ['Should I keep doing my home exercises?', 'Can I take ibuprofen for the swelling?']);
  assert.match(state.handoffs[0].summary, /\(1\) Should I keep doing.*\(2\) Can I take ibuprofen/);
});
