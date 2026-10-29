// The fact checks. Code decides whether a dub kept every clinically critical fact; the model's
// back-translation is a second opinion whose claims are themselves verified here before they count.
import { extractNumbers } from './numbers.js';

// Clinical glossary: acceptable renderings per language. A dub passes a side or safety check only if a
// glossary pattern matches what was actually said.
export const GLOSSARY = {
  es: {
    left: /izquierd[oa]s?/i,
    right: /derech[oa]s?/i,
    safety_pain: /dolor\s+(agudo|punzante|fuerte|intenso)/i,
    safety_stop: /\b(para|pare|parar|detente|det[ée]ngase|detenga|deja|deje|suspende|suspenda|interrumpe|interrumpa)\b/i,
  },
  vi: {
    left: /trái/i,
    right: /(bên|chân|gối|tay|vai|hông)\s+phải/i,
    safety_pain: /đau\s+(nhói|buốt|dữ dội|nhức|chói)/i,
    safety_stop: /(dừng|ngừng)/i,
  },
};

export const NUMERIC_KINDS = ['sets', 'reps', 'hold_seconds', 'rest_seconds', 'times_per_day'];

/** All facts for a video, each tagged with its segment index. */
export function factsOf(video) {
  return video.segments.flatMap((s, i) => (s.facts ?? []).map((f) => ({ ...f, segment: i })));
}

/** How far apart two transcripts are, 0..1 overlap of word bags (diacritics kept). */
export function overlap(a, b) {
  const bag = (s) => s.toLowerCase().normalize('NFC').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const A = bag(a); const B = new Map(); for (const w of bag(b)) B.set(w, (B.get(w) ?? 0) + 1);
  let hit = 0; for (const w of A) { const n = B.get(w) ?? 0; if (n > 0) { hit++; B.set(w, n - 1); } }
  return A.length ? hit / Math.max(A.length, bag(b).length) : 0;
}

/**
 * Check one dub.
 *   video      fixture video (segments with facts)
 *   lang       'es' | 'vi'
 *   heard      { text, words:[{text,start,end}] }  speech-to-text of the dub audio
 *   script     the dubbing job's own translated script (optional): what the dub was supposed to say
 *   timing     source segment windows [{i,start,end}] (optional)
 *   duration   { source, dub } seconds (optional)
 *   backTranslation  { claims:[{kind,value?,side?}], safety_present } from the LLM (optional)
 *   opts.factCheck   false = regression variant: skip the fact checks entirely
 * Returns { issues:[{code, detail, fact?}], facts:[{...fact, found, flagged}], numbers, intelligibility }
 */
export function checkDub({ video, lang, heard, script, timing, duration, backTranslation }, opts = {}) {
  const issues = [];
  const add = (code, detail, fact) => issues.push({ code, detail, ...(fact ? { fact } : {}) });
  const g = GLOSSARY[lang];
  const facts = factsOf(video);
  const text = heard.text ?? '';
  const tokens = heard.words?.length ? heard.words : [{ text }];
  const nums = extractNumbers(tokens, lang);
  const intelligibility = script ? overlap(text, script) : null;

  if (opts.factCheck === false) return { issues, facts: facts.map((f) => ({ ...f, found: null, flagged: false })), numbers: nums, intelligibility };

  // 1. The audio has to say what the dub's own script says. Low overlap = unintelligible speech.
  if (script && intelligibility < 0.6) add('unintelligible', `speech-to-text matches only ${(intelligibility * 100).toFixed(0)}% of the dub's own script`);

  // 2. Every critical number must be spoken (as a digit or a word), as many times as the source needs it.
  const need = new Map();
  for (const f of facts) if (NUMERIC_KINDS.includes(f.kind)) need.set(f.value, (need.get(f.value) ?? 0) + 1);
  const have = new Map(); for (const n of nums) have.set(n.value, (have.get(n.value) ?? 0) + 1);
  const missing = new Set();
  for (const [v, n] of need) if ((have.get(v) ?? 0) < n) { missing.add(v); }
  const factOut = facts.map((f) => {
    if (NUMERIC_KINDS.includes(f.kind)) {
      const found = !missing.has(f.value);
      if (!found) add('number_missing', `${f.kind.replace('_', ' ')} ${f.value} is not spoken in the dub`, f);
      return { ...f, found };
    }
    if (f.kind === 'side') {
      const found = g[f.value].test(text);
      if (!found) add('side_missing', `side "${f.value}" is never said`, f);
      return { ...f, found };
    }
    if (f.kind === 'safety') {
      const found = g.safety_pain.test(text) && g.safety_stop.test(text);
      if (!found) add('safety_missing', 'the "stop if you feel sharp pain" line is missing or changed', f);
      return { ...f, found };
    }
    return { ...f, found: null };
  });
  // One issue line per missing value or side (two facts with the same value need only one line).
  for (let i = issues.length - 1; i >= 0; i--) {
    const it = issues[i];
    if (['number_missing', 'side_missing'].includes(it.code) && issues.findIndex((x) => x.code === it.code && x.fact.value === it.fact.value) !== i) issues.splice(i, 1);
  }

  // 3. The wrong side must never be said.
  for (const side of new Set(facts.filter((f) => f.kind === 'side').map((f) => f.value))) {
    const other = side === 'left' ? 'right' : 'left';
    if (g[other].test(text)) add('wrong_side', `the dub says "${other}" but this exercise is for the ${side} side`);
  }

  // 4. No new exercise numbers: a 4+ that the source never uses (e.g. 10 reps became 100).
  const allowed = new Set([...need.keys(), ...(video.allowed_numbers ?? [])]);
  for (const n of nums) if (n.value >= 4 && !allowed.has(n.value)) add('unexpected_number', `the dub says "${n.raw}" (${n.value}), which is not in the source`);

  // 5. Timing: each number should be spoken while its card is on screen (segment window ± 1.5 s),
  //    and speech must not run past the end of the video.
  if (timing && heard.words?.length) {
    for (const f of facts.filter((x) => NUMERIC_KINDS.includes(x.kind) && !missing.has(x.value))) {
      const w = timing.find((s) => s.i === f.segment);
      const hits = nums.filter((n) => n.value === f.value && n.start != null);
      if (w && hits.length && !hits.some((n) => n.start >= w.start - 1.5 && n.start <= w.end + 1.5)) {
        add('timing_drift', `${f.kind.replace('_', ' ')} ${f.value} is spoken at ${hits[0].start.toFixed(1)}s, but its card shows ${w.start.toFixed(1)}–${w.end.toFixed(1)}s`, f);
      }
    }
  }
  if (duration?.dub && heard.words?.length) {
    const lastEnd = Math.max(...heard.words.map((w) => w.end ?? 0));
    if (lastEnd > duration.dub + 0.05) add('speech_cut_off', `speech runs to ${lastEnd.toFixed(1)}s in a ${duration.dub.toFixed(1)}s video`);
  }
  if (duration?.source && duration?.dub && Math.abs(duration.dub - duration.source) / duration.source > 0.15) {
    add('length_drift', `dub is ${duration.dub.toFixed(1)}s vs source ${duration.source.toFixed(1)}s`);
  }

  // 6. The LLM back-translation is a second opinion. Its claims only count if code can confirm them:
  //    a claimed number must actually be in the transcript, and must disagree with the source.
  if (backTranslation?.claims) {
    const spoken = new Set(nums.map((n) => n.value));
    for (const c of backTranslation.claims) {
      if (!NUMERIC_KINDS.includes(c.kind) || typeof c.value !== 'number') continue;
      const expected = facts.filter((f) => f.kind === c.kind).map((f) => f.value);
      if (!expected.length || expected.includes(c.value)) continue;
      if (!spoken.has(c.value)) continue;           // unverifiable claim: the model may be wrong, ignore it
      add('role_mismatch', `the dub appears to give ${c.kind.replace('_', ' ')} ${c.value}, the source says ${expected.join(' or ')}`);
    }
  }

  const garbled = issues.some((i) => i.code === 'unintelligible');
  const flagged = (f) => garbled || issues.some((i) => i.fact && i.fact.kind === f.kind && i.fact.value === f.value);
  return { issues, facts: factOut.map((f) => ({ ...f, flagged: flagged(f) })), numbers: nums, intelligibility };
}
