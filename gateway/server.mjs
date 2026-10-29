#!/usr/bin/env node
// Tools gateway: the one HTTPS backend every agent's webhook tools call.
//   POST /<slug>/<tool>      -> agents/<slug>/tools.mjs export `tools[<tool>](body, ctx)`
// Auth: X-Tools-Secret must equal TOOLS_SECRET. Each agent gets its own in-memory state (ctx.state),
// seeded by an optional export `seed()` and reset with POST /_reset?agent=<slug>. Every call is recorded.
// Tool modules are re-imported when their file changes, so agents can be edited without a restart.
//   GET /_log?agent=<slug>   recorded calls     GET /_health
import { createServer } from 'node:http';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = join(ROOT, '.env');
if (existsSync(envFile)) for (const l of readFileSync(envFile, 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*(#.*)?$/); if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}
const SECRET = process.env.TOOLS_SECRET;
const PORT = Number(process.env.PORT ?? process.env.TOOLS_PORT ?? 4700);
if (!SECRET) throw new Error('TOOLS_SECRET is required');

const mods = {}; const states = {}; const log = [];
async function load(slug) {
  const f = join(ROOT, 'agents', slug, 'tools.mjs');
  if (!existsSync(f)) return null;
  const mtime = statSync(f).mtimeMs;
  if (!mods[slug] || mods[slug].mtime !== mtime) mods[slug] = { mtime, mod: await import(`${pathToFileURL(f).href}?v=${mtime}`) };
  return mods[slug].mod;
}
async function stateFor(slug, mod) {
  if (!states[slug]) states[slug] = mod.seed ? await mod.seed() : {};
  return states[slug];
}
const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/_health') return send(res, 200, { ok: true });
  if (req.headers['x-tools-secret'] !== SECRET) return send(res, 401, { error: 'unauthorized' });
  let raw = ''; for await (const c of req) raw += c;
  let body = {}; try { body = raw ? JSON.parse(raw) : {}; } catch { return send(res, 400, { error: 'invalid JSON' }); }
  const agent = url.searchParams.get('agent');
  if (url.pathname === '/_log') return send(res, 200, log.filter((l) => !agent || l.agent === agent));
  if (url.pathname === '/_reset') {
    for (let i = log.length - 1; i >= 0; i--) if (!agent || log[i].agent === agent) log.splice(i, 1);
    if (agent) delete states[agent]; else for (const k of Object.keys(states)) delete states[k];
    return send(res, 200, { ok: true });
  }
  const [, slug, tool] = url.pathname.split('/');
  try {
    const mod = slug && (await load(slug));
    const fn = mod?.tools?.[tool];
    if (!fn) return send(res, 404, { error: `no tool ${slug}/${tool}` });
    const out = await fn(body, { state: await stateFor(slug, mod), log });
    log.push({ agent: slug, tool, body, out, at: new Date().toISOString() });
    send(res, 200, out ?? { ok: true });
  } catch (e) {
    log.push({ agent: slug, tool, body, error: String(e.message ?? e), at: new Date().toISOString() });
    send(res, 200, { ok: false, error: String(e.message ?? e) });   // tools report errors to the agent, never crash the call
  }
}).listen(PORT, () => console.log(`tools gateway on :${PORT}`));
