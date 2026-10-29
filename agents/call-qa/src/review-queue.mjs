// Hannah's review queue: HIPAA and safety failures wait here as "pending" until a person confirms or dismisses
// them. Only confirmed flags count against staff. Stored in reports/review-queue.json.
//   node agents/call-qa/src/review-queue.mjs list
//   node agents/call-qa/src/review-queue.mjs confirm c02 identity_before_phi --by hannah
//   node agents/call-qa/src/review-queue.mjs dismiss c07 red_flag_911 --by hannah --note "caller was a test"
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'reports', 'review-queue.json');
export const load = () => (existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : []);
const save = (q) => writeFileSync(FILE, JSON.stringify(q, null, 2) + '\n');

export function addFlags(flags) {
  const q = load();
  for (const f of flags) if (!q.find((x) => x.call === f.call && x.item === f.item)) q.push({ ...f, added_at: new Date().toISOString() });
  save(q);
}
export function decide(call, item, decision, by, note = '') {
  if (!by) throw new Error('a named reviewer is required (--by)');
  const q = load(); const f = q.find((x) => x.call === call && x.item === item);
  if (!f) throw new Error(`no flag ${call}/${item}`);
  Object.assign(f, { status: decision, decided_by: by, note, decided_at: new Date().toISOString() }); save(q); return f;
}
export const countsAgainstStaff = () => load().filter((f) => f.status === 'confirmed');

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, call, item] = process.argv.slice(2);
  const by = process.argv.includes('--by') ? process.argv[process.argv.indexOf('--by') + 1] : null;
  const note = process.argv.includes('--note') ? process.argv[process.argv.indexOf('--note') + 1] : '';
  if (cmd === 'list') for (const f of load()) console.log(`${f.status.padEnd(9)} ${f.call} ${f.item}: "${(f.quote ?? '').slice(0, 90)}"`);
  else if (cmd === 'confirm' || cmd === 'dismiss') console.log(decide(call, item, cmd === 'confirm' ? 'confirmed' : 'dismissed', by, note));
  else console.log('usage: list | confirm <call> <item> --by <name> | dismiss <call> <item> --by <name> [--note ...]');
}
