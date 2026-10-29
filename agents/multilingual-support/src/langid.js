// Tiny language ID for en / es / vi, good enough to check every agent turn without a model.
// Vietnamese is identified by its distinctive letters (ơ ư ă đ and stacked tone marks) and function words;
// Spanish vs English by function-word counts plus Spanish-only characters (ñ ¿ ¡ and accented vowels).
const VI_CHARS = /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/gi;
const ES_CHARS = /[ñ¿¡áéíóú]/gi;
const WORDS = {
  en: ['the', 'and', 'you', 'your', 'is', 'are', 'to', 'of', 'for', 'with', 'we', 'can', 'i', 'it', 'that', 'this', 'please', 'have', 'will', 'on', 'our', 'be', 'what', 'at', 'clinic', 'thank', 'help'],
  es: ['el', 'la', 'los', 'las', 'de', 'que', 'y', 'en', 'por', 'para', 'con', 'su', 'usted', 'es', 'un', 'una', 'del', 'puedo', 'le', 'lo', 'gracias', 'clínica', 'clinica', 'cita', 'ayudar', 'está', 'esta', 'como', 'pero', 'sí'],
  vi: ['và', 'của', 'là', 'có', 'không', 'được', 'cho', 'tôi', 'bạn', 'anh', 'chị', 'cô', 'chú', 'bác', 'em', 'với', 'này', 'các', 'những', 'phòng', 'khám', 'xin', 'cảm', 'ơn', 'vui', 'lòng', 'giờ', 'hẹn', 'thì', 'ạ'],
};

export function detectLanguage(text) {
  const t = String(text ?? '').toLowerCase();
  const tokens = t.normalize('NFC').split(/[^\p{L}]+/u).filter(Boolean);
  if (tokens.length < 3) return { lang: null, confidence: 0 };          // "OK", "Sí", names: undetermined
  const vi = (t.match(VI_CHARS) ?? []).length;
  const score = { en: 0, es: 0, vi: 0 };
  for (const w of tokens) for (const l of ['en', 'es', 'vi']) if (WORDS[l].includes(w)) score[l]++;
  score.vi += vi * 0.6;
  score.es += (t.match(ES_CHARS) ?? []).length * 0.5;
  const ranked = Object.entries(score).sort((a, b) => b[1] - a[1]);
  const [best, second] = ranked;
  if (best[1] < 1.5) return { lang: null, confidence: 0 };
  return { lang: best[0], confidence: +(best[1] / (best[1] + second[1] + 0.001)).toFixed(2) };
}
