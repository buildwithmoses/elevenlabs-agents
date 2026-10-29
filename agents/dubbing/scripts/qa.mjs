#!/usr/bin/env node
// Step 3: QA every dub, re-voice the ones whose audio fails, write review packets for Dr. Ruiz.
//   node agents/dubbing/scripts/qa.mjs [--variant no-fact-check]
import { qaDub, spec, spend } from './pipeline.mjs';
import { arg } from '../../../lib/el.mjs';
const variant = arg('variant', 'baseline');
for (const v of spec.videos) for (const l of spec.languages) {
  const qa = await qaDub(`${v.id}.${l.code}`, { variant });
  console.log(`${qa.key.padEnd(18)} ${qa.status.padEnd(17)} ${qa.remediated ? 're-voiced ' : ''}${qa.issues.map((i) => i.code).join(', ')}`);
}
console.log('spend', JSON.stringify(spend()));
