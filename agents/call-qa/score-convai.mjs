#!/usr/bin/env node
// Score ElevenLabs Agents conversations with the same rubric (read-only: it only GETs conversations).
// The agent's lines are "staff", the user's are "caller". Works on stored conversations or on a saved
// simulate-conversation result, so the sibling voice agents can be audited like the front desk.
//   node agents/call-qa/score-convai.mjs --agent "Riverbend"            recent conversations of matching agents
//   node agents/call-qa/score-convai.mjs --conversation conv_xxx
//   node agents/call-qa/score-convai.mjs --file sim.json                {simulated_conversation:[{role,message}]}
//   add --no-fees for agents whose prices are not Riverbend's (e.g. the dental receptionist)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { el, arg } from '../../lib/el.mjs';
import { codeChecks, quoteFound } from './src/checks.js';
import { judgeSoft } from './src/judge.mjs';
import { RUBRIC, ITEMS, toMarkdown } from './src/pipeline.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'reports', 'convai'); mkdirSync(OUT, { recursive: true });

const toTurns = (transcript) => transcript.filter((m) => m.message && m.message.trim())
  .map((m, i) => ({ i, role: m.role === 'agent' ? 'staff' : 'caller', text: m.message.trim() }));

async function score(id, turns, meta) {
  const code = codeChecks(turns, RUBRIC.policy);
  if (process.argv.includes('--no-fees')) code.fee_correct = { result: 'na', quote: null, turn: null, reason: 'fee policy not applicable to this agent' };
  const j = await judgeSoft(turns, RUBRIC);
  const items = {};
  for (const k of ITEMS) items[k] = code[k] ? { checked_by: 'code', ...code[k] } : { checked_by: 'judge', result: j.items[k]?.result ?? 'pass', quote: j.items[k]?.quote || null, reason: j.items[k]?.reason ?? '' };
  const second = j.items.identity_before_phi;
  if (items.identity_before_phi.result !== 'fail' && second?.result === 'fail' && quoteFound(second.quote, turns)) items.identity_before_phi = { checked_by: 'code+judge', ...second };
  for (const v of Object.values(items)) if (v.result === 'fail' && !quoteFound(v.quote, turns)) Object.assign(v, { result: 'pass', reason: `unsupported fail dropped: ${v.reason}` });
  const flags = Object.entries(items).filter(([k, v]) => v.result === 'fail' && RUBRIC.flag_to_review.includes(k)).map(([k, v]) => ({ call: id, item: k, quote: v.quote, status: 'pending' }));
  const card = { id, source: 'elevenlabs-agents', ...meta, language: meta.language ?? '?', duration_s: meta.duration_s ?? 0, turns, items, flags, judge_cost_usd: j.cost };
  writeFileSync(join(OUT, `${id}.json`), JSON.stringify(card, null, 2) + '\n');
  writeFileSync(join(OUT, `${id}.md`), toMarkdown(card));
  const fails = Object.entries(items).filter(([, v]) => v.result === 'fail').map(([k]) => k);
  console.log(`${id} (${meta.agent ?? 'file'}): ${fails.length ? fails.join(', ') : 'clean'}`);
}

if (arg('file')) {
  const f = JSON.parse(readFileSync(String(arg('file')), 'utf8'));
  await score(String(arg('file')).split('/').pop().replace(/\.json$/, ''), toTurns(f.simulated_conversation ?? f.transcript ?? f), {});
} else {
  let ids = [];
  if (arg('conversation')) ids = [{ id: String(arg('conversation')) }];
  else {
    const needle = String(arg('agent', 'Riverbend')).toLowerCase();
    const agents = (await el('GET', '/v1/convai/agents?page_size=50')).agents.filter((a) => a.name.toLowerCase().includes(needle));
    for (const a of agents) {
      const c = await el('GET', `/v1/convai/conversations?agent_id=${a.agent_id}&page_size=${arg('limit', 5)}`);
      ids.push(...c.conversations.filter((x) => x.status === 'done').map((x) => ({ id: x.conversation_id, agent: a.name })));
    }
  }
  if (!ids.length) console.log('no finished conversations found for those agents');
  for (const { id, agent } of ids) {
    const conv = await el('GET', `/v1/convai/conversations/${id}`);
    await score(id, toTurns(conv.transcript ?? []), { agent: agent ?? conv.agent_id, duration_s: conv.metadata?.call_duration_secs });
  }
}
