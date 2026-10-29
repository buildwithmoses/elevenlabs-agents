// Shared helpers for every agent in this repo. Node 20+, no dependencies.
//   loadEnv()                      repo-root .env (never printed)
//   el(method, path, body, opts)   ElevenLabs REST (https://api.elevenlabs.io), JSON or multipart (FormData)
//   elBinary(path, body)           ElevenLabs endpoint that returns audio bytes (TTS)
//   upsertAgent(slug, config)      create or PATCH the ElevenAgents agent, id kept in agents/<slug>/.state.json
//   simulate(agentId, spec)        POST /v1/convai/agents/:id/simulate-conversation
//   judge(messages, schema)        independent LLM judge on OpenRouter (openai/gpt-6.1-terra), JSON output
//   toolsLog(slug) / toolsReset(slug)   read or clear what the tools gateway recorded for an agent
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const BASE = 'https://api.elevenlabs.io';

export function loadEnv() {
  const p = join(ROOT, '.env');
  if (existsSync(p)) for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*(#.*)?$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  return {
    key: process.env.ELEVENLABS_API_KEY, openrouter: process.env.OPENROUTER_API_KEY,
    toolsSecret: process.env.TOOLS_SECRET, toolsHost: process.env.TOOLS_HOST,
    // Where evals read and reset the gateway: TOOLS_URL if set, else the public host, else a local gateway.
    toolsLocal: process.env.TOOLS_URL ?? (process.env.TOOLS_HOST ? `https://${process.env.TOOLS_HOST}` : `http://localhost:${process.env.TOOLS_PORT ?? 4700}`),
  };
}

export async function el(method, path, body, { raw = false, retries = 3 } = {}) {
  const env = loadEnv();
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${BASE}${path}`, {
      method, headers: { 'xi-api-key': env.key ?? '', ...(isForm || body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    });
    if ((res.status === 429 || res.status >= 500) && attempt < retries && method === 'GET') { await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); continue; }
    if (raw) { if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${(await res.text()).slice(0, 400)}`); return res; }
    const text = await res.text();
    let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 600)}`);
    return json;
  }
}

export async function elBinary(path, body) {
  const res = await el('POST', path, body, { raw: true });
  return Buffer.from(await res.arrayBuffer());
}

// One state object per agent per process, so upsertAgent and a setup script never save stale copies
// over each other (that bug created duplicate agents).
const stateCache = {};
export function state(slug) {
  if (stateCache[slug]) return stateCache[slug];
  const p = join(ROOT, 'agents', slug, '.state.json');
  const s = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
  Object.defineProperty(s, 'save', { enumerable: false, value: () => writeFileSync(p, JSON.stringify(s, null, 2) + '\n') });
  return (stateCache[slug] = s);
}
const sharedPath = join(ROOT, '.state.json');
export const shared = () => (existsSync(sharedPath) ? JSON.parse(readFileSync(sharedPath, 'utf8')) : {});
export const writeShared = (s) => writeFileSync(sharedPath, JSON.stringify(s, null, 2) + '\n');

export async function upsertAgent(slug, config) {
  const st = state(slug);
  if (st.agentId) { await el('PATCH', `/v1/convai/agents/${st.agentId}`, config); return st.agentId; }
  const r = await el('POST', '/v1/convai/agents/create', config);
  st.agentId = r.agent_id; st.save(); return r.agent_id;
}

export const simulate = (agentId, spec) => el('POST', `/v1/convai/agents/${agentId}/simulate-conversation`, spec);

// Webhook tool config pointing at the shared gateway: https://{{system__env_elagents_tools_host}}/<slug>/<tool>
export function webhookTool(slug, name, description, properties, required = [], extra = {}) {
  return {
    type: 'webhook', name, description, response_timeout_secs: 20,
    api_schema: {
      url: `https://{{system__env_elagents_tools_host}}/${slug}/${name}`, method: 'POST',
      request_headers: { 'X-Tools-Secret': { env_var_label: 'elagents_tools_secret' } },
      request_body_schema: { type: 'object', properties, required, description: `${name} input` },
    },
    ...extra,
  };
}

export async function judge(messages, { model = 'openai/gpt-6.1-terra', maxTokens = 1500 } = {}) {
  const env = loadEnv();
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST', headers: { authorization: `Bearer ${env.openrouter}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages, max_tokens: maxTokens, response_format: { type: 'json_object' }, reasoning: { effort: 'low' } }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(JSON.stringify(j).slice(0, 300));
      const text = j.choices[0].message.content;
      return { ...JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)), _cost: j.usage?.cost ?? null };
    } catch (e) { if (attempt === 3) throw e; await new Promise((r) => setTimeout(r, 2000 * (attempt + 1))); }
  }
}

export async function toolsLog(slug) { const e = loadEnv(); return (await fetch(`${e.toolsLocal}/_log?agent=${slug}`, { headers: { 'x-tools-secret': e.toolsSecret } })).json(); }
export async function toolsReset(slug) { const e = loadEnv(); await fetch(`${e.toolsLocal}/_reset?agent=${slug}`, { method: 'POST', headers: { 'x-tools-secret': e.toolsSecret } }); }

export const arg = (name, dflt) => { const a = process.argv; const i = a.indexOf(`--${name}`); return i === -1 ? dflt : (a[i + 1] && !a[i + 1].startsWith('--') ? a[i + 1] : true); };
