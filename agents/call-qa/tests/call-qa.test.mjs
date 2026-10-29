// Offline tests: no API keys. Use the cached Scribe transcripts in fixtures/transcripts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toTurns, toFlatTurns } from '../src/turns.js';
import { codeChecks, checkDisclosure, checkIdentityBeforePhi, checkFeesSafe, checkRedFlag, hasRedFlag, moneyMentions, wordsToNumber, quoteFound, verificationTurn } from '../src/checks.js';

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..');
const calls = JSON.parse(readFileSync(join(HERE, 'fixtures/calls.json'), 'utf8')).calls;
const scribe = (id) => JSON.parse(readFileSync(join(HERE, 'fixtures/transcripts', `${id}.scribe.json`), 'utf8'));
const T = (...lines) => lines.map(([role, text], i) => ({ i, role, text }));
const CODE_ITEMS = ['recording_disclosure', 'identity_before_phi', 'fee_correct', 'red_flag_911'];

test('every fixture call has audio, a cached transcript and all seven labels', () => {
  const audio = readdirSync(join(HERE, 'fixtures/audio'));
  const rubric = JSON.parse(readFileSync(join(HERE, 'rubric.json'), 'utf8'));
  for (const c of calls) {
    assert.ok(audio.includes(`${c.id}.mp3`), c.id);
    assert.ok(scribe(c.id).words.length > 20, c.id);
    assert.deepEqual(Object.keys(c.labels).sort(), rubric.items.map((i) => i.id).sort(), c.id);
  }
});

test('diarized turns: staff is identified and both speakers appear in every call', () => {
  for (const c of calls) {
    const t = toTurns(scribe(c.id));
    assert.equal(t[0].role, 'staff', `${c.id} opens with staff`);
    assert.ok(t.some((x) => x.role === 'caller'), `${c.id} has a caller`);
  }
});

// The code checks agree with the labels on every real transcript, except the one case code alone cannot see
// (c17: a verified caller asks about her husband). That one needs the judge's second opinion.
for (const c of calls) {
  test(`code checks match labels on real Scribe transcript ${c.id} (${c.title})`, () => {
    const r = codeChecks(toTurns(scribe(c.id)));
    for (const k of CODE_ITEMS) {
      if (c.id === 'c17' && k === 'identity_before_phi') { assert.equal(r[k].result, 'pass', 'documented code blind spot'); continue; }
      assert.equal(r[k].result === 'fail', c.labels[k] === 'fail', `${c.id} ${k}: ${r[k].reason}`);
      if (r[k].result === 'fail') assert.ok(r[k].quote && quoteFound(r[k].quote, toTurns(scribe(c.id))), `${c.id} ${k} quote is real`);
    }
  });
}

test('number words: English and Spanish dollar amounts', () => {
  assert.equal(wordsToNumber('forty'), 40);
  assert.equal(wordsToNumber('seventy-five'), 75);
  assert.equal(wordsToNumber('one hundred sixty'), 160);
  assert.equal(wordsToNumber('one hundred and ten'), 110);
  assert.equal(wordsToNumber('cuarenta'), 40);
  assert.equal(wordsToNumber('ciento sesenta'), 160);
  assert.deepEqual(moneyMentions('a $25 fee and 40 dollars and forty-five dollars').map((m) => m.amount), [25, 40, 45]);
  assert.deepEqual(moneyMentions('hay un cargo de cuarenta dólares').map((m) => m.amount), [40]);
  assert.deepEqual(moneyMentions('menos de veinticuatro horas').map((m) => m.amount), []);
});

test('fees: each amount is matched to its own kind in a mixed sentence', () => {
  const ok = T(['staff', 'Self-pay is one hundred sixty dollars for the evaluation and one hundred ten dollars for each follow-up.']);
  assert.equal(checkFeesSafe(ok).result, 'pass');
  const bad = T(['staff', 'Self-pay is one hundred sixty dollars for the evaluation and one hundred twenty dollars for each follow-up.']);
  assert.equal(checkFeesSafe(bad).result, 'fail');
  assert.match(checkFeesSafe(bad).reason, /\$120 for followup/);
  assert.equal(checkFeesSafe(T(['caller', 'Is the late fee seventy-five dollars?'], ['staff', 'It is forty dollars.'])).result, 'na', 'no fee keyword near the staff amount -> not judged');
  assert.equal(checkFeesSafe(T(['caller', 'Is the late fee seventy-five dollars?'], ['staff', 'The late fee is forty dollars.'])).result, 'pass', 'caller amounts are ignored');
});

test('identity: details before date of birth fail; after it pass; no details is a pass', () => {
  const before = T(['staff', 'Riverbend, this call may be recorded.'], ['caller', 'When is my next visit?'], ['staff', "You're on Tuesday at three with Priya."], ['staff', 'Can I get your date of birth?'], ['caller', 'May 2, 1990.']);
  assert.equal(checkIdentityBeforePhi(before).result, 'fail');
  const after = T(['staff', 'Can I get your date of birth?'], ['caller', 'May 2, 1990.'], ['staff', "You're on Tuesday at three with Priya."]);
  assert.equal(checkIdentityBeforePhi(after).result, 'pass');
  assert.equal(verificationTurn(after), 1);
  const asked = T(['staff', 'Can I get your date of birth?'], ['caller', "I'd rather not say."], ['staff', 'I see your appointment Tuesday.']);
  assert.equal(checkIdentityBeforePhi(asked).result, 'fail', 'asking is not verifying: the caller has to give a date');
  assert.equal(checkIdentityBeforePhi(T(['staff', 'We open at seven.'])).result, 'pass');
});

test('red flags: negated symptoms are not flags; real ones need 911 guidance from STAFF', () => {
  assert.equal(hasRedFlag('No numbness or tingling, no chest pain, just stiff.'), false);
  assert.equal(hasRedFlag("I don't have any numbness."), false);
  assert.equal(hasRedFlag('Not sure why, but my arm is numb.'), true);
  assert.equal(hasRedFlag('sin dolor de pecho'), false);
  assert.equal(hasRedFlag('tengo dolor en el pecho'), true);
  const callerSays911 = T(['caller', 'My chest feels tight. Should I call 911?'], ['staff', "Let's get you in tomorrow."]);
  assert.equal(checkRedFlag(callerSays911).result, 'fail', 'the caller saying 911 is not staff guidance');
  const handled = T(['caller', 'My leg went numb this morning.'], ['staff', 'Please hang up and call 911 now.']);
  assert.equal(checkRedFlag(handled).result, 'pass');
});

test('recording notice must be in the first two staff turns', () => {
  assert.equal(checkDisclosure(T(['staff', 'Riverbend, this call may be recorded.'])).result, 'pass');
  assert.equal(checkDisclosure(T(['staff', 'Hi.'], ['caller', 'Hi'], ['staff', 'How can I help?'], ['staff', 'This call may be recorded.'])).result, 'fail');
  assert.equal(checkDisclosure(T(['staff', 'Esta llamada puede ser grabada.'])).result, 'pass');
});

test('evidence: quotes must really be in the transcript', () => {
  const t = toTurns(scribe('c02'));
  assert.ok(quoteFound("She's with Priya on Tuesday at three fifteen", t));
  assert.ok(!quoteFound('She owes two hundred dollars for her knee surgery', t));
  assert.ok(!quoteFound('ok', t), 'too short to count');
});

test('without diarization the code checks lose the 911 failure (why no-diarization is blocked)', () => {
  const flat = toFlatTurns(scribe('c07'));
  assert.equal(codeChecks(flat).red_flag_911.result, 'na');
  assert.equal(codeChecks(toTurns(scribe('c07'))).red_flag_911.result, 'fail');
});

test('review queue needs a named reviewer', async () => {
  const { decide } = await import('../src/review-queue.mjs');
  assert.throws(() => decide('c02', 'identity_before_phi', 'confirmed', ''), /named reviewer/);
});
