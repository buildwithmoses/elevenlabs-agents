// Offline tests: saved transcripts and scripts only. No API keys, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { extractNumbers } from '../src/numbers.js';
import { checkDub, overlap } from '../src/checks.js';
import { alignToSegments, sentences } from '../src/align.js';
import { canApprove, canPublish, decide, packet, APPROVER } from '../src/review.js';

const HERE = new URL('..', import.meta.url).pathname;
const spec = JSON.parse(readFileSync(join(HERE, 'fixtures/videos.json'), 'utf8'));
const video = (id) => spec.videos.find((v) => v.id === id);
const tr = (key) => JSON.parse(readFileSync(join(HERE, 'fixtures/transcripts', `${key}.json`), 'utf8'));
const script = (key) => readFileSync(join(HERE, 'fixtures/scripts', `${key}.txt`), 'utf8');
const timing = (id) => JSON.parse(readFileSync(join(HERE, 'media/source', `${id}.timing.json`), 'utf8'));
const run = (key, heard, extra = {}, opts = {}) => {
  const [id, lang] = key.split('.'); const t = timing(id);
  return checkDub({ video: video(id), lang, heard, script: script(key), timing: t.segments, duration: { source: t.duration, dub: t.duration }, ...extra }, opts);
};
const vals = (text, lang) => extractNumbers([{ text }], lang).map((n) => n.value);

test('Spanish numbers: words, digits and compounds', () => {
  assert.deepEqual(vals('Haz diez repeticiones, tres series, treinta y cinco segundos, 12 veces', 'es'), [10, 3, 35, 12]);
  assert.deepEqual(vals('quince repeticiones, dos veces al día, cien', 'es'), [15, 2, 100]);
});

test('Vietnamese numbers: mười lăm, ba mươi, hai mươi lăm', () => {
  assert.deepEqual(vals('mười lăm lần, ba mươi giây, hai mươi lăm, mười hai', 'vi'), [15, 30, 25, 12]);
  assert.deepEqual(vals('giữ trong năm giây, ba hiệp, 15 lần', 'vi'), [5, 3, 15]);
});

test('every source video has labeled facts including a safety line', () => {
  for (const v of spec.videos) {
    const kinds = v.segments.flatMap((s) => (s.facts ?? []).map((f) => f.kind));
    assert.ok(kinds.includes('safety'), v.id); assert.ok(kinds.some((k) => ['reps', 'sets'].includes(k)), v.id);
  }
});

test('the three real Spanish dubs pass every check', () => {
  for (const id of ['bridges', 'heel-slides', 'wall-pushups']) assert.deepEqual(run(`${id}.es`, tr(`${id}.es`)).issues, [], id);
});

test('every dub TRANSLATION (the dubbing job script) keeps every fact', () => {
  for (const v of spec.videos) for (const l of ['es', 'vi']) assert.deepEqual(checkDub({ video: v, lang: l, heard: { text: script(`${v.id}.${l}`) } }).issues, [], `${v.id}.${l}`);
});

test('the original Vietnamese dub AUDIO fails: facts missing or speech unintelligible', () => {
  for (const id of ['bridges', 'heel-slides', 'wall-pushups']) {
    const r = run(`${id}.vi`, tr(`${id}.vi`));
    assert.ok(r.issues.length > 0, id);
    assert.ok(r.issues.some((i) => ['unintelligible', 'safety_missing', 'number_missing'].includes(i.code)), id);
  }
  assert.ok(run('wall-pushups.vi', tr('wall-pushups.vi')).intelligibility < 0.6);
});

test('the re-voiced Vietnamese dubs pass every check', () => {
  for (const id of ['bridges', 'heel-slides', 'wall-pushups']) {
    const key = `${id}.vi`;
    if (!existsSync(join(HERE, 'fixtures/transcripts', `${key}.revoiced.json`))) continue;
    assert.deepEqual(run(key, tr(`${key}.revoiced`)).issues, [], key);
  }
});

test('every corrupted fixture is caught by code alone (role swap needs a verified claim)', () => {
  const cases = JSON.parse(readFileSync(join(HERE, 'fixtures/corrupted.json'), 'utf8')).cases;
  for (const c of cases) {
    const base = existsSync(join(HERE, 'fixtures/transcripts', `${c.base}.revoiced.json`)) ? tr(`${c.base}.revoiced`) : tr(c.base);
    let text = base.text; for (const [a, b] of c.replace) { assert.ok(text.includes(a), `${c.id}: ${a}`); text = text.replace(a, b); }
    const bt = c.id === 'c5-reps-and-sets-swapped' ? { claims: [{ kind: 'reps', value: 3 }, { kind: 'sets', value: 12 }] } : undefined;
    const r = run(c.base, { text, words: [] }, { backTranslation: bt });
    assert.ok(r.issues.some((i) => c.expect.includes(i.code)), `${c.id}: ${r.issues.map((i) => i.code)}`);
  }
});

test('an LLM claim that code cannot confirm in the transcript is ignored', () => {
  const r = run('bridges.es', tr('bridges.es'), { backTranslation: { claims: [{ kind: 'reps', value: 20 }] } });
  assert.deepEqual(r.issues, []);   // 20 is never spoken, so the model's claim does not count
  const r2 = run('bridges.es', tr('bridges.es'), { backTranslation: { claims: [{ kind: 'reps', value: 3 }] } });
  assert.ok(r2.issues.some((i) => i.code === 'role_mismatch'));  // 3 is spoken (as sets), so a reps=3 claim is real
});

test('timing: a number spoken outside its card window is flagged', () => {
  const h = tr('bridges.es'); const words = h.words.map((w) => (/^diez$/i.test(w.text) ? { ...w, start: 0.2, end: 0.5 } : w));
  assert.ok(run('bridges.es', { ...h, words }).issues.some((i) => i.code === 'timing_drift'));
});

test('the wrong side is flagged even when the right side is also said', () => {
  const h = tr('heel-slides.es');
  const r = run('heel-slides.es', { text: h.text + ' Luego la rodilla derecha.', words: [] });
  assert.ok(r.issues.some((i) => i.code === 'wrong_side'));
});

test('regression variant (no fact check) raises no issues at all', () => {
  const h = tr('bridges.es');
  assert.deepEqual(run('bridges.es', { text: h.text.replace('diez', 'cien'), words: [] }, {}, { factCheck: false }).issues, []);
});

test('alignment splits translations by source segment, or refuses', () => {
  assert.equal(alignToSegments(video('wall-pushups'), script('wall-pushups.vi')).length, 5);
  assert.equal(alignToSegments(video('bridges'), 'Una sola frase.'), null);
  assert.deepEqual(sentences('A. B? C!'), ['A.', 'B?', 'C!']);
});

test('approval rules: only Dr. Ruiz, only clean QA, only the exact file', () => {
  const qa = { key: 'bridges.es', status: 'ready_for_review', candidate_sha256: 'abc' };
  assert.equal(canApprove({ qa, approver: APPROVER, sha: 'abc' }).ok, true);
  assert.equal(canApprove({ qa, approver: 'Marcus Bell', sha: 'abc' }).ok, false);
  assert.equal(canApprove({ qa: { ...qa, status: 'blocked' }, approver: APPROVER, sha: 'abc' }).ok, false);
  assert.equal(canApprove({ qa, approver: APPROVER, sha: 'zzz' }).ok, false);
  assert.equal(canApprove({ qa: null, approver: APPROVER, sha: 'abc' }).ok, false);
});

test('publish rules: approval for this key and file, QA still clean', () => {
  const qa = { key: 'bridges.es', status: 'ready_for_review', candidate_sha256: 'abc' };
  const approval = { key: 'bridges.es', approver: APPROVER, decision: 'approved', sha256: 'abc' };
  assert.equal(canPublish({ qa, approval, sha: 'abc' }).ok, true);
  assert.equal(canPublish({ qa, approval: null, sha: 'abc' }).ok, false);
  assert.equal(canPublish({ qa, approval: { ...approval, decision: 'rejected' }, sha: 'abc' }).ok, false);
  assert.equal(canPublish({ qa, approval: { ...approval, key: 'bridges.vi' }, sha: 'abc' }).ok, false);
  assert.equal(canPublish({ qa, approval, sha: 'changed' }).ok, false);
  assert.equal(canPublish({ qa: { ...qa, status: 'blocked' }, approval, sha: 'abc' }).ok, false);
});

test('decide: any issue blocks; the packet only offers approval when ready', () => {
  assert.equal(decide([]), 'ready_for_review'); assert.equal(decide([{ code: 'x' }]), 'blocked');
  const v = video('bridges');
  const base = { key: 'bridges.es', facts: [], intelligibility: 1, candidate_file: 'x.mp4', candidate_sha256: 'a'.repeat(64), remediated: null };
  const ok = packet({ video: v, lang: 'es', langName: 'Spanish', qa: { ...base, status: 'ready_for_review', issues: [] }, script: script('bridges.es'), heard: { text: '' } });
  const bad = packet({ video: v, lang: 'es', langName: 'Spanish', qa: { ...base, status: 'blocked', issues: [{ code: 'safety_missing', detail: 'gone' }] }, script: script('bridges.es'), heard: { text: '' } });
  assert.match(ok, /approve\.mjs --key bridges\.es/); assert.doesNotMatch(bad, /approve\.mjs/); assert.match(bad, /BLOCKED/);
});

test('publish.mjs only copies after canPublish succeeds', () => {
  const src = readFileSync(join(HERE, 'scripts/publish.mjs'), 'utf8');
  assert.ok(src.indexOf('canPublish(') < src.indexOf('copyFileSync(join(HERE'), 'copy must come after the check');
  assert.match(src, /if \(!c\.ok\) return/);
});

test('word overlap measures how much of the script was actually heard', () => {
  assert.equal(overlap('uno dos tres', 'uno dos tres'), 1);
  assert.ok(overlap('xx yy', 'uno dos tres') === 0);
});
