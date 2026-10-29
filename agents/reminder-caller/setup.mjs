#!/usr/bin/env node
// Creates or updates the five webhook tools and the agent on ElevenLabs. Idempotent; ids go to .state.json.
//   node agents/reminder-caller/setup.mjs [--variant naive]
import { el, state, upsertAgent, arg } from '../../lib/el.mjs';
import { buildTools, buildAgent, SLUG } from './build.mjs';

const variant = arg('variant', 'baseline');
const st = state(SLUG);
st.toolIds ??= {};
for (const t of buildTools()) {
  if (st.toolIds[t.name]) await el('PATCH', `/v1/convai/tools/${st.toolIds[t.name]}`, { tool_config: t });
  else { const r = await el('POST', '/v1/convai/tools', { tool_config: t }); st.toolIds[t.name] = r.id; st.save(); }
}
const agentId = await upsertAgent(SLUG, buildAgent(variant, Object.values(st.toolIds)));
const s2 = state(SLUG); s2.variant = variant; s2.toolIds = st.toolIds; s2.save();
console.log(`${variant} deployed: agent ${agentId}, ${Object.keys(st.toolIds).length} tools`);
