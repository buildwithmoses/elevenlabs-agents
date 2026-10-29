// Pull the numbers out of a Spanish, Vietnamese or English transcript, as digits or spelled-out words,
// with the time each one was spoken when word timestamps are available.
// Plain JS, no dependencies. Used by checks.js and the tests.

const ES = {
  cero: 0, un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
  once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciséis: 16, dieciseis: 16, diecisiete: 17, dieciocho: 18,
  diecinueve: 19, veinte: 20, veintiuno: 21, veintidós: 22, veintidos: 22, veinticinco: 25, treinta: 30, cuarenta: 40,
  cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90, cien: 100, ciento: 100,
};
const EN = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, hundred: 100, twice: 2, once: 1 };
// Vietnamese: units, plus the special forms after "mười"/"mươi" (lăm = 5, mốt = 1, tư = 4).
const VI_UNIT = { không: 0, một: 1, mốt: 1, hai: 2, ba: 3, bốn: 4, tư: 4, năm: 5, lăm: 5, sáu: 6, bảy: 7, tám: 8, chín: 9 };

const clean = (w) => w.toLowerCase().normalize('NFC').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

/** tokens: [{text, start?, end?}] -> [{value, start, end, raw}] */
export function extractNumbers(tokens, lang) {
  const toks = tokens.flatMap((t) => String(t.text).split(/\s+/).filter(Boolean).map((w) => ({ w: clean(w), raw: w, start: t.start ?? null, end: t.end ?? null })))
    .filter((t) => t.w);
  const out = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (/^\d+$/.test(t.w)) { out.push({ value: Number(t.w), start: t.start, end: t.end, raw: t.raw }); continue; }
    if (lang === 'es') {
      if (ES[t.w] === undefined) continue;
      let v = ES[t.w]; let end = t.end; let raw = t.raw;
      // "treinta y cinco", "ciento veinte"
      if (v >= 30 && v < 100 && toks[i + 1]?.w === 'y' && ES[toks[i + 2]?.w] !== undefined && ES[toks[i + 2].w] < 10) { v += ES[toks[i + 2].w]; end = toks[i + 2].end; raw += ` y ${toks[i + 2].raw}`; i += 2; }
      out.push({ value: v, start: t.start, end, raw });
    } else if (lang === 'vi') {
      if (t.w === 'mười') {                       // 10..19
        let v = 10; let end = t.end; let raw = t.raw;
        const n = toks[i + 1]; if (n && VI_UNIT[n.w] !== undefined && VI_UNIT[n.w] > 0) { v += VI_UNIT[n.w]; end = n.end; raw += ` ${n.raw}`; i++; }
        out.push({ value: v, start: t.start, end, raw });
      } else if (VI_UNIT[t.w] !== undefined && t.w !== 'lăm' && t.w !== 'mốt' && t.w !== 'tư') {
        let v = VI_UNIT[t.w]; let end = t.end; let raw = t.raw;
        if (toks[i + 1]?.w === 'mươi') {            // 20..99
          v *= 10; end = toks[i + 1].end; raw += ` ${toks[i + 1].raw}`; i++;
          const n = toks[i + 1]; if (n && VI_UNIT[n.w] !== undefined && VI_UNIT[n.w] > 0) { v += VI_UNIT[n.w]; end = n.end; raw += ` ${n.raw}`; i++; }
        } else if (toks[i + 1]?.w === 'trăm') { v *= 100; end = toks[i + 1].end; raw += ` ${toks[i + 1].raw}`; i++; }
        // "năm" is also "year"; "năm giây" (5 seconds) still counts. A stray "năm" only matters if 5 is a fact.
        out.push({ value: v, start: t.start, end, raw });
      }
    } else if (EN[t.w] !== undefined) out.push({ value: EN[t.w], start: t.start, end: t.end, raw: t.raw });
  }
  return out;
}
