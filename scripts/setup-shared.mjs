#!/usr/bin/env node
// Registers the tools gateway with ElevenLabs as workspace environment variables (idempotent):
//   elagents_tools_host   (string)  host only, e.g. abc.ngrok-free.app or tools.up.railway.app
//   elagents_tools_secret (secret)  sent as X-Tools-Secret by every webhook tool
// Re-run after TOOLS_HOST changes (ngrok restart, Railway deploy). Agents need no edits.
import { loadEnv, el, shared, writeShared } from '../lib/el.mjs';
const env = loadEnv();
if (!env.toolsHost || !env.toolsSecret) throw new Error('TOOLS_HOST and TOOLS_SECRET must be set in .env');
const s = shared();
const list = (await el('GET', '/v1/convai/environment-variables')).environment_variables ?? [];
const find = (label) => list.find((v) => v.label === label);

let sec = find('elagents_tools_secret');
if (!sec) {
  const secret = await el('POST', '/v1/convai/secrets', { type: 'new', name: 'elagents_tools_secret', value: env.toolsSecret });
  sec = await el('POST', '/v1/convai/environment-variables', { label: 'elagents_tools_secret', type: 'secret', values: { production: { secret_id: secret.secret_id } } });
  console.log('created secret env var elagents_tools_secret');
} else console.log('secret env var elagents_tools_secret exists');

const host = find('elagents_tools_host');
if (!host) {
  await el('POST', '/v1/convai/environment-variables', { label: 'elagents_tools_host', type: 'string', values: { production: env.toolsHost } });
  console.log(`created elagents_tools_host = ${env.toolsHost}`);
} else {
  await el('PATCH', `/v1/convai/environment-variables/${host.id}`, { values: { production: env.toolsHost } });
  console.log(`updated elagents_tools_host = ${env.toolsHost}`);
}
s.toolsHost = env.toolsHost; writeShared(s);
