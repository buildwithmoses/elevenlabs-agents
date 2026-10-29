#!/usr/bin/env node
// Upload the KB (if changed), create or update the three webhook tools, then create or PATCH the agent.
//   node agents/multilingual-support/setup.mjs [--variant english-only]
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { el, state, upsertAgent, arg } from '../../lib/el.mjs';
import { buildAgent, TOOL_DEFS, SLUG } from './build.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const variant = arg('variant', 'baseline');
const st = state(SLUG);

// Knowledge base: re-upload only when the file changes.
const kbFile = join(HERE, 'knowledge_base', 'riverbend-patient-guide.md');
const kbText = readFileSync(kbFile, 'utf8');
const hash = createHash('sha256').update(kbText).digest('hex').slice(0, 16);
if (st.kb?.hash !== hash) {
  const r = await el('POST', '/v1/convai/knowledge-base/text', { text: kbText, name: 'Riverbend - patient guide' });
  st.kb = { id: r.id, name: r.name ?? 'Riverbend - patient guide', hash }; st.save();
  console.log(`uploaded KB ${r.id}`);
}

// Tools: create once, PATCH after.
st.tools ??= {};
for (const t of TOOL_DEFS) {
  if (st.tools[t.name]) await el('PATCH', `/v1/convai/tools/${st.tools[t.name]}`, { tool_config: t });
  else { const r = await el('POST', '/v1/convai/tools', { tool_config: t }); st.tools[t.name] = r.id; st.save(); console.log(`created tool ${t.name} ${r.id}`); }
}

const toolIds = variant === 'english-only' ? [st.tools.verify_identity, st.tools.get_account_summary] : TOOL_DEFS.map((t) => st.tools[t.name]);
const agentId = await upsertAgent(SLUG, buildAgent({ variant, kbDocs: [st.kb], toolIds }));
st.agentId = agentId; st.variant = variant; st.save();
console.log(`${variant} deployed: agent ${agentId}  https://elevenlabs.io/app/agents/agents/${agentId}`);
