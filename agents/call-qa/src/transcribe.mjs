// ElevenLabs Speech to Text (Scribe v2) with speaker diarization and word timestamps.
// Raw responses are cached in fixtures/transcripts/<id>.scribe.json so tests and re-scoring run offline.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
import { el } from '../../../lib/el.mjs';

export async function transcribe(audioPath, { cachePath, force = false, numSpeakers = 2 } = {}) {
  if (cachePath && existsSync(cachePath) && !force) return JSON.parse(readFileSync(cachePath, 'utf8'));
  const fd = new FormData();
  fd.append('model_id', 'scribe_v2');
  fd.append('diarize', 'true');
  fd.append('num_speakers', String(numSpeakers));
  fd.append('timestamps_granularity', 'word');
  fd.append('file', new Blob([readFileSync(audioPath)], { type: 'audio/mpeg' }), basename(audioPath));
  const r = await el('POST', '/v1/speech-to-text', fd);
  if (cachePath) writeFileSync(cachePath, JSON.stringify(r) + '\n');
  return r;
}
