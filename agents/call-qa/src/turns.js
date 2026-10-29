// Scribe words -> speaker turns, and which speaker is staff.
// Staff is the speaker who greets with the clinic name or the recording notice; otherwise whoever spoke first
// (inbound calls are answered by staff). Plain JS, no imports: shared by the pipeline and the tests.

export function toTurns(scribe) {
  const turns = [];
  for (const w of scribe.words ?? []) {
    if (w.type === 'audio_event') continue;
    const sp = w.speaker_id ?? 'speaker_0';
    let last = turns[turns.length - 1];
    if (!last || last.speaker !== sp) {
      if (w.type === 'spacing' && last) { last.text += w.text; continue; }
      last = { speaker: sp, text: '', start: w.start, end: w.end };
      turns.push(last);
    }
    last.text += w.text;
    last.end = w.end ?? last.end;
  }
  for (const t of turns) t.text = t.text.replace(/\s+/g, ' ').trim();
  const out = turns.filter((t) => t.text);
  const greet = /river\s?bend|may be recorded|being recorded|puede ser grabada|ser grabada/i;
  const staffSpeaker = (out.find((t) => greet.test(t.text)) ?? out[0])?.speaker;
  return out.map((t, i) => ({ i, role: t.speaker === staffSpeaker ? 'staff' : 'caller', ...t }));
}

// Regression helper: what you get without diarization. One undivided stream, every line "unknown".
export function toFlatTurns(scribe) {
  const text = (scribe.text ?? '').replace(/\s+/g, ' ').trim();
  return [{ i: 0, role: 'unknown', speaker: 'none', text, start: 0, end: scribe.audio_duration_secs ?? 0 }];
}
