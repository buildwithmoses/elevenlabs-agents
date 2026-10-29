// Gateway adapter: POST https://<tools host>/lead-qualifier/<tool>. State lives in the gateway (per agent).
// The gateway re-imports this file when it changes, but caches what it imports, so this adapter loads
// src/ and policy.json with a version stamp: editing the rules takes effect without a gateway restart.
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const files = [join(HERE, 'policy.json'), ...readdirSync(join(HERE, 'src')).map((f) => join(HERE, 'src', f))];
let loaded = { v: -1 };
async function mods() {
  const v = Math.max(...files.map((f) => statSync(f).mtimeMs));
  if (loaded.v !== v) {
    // policy.js reads policy.json at import time, so a new ?v= re-reads it too.
    const policy = await import(`${pathToFileURL(join(HERE, 'src', 'policy.js')).href}?v=${v}`);
    const tc = await import(`${pathToFileURL(join(HERE, 'src', 'tools-core.js')).href}?v=${v}`);
    tc.usePolicy(policy);
    loaded = { v, core: tc.core, initState: tc.initState };
  }
  return loaded;
}
export const seed = async () => (await mods()).initState(JSON.parse(readFileSync(join(HERE, 'seed.json'), 'utf8')));
const wrap = (name, opts) => async (b, { state }) => (await mods()).core[name](b, state, opts);
export const tools = {
  check_coverage: wrap('check_coverage'),
  check_coverage_noref: wrap('check_coverage_noref'),
  find_evaluation_slots: wrap('find_evaluation_slots'),
  book_evaluation: wrap('book_evaluation'),
  book_evaluation_trusting: wrap('book_evaluation', { trust: true }),
  create_crm_lead: wrap('create_crm_lead'),
  request_callback: wrap('request_callback'),
  // eval-only read of state (behind the same secret)
  _state: (_b, { state }) => ({ leads: state.leads, bookings: state.bookings, callbacks: state.callbacks, qualifications: state.qualifications }),
};
