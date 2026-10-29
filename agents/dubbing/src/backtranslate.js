// LLM back-translation: a second opinion on what the dub says, as structured claims.
// The claims are NOT trusted on their own; checks.js only counts a claim that code can confirm.
export const BT_KINDS = ['sets', 'reps', 'hold_seconds', 'rest_seconds', 'times_per_day'];

export function backTranslationMessages(langName, text) {
  return [
    { role: 'system', content: 'You back-translate physical therapy exercise narration into English for a clinical reviewer. Be literal: translate exactly what is said, including mistakes. Never fix or improve it. Reply with JSON only.' },
    { role: 'user', content: `Language: ${langName}\nTranscript of the narration (speech-to-text, may contain recognition errors):\n<<<\n${text}\n>>>\n\nReturn JSON:\n{"back_translation": "<literal English>",\n "claims": [{"kind": one of ${JSON.stringify(BT_KINDS)}, "value": <number as said>}],\n "sides": ["left"|"right" ...],\n "safety_present": <true if it tells the patient to stop when they feel sharp pain>}\nOnly include a claim when the narration states that number for that kind. If a number is unclear, leave it out.` },
  ];
}
