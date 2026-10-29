// Split a translated script back into the source video's segments so each line can be re-voiced
// inside its own title-card window. Sentence counts must match exactly; otherwise return null and a
// person handles it (never guess which sentence goes on which card).
export const sentences = (s) => s.replace(/\s+/g, ' ').trim().split(/(?<=[.!?。])\s+/).filter(Boolean);

export function alignToSegments(video, script) {
  const perSeg = video.segments.map((s) => sentences(s.say).length);
  const tr = sentences(script);
  if (tr.length !== perSeg.reduce((a, b) => a + b, 0)) return null;
  const out = []; let k = 0;
  for (const n of perSeg) { out.push(tr.slice(k, k + n).join(' ')); k += n; }
  return out;
}
