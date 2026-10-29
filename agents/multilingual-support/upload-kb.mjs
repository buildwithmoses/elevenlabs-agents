#!/usr/bin/env node
// Upload knowledge_base/riverbend-patient-guide.md as a new ElevenLabs KB text document and record its id
// in .state.json. setup.mjs calls the same logic automatically when the file's hash changes;
// run this to force a fresh upload.   node agents/multilingual-support/upload-kb.mjs
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { el, state } from '../../lib/el.mjs';
const HERE = dirname(fileURLToPath(import.meta.url));
const st = state('multilingual-support');
const text = readFileSync(join(HERE, 'knowledge_base', 'riverbend-patient-guide.md'), 'utf8');
const r = await el('POST', '/v1/convai/knowledge-base/text', { text, name: 'Riverbend - patient guide' });
st.kb = { id: r.id, name: r.name ?? 'Riverbend - patient guide', hash: createHash('sha256').update(text).digest('hex').slice(0, 16) };
st.save();
console.log(`uploaded ${r.id}; run setup.mjs to attach it to the agent`);
