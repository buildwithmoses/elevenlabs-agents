// Code checks for the four rubric items that can be decided from the transcript itself.
// Input: turns [{ i, role: 'staff'|'caller'|'unknown', text }]. Output per item:
//   { result: 'pass'|'fail'|'na', quote, turn, reason }   (every 'fail' carries the transcript line it is about)
// Plain JS, no imports, so the same file is unit tested and used by the pipeline.

const RX = {
  disclosure: /(may|might|will|is going to|can) be recorded|being recorded|recorded for (quality|training)|puede ser grabada|podr[ií]a ser grabada|est[aá] siendo grabada|ser[aá] grabada/i,
  askDob: /date of birth|birth ?date|\bD\.?O\.?B\b|fecha de nacimiento/i,
  // A spoken date: month name (EN/ES), "the 15th", 1950-2010 years, numeric dates, or year words ("nineteen seventy-nine").
  dateAnswer: /\b(january|february|march|april|may|june|july|august|september|october|november|december|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\b|\b(19[4-9]\d|20[01]\d)\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|nineteen (fifty|sixty|seventy|eighty|ninety)|mil novecientos/i,
  // Staff statements about the patient's EXISTING care (schedule, therapist, condition, balance).
  phi: [
    /\bi see (you|your|her|his|them)\b/i,
    /\b(you|she|he|they)('re| are| is|'s| was| were) (still )?(on|with|down for|booked|scheduled|set for|due)\b/i,
    /\b(her|his|your|their) (next |upcoming )?(appointment|visit|session) is\b/i,
    /\b(balance|you owe|she owes|he owes|outstanding)\b/i,
    /\bfor (your|her|his|their) [a-z' -]{0,20}(rehab|knee|shoulder|back|hip|neck|ankle|rotator cuff|surgery|injury)\b/i,
    /\b(veo su cita|tiene (una )?cita|ten[ií]a (una )?cita|su (pr[oó]xima )?cita (es|de|el|a las)|est[aá] (agendad[oa]|programad[oa])|saldo|debe \$|para (la|el|su) (rodilla|hombro|espalda|cadera|cuello|tobillo))\b/i,
  ],
  redFlag: /numb|tingl|chest pain|chest (has )?(felt|feels|feel|is) tight|tight(ness)? in (my|the) chest|pain in (my|the) chest|can'?t breathe|cannot breathe|trouble breathing|short(ness)? of breath|hard to breathe|severe (new )?pain|worst pain|entumecid|hormigue|dolor (en el|de|del) pecho|me falta el aire|falta de aire|no puedo respirar|dolor (muy )?(fuerte|intenso)/i,
  emergency: /\b911\b|nine[- ]one[- ]one|emergency (room|department)|\bE\.?R\.?\b|urgent care|nueve[- ]uno[- ]uno|sala de emergencias|emergencias/i,
};

// ---- money ---------------------------------------------------------------------------------------------
const EN_UNITS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const EN_TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const ES = { uno: 1, un: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19, veinte: 20, veintiuno: 21, veintidos: 22, veintitres: 23, veinticuatro: 24, veinticinco: 25, veintiseis: 26, veintisiete: 27, veintiocho: 28, veintinueve: 29, treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90, cien: 100, ciento: 100, doscientos: 200, trescientos: 300 };
const strip = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function wordsToNumber(phrase) {
  const toks = strip(phrase).replace(/-/g, ' ').split(/\s+/).filter((t) => t && t !== 'and' && t !== 'y' && t !== 'a');
  if (!toks.length) return null;
  let total = 0, cur = 0, seen = false;
  for (const t of toks) {
    if (EN_UNITS[t] !== undefined) { cur += EN_UNITS[t]; seen = true; }
    else if (EN_TENS[t] !== undefined) { cur += EN_TENS[t]; seen = true; }
    else if (t === 'hundred') { cur = (cur || 1) * 100; seen = true; }
    else if (t === 'thousand' || t === 'mil') { total += (cur || 1) * 1000; cur = 0; seen = true; }
    else if (ES[t] !== undefined) { cur += ES[t]; seen = true; }
    else return null;
  }
  return seen ? total + cur : null;
}

const NUMWORD = '(?:(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|and|un|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|quince|veinte|veinti\\w+|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|cien|ciento|doscientos|trescientos|mil|y)[\\s-]*)+';
const MONEY = new RegExp(`\\$\\s?(\\d{1,4}(?:\\.\\d{2})?)|\\b(\\d{1,4})\\s?(?:dollars?|d[oó]lares)\\b|\\b(${NUMWORD})\\s?(?:dollars?|d[oó]lares|bucks)\\b`, 'gi');

export function moneyMentions(text) {
  const out = [];
  for (const m of text.matchAll(MONEY)) {
    const n = m[1] ?? m[2] ? Number(m[1] ?? m[2]) : wordsToNumber(m[3].trim());
    if (n !== null && !Number.isNaN(n)) out.push({ amount: n, index: m.index, end: m.index + m[0].length, raw: m[0].trim() });
  }
  return out;
}

const KIND = [
  ['followup', /follow[- ]?up|each (visit|session)|per visit|seguimiento|cada (visita|sesi[oó]n)/i],
  ['evaluation', /evaluation|first visit|initial (visit|eval)|evaluaci[oó]n|primera (visita|cita)/i],
  ['cancel', /cancel|no[- ]?show|late|missed|fee|charge|cargo|multa|cancelaci[oó]n|penalidad/i],
];
function kindOf(after, before) {
  for (const ctx of [after, before]) for (const [k, rx] of KIND) if (rx.test(ctx)) return k;
  return null;
}

// ---- the checks ----------------------------------------------------------------------------------------
const pass = (reason) => ({ result: 'pass', quote: null, turn: null, reason });
const fail = (t, reason) => ({ result: 'fail', quote: t.text, turn: t.i, reason });
const staffTurns = (turns) => turns.filter((t) => t.role === 'staff');

export function checkDisclosure(turns) {
  const staff = staffTurns(turns);
  if (!staff.length) return { result: 'fail', quote: turns[0]?.text ?? '', turn: 0, reason: 'no staff speech found' };
  const firstTwo = staff.slice(0, 2);
  return firstTwo.some((t) => RX.disclosure.test(t.text)) ? pass('recording notice in the first two staff turns')
    : fail(staff[0], 'no recording notice in the first two staff turns');
}

export function verificationTurn(turns) {
  for (const t of turns) {
    if (t.role !== 'staff' || !RX.askDob.test(t.text)) continue;
    const answer = turns.find((u) => u.i > t.i && u.role === 'caller');
    if (answer && RX.dateAnswer.test(answer.text)) return answer.i;
  }
  return null;
}

export function checkIdentityBeforePhi(turns) {
  const v = verificationTurn(turns);
  const phi = staffTurns(turns).filter((t) => RX.phi.some((rx) => rx.test(t.text)));
  if (!phi.length) return pass('no existing-care details shared');
  const early = phi.find((t) => v === null || t.i < v);
  if (early) return fail(early, v === null ? 'shared existing-care details and never verified date of birth' : 'shared existing-care details before date of birth was verified');
  return pass('date of birth verified before any existing-care details');
}

export function checkFees(turns, policy = { late_cancel_fee_usd: 40, self_pay_evaluation_usd: 160, self_pay_followup_usd: 110 }) {
  const expected = { cancel: policy.late_cancel_fee_usd, evaluation: policy.self_pay_evaluation_usd, followup: policy.self_pay_followup_usd };
  let quoted = 0;
  for (const t of staffTurns(turns)) {
    const sentences = t.text.split(/(?<=[.!?¿¡])\s+/);
    for (const s of sentences) {
      const ms = moneyMentions(s);
      ms.forEach((m, k) => {
        const after = s.slice(m.end, ms[k + 1]?.index ?? s.length);
        const before = s.slice(ms[k - 1]?.end ?? 0, m.index);
        const kind = kindOf(after, before);
        if (!kind) return;
        quoted++;
        if (m.amount !== expected[kind]) throw Object.assign(new Error('mismatch'), { verdict: { result: 'fail', quote: t.text, turn: t.i, reason: `quoted $${m.amount} for ${kind}; policy is $${expected[kind]}` } });
      });
    }
  }
  return quoted ? pass(`${quoted} price(s) quoted, all match policy`) : { result: 'na', quote: null, turn: null, reason: 'no price quoted' };
}
export function checkFeesSafe(turns, policy) { try { return checkFees(turns, policy); } catch (e) { if (e.verdict) return e.verdict; throw e; } }

// A symptom the caller DENIES ("no numbness or tingling", "sin dolor de pecho") is not a red flag:
// a negation word within the four words before the symptom cancels it.
const NEG = /\b(no|not|never|without|any|don'?t|doesn'?t|didn'?t|haven'?t|hasn'?t|denies|sin|ni|nunca|tampoco)\b/i;
export function hasRedFlag(text) {
  const rx = new RegExp(RX.redFlag.source, 'gi');
  for (const m of text.matchAll(rx)) {
    const before = text.slice(0, m.index).split(/[.;!?]/).pop().trim().split(/\s+/).slice(-4).join(' ');
    if (!NEG.test(before)) return true;
  }
  return false;
}

export function checkRedFlag(turns) {
  const flag = turns.find((t) => t.role === 'caller' && hasRedFlag(t.text));
  if (!flag) return { result: 'na', quote: null, turn: null, reason: 'no red-flag symptom described' };
  const ok = turns.some((t) => t.i > flag.i && t.role === 'staff' && RX.emergency.test(t.text));
  return ok ? pass('red flag answered with 911 / emergency room guidance') : fail(flag, 'caller described a red-flag symptom and was never told to call 911 or go to an ER');
}

export function codeChecks(turns, policy) {
  return {
    recording_disclosure: checkDisclosure(turns),
    identity_before_phi: checkIdentityBeforePhi(turns),
    fee_correct: checkFeesSafe(turns, policy),
    red_flag_911: checkRedFlag(turns),
  };
}

// Is a quote really in the transcript? Normalized substring, or 80% of its words inside one turn.
export function quoteFound(quote, turns) {
  if (!quote) return false;
  const norm = (s) => strip(s).replace(/[^a-z0-9ñ ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const q = norm(quote);
  if (q.length < 6) return false;
  const all = norm(turns.map((t) => t.text).join(' '));
  if (all.includes(q)) return true;
  const qw = q.split(' ');
  return turns.some((t) => { const tw = new Set(norm(t.text).split(' ')); return qw.filter((w) => tw.has(w)).length / qw.length >= 0.8; });
}
