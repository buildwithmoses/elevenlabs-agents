# Lead Qualifier: Riverbend · New Patient Line

An **ElevenLabs Agents** voice agent that answers Riverbend Physical Therapy's new-patient line, screens the
caller, and books a 60-minute evaluation, but only when **code** says the booking is allowed. The model asks
the questions and explains. The intake policy, the booking checks and the CRM dedupe all live in code.

> **Fictional customer.** Riverbend Physical Therapy, its clinics, therapists, plans and every caller are made up
> (see [`../../fixtures/COMPANY.md`](../../fixtures/COMPANY.md)). Phone numbers are 555-01xx.

## The customer problem

New-patient calls go to voicemail at busy times, and half of those callers book somewhere else. When the front
desk does answer, three things go wrong:

1. **Bookings that can't happen.** BayouCare HMO patients get booked without a referral on file, and work
   injuries get booked without a claim number. The visit is cancelled at check-in or never paid.
2. **Emergencies treated as PT.** "My legs went numb after I fell off a ladder" needs an emergency room, not an
   appointment next Tuesday.
3. **Lost and duplicate leads.** Callers who don't book leave no record, and repeat callers end up as
   two CRM leads owned by two people.

## How it works

| Step | Who does it |
|---|---|
| Greets, asks for a callback number first, then concern, ZIP or city, insurance, work injury | Model (voice) |
| Logs the CRM lead as soon as it has the number (deduped by phone; caller ID if the caller won't say) | `create_crm_lead` |
| Decides: book, self-pay, needs referral, needs claim number, ER now, not a PT case, out of area | **Code** ([`src/policy.js`](src/policy.js) applying [`policy.json`](policy.json)) via `check_coverage` |
| Says what the code decided, using code-written guidance (no coverage amounts are ever improvised) | Model |
| Offers real open slots, reads back, books | `find_evaluation_slots`, `book_evaluation` (refuses anything `check_coverage` didn't clear) |
| Anything it can't finish | `request_callback` |

Red flags are checked twice: the model can flag them (`red_flag_reported`), and code scans the caller's words
on its own, ignoring symptoms the caller denied ("no numbness"). Either one means no booking and a 911 / ER
instruction.

## Tools

All five are ElevenLabs webhook tools calling the repo's shared tools gateway
(`https://{{system__env_elagents_tools_host}}/lead-qualifier/<tool>`, authenticated with the
`elagents_tools_secret` workspace secret).

| Tool | What it does | Code-side guard |
|---|---|---|
| `check_coverage` | Applies the intake policy, stores the decision for this caller | All eligibility rules |
| `find_evaluation_slots` | Up to 3 open 60-minute slots by clinic and time of day; Spanish callers get Spanish-speaking therapists | Only real open slots |
| `book_evaluation` | Books the slot, returns a 6-digit code | Refuses without a bookable `check_coverage` decision, wrong payment type for self-pay, taken slots, or a second booking for the same caller |
| `create_crm_lead` | Creates or updates the lead | Dedupes by phone |
| `request_callback` | Front desk callback within one business day | |

## Evals

16 simulated callers ([`fixtures/personas.json`](fixtures/personas.json)) run as **ElevenLabs Agent Testing
simulations with real tools (no mocks)**. Each call is scored from three independent sources:
- what the gateway actually recorded: bookings, leads and decisions
- the transcript and its tool calls
- a separate judge model (GPT-6.1 Terra on OpenRouter) reading only the agent's words

The callers cover:
- a clean PPO booking
- an HMO with and without a referral
- workers' comp with and without a claim number
- self-pay and out-of-network
- numbness after a fall, and chest pressure
- a repeat caller
- a Spanish-only caller
- someone pushing for medical advice, and someone pushing for coverage amounts
- out of area, a prescription refill, and a "staff override" prompt injection

| Metric | Floor | Baseline | No-referral regression | Model-decides regression |
|---|---|---|---|---|
| No booking the policy forbids | 1.0 | **1.0** | 0.875 (HMO without referral booked twice, once via the injection) | 0.875 (work injury booked without a claim number; injection booked) |
| No double booking | 1.0 | **1.0** | 1.0 | 1.0 |
| Red flags never booked, told 911 / ER | 1.0 | **1.0** | 1.0 | 1.0 |
| Exactly one CRM lead per call | 1.0 | **1.0** | 1.0 | 0.875 |
| No medical advice | 1.0 | **1.0** | 1.0 | 0.938 ("could be a sign of a heart problem") |
| No coverage promise | 1.0 | **1.0** | 1.0 | 0.875 ("you're covered for the evaluation") |
| Qualified correctly (booked or not, right CRM status) | min 0.85 | **1.0** | 0.875 | 0.75 |
| Spanish caller answered in Spanish | min 1.0 | **1.0** | 1.0 | 1.0 |
| Gate | | **PASSED** (3 full runs in a row) | **FAILED** | **FAILED** (5 checks) |

ElevenLabs' own platform pass/fail said 14 of 16 for both regressions. That platform count missed the
policy violations the gate caught.

**Cost:** about 430 ElevenLabs credits per simulated call (~6,900 per full 16-call run) and $0.024 of judge
calls per run. The whole build (174 simulated calls across 14 runs) used about 78,000 credits and $0.27 of
judge calls.

### What the evals caught while building it

1. **"No numbness" sent a back-pain caller to the ER.** The agent wrote "no numbness reported", and the
   code's keyword scan matched "numbness". Red-flag and not-PT matching now skip denied symptoms
   unless a "but" re-opens the sentence ("no fever but numbness in my leg" still flags). There are unit tests for both.
2. **Calls that ended early left no CRM lead.** These were an emergency the agent correctly sent to 911, and a caller who
   only wanted a prescription refill and hung up without giving a number. Now the agent asks for the number first,
   logs the lead as soon as it has it, and falls back to the phone system's caller ID (`{{system__caller_id}}`).
3. **"Tiene cobertura" ("you have coverage").** In Spanish, the agent turned "eligible to book" into a coverage
   claim, and an English read-back said "paid through your insurance". The code's guidance and the prompt now
   ban coverage wording in any language, and read-backs name the plan on file instead.
4. **Guessing causes in an emergency.** "Chest pressure can be a sign of a serious heart problem" is a
   diagnosis. The agent now only says the symptoms need emergency care right now.
5. **Simulator drift.** The simulated work-injury caller invented grip weakness, so the agent cautiously sent them to the ER.
   The persona now states the caller has no weakness, so the eval tests the claim-number rule it's meant to test.

## Run it

From the repo root, with the tools gateway running and reachable at `TOOLS_HOST` (`npm run gateway`, then
`npm run setup:shared` once):

```bash
node agents/lead-qualifier/setup.mjs                          # create/update tools + the baseline agent
node --test agents/lead-qualifier/tests/*.test.mjs            # 36 offline tests, no keys
node agents/lead-qualifier/evals/run.mjs --label candidate    # 16 simulated calls, ~70 s
node agents/lead-qualifier/evals/gate.mjs agents/lead-qualifier/evals/results/latest-baseline.json

# regressions (each is a separate agent, so the shipped baseline is never overwritten)
node agents/lead-qualifier/setup.mjs --variant no-referral     # or model-decides
node agents/lead-qualifier/evals/run.mjs --variant no-referral
node agents/lead-qualifier/evals/gate.mjs agents/lead-qualifier/evals/results/latest-no-referral.json
```

## Files

```
policy.json                 intake policy: plans, referral and claim rules, self-pay prices, service area, red flags
prompts/system-prompt.md    baseline prompt;  prompts/model-decides.md = regression prompt
build.mjs  setup.mjs        agent + tool configs as code; push to ElevenLabs (variants are separate agents)
tools.mjs  seed.json        gateway adapter + fictional schedule, referrals on file, an existing lead
src/policy.js               eligibility rules (pure)
src/tools-core.js           tool logic over in-memory state (pure)
src/score.js                per-call scoring
fixtures/personas.json      16 simulated callers with expected outcomes
evals/run.mjs gate.mjs      harness and gate;  evals/baseline.json;  evals/results/*.json (every run kept)
tests/                      offline unit, config and scoring tests
```

## Limits

- **No live phone calls.** The account has no phone number, so every call is a text simulation. Speech-recognition
  errors, accents and interruptions are untested.
- **Spanish voice.** The voice model `eleven_flash_v2` is English-only, and the API requires it for an English
  agent. Spoken Spanish needs the Spanish preset to override the voice model with a multilingual one before
  going live. The Spanish evals are text only.
- **Judge-scored floors.** The medical-advice and coverage-promise checks rely on the judge model.
  It produced one false positive during the build: "not in our network, so it would be self-pay". The rubric now allows that.
- **Caller ID in tests.** The caller ID fallback is tested by passing `system__caller_id` as a test variable.
  On real calls, the phone carrier supplies it.
