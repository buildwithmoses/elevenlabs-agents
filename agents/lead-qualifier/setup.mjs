#!/usr/bin/env node
// Push the lead qualifier to ElevenLabs: create/update its webhook tools, then the agent.
//   node agents/lead-qualifier/setup.mjs [--variant baseline|model-decides|no-referral]
// Each variant is its own agent (ids in .state.json), so the shipped baseline is never overwritten by a regression.
import { el, state, arg } from '../../lib/el.mjs';
import { buildTools, buildAgent, VARIANTS } from './build.mjs';

const variant = arg('variant', 'baseline');
if (!VARIANTS.includes(variant)) throw new Error(`--variant must be one of ${VARIANTS.join(', ')}`);
const st = state('lead-qualifier');
st.tools ??= {}; st.agents ??= {};
const ids = [];
for (const t of buildTools(variant)) {
  const key = t.api_schema.url.split('/').pop();
  if (st.tools[key]) await el('PATCH', `/v1/convai/tools/${st.tools[key]}`, { tool_config: t });
  else { const r = await el('POST', '/v1/convai/tools', { tool_config: t }); st.tools[key] = r.id; st.save(); }
  ids.push(st.tools[key]);
}
const cfg = buildAgent(variant, ids);
if (st.agents[variant]) await el('PATCH', `/v1/convai/agents/${st.agents[variant]}`, cfg);
else { const r = await el('POST', '/v1/convai/agents/create', cfg); st.agents[variant] = r.agent_id; }
st.save();
console.log(`${variant}: agent ${st.agents[variant]} with ${ids.length} tools`);
