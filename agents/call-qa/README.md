# Call QA: every call scored, not 5 a month

Part of [elevenlabs-agents](../../README.md). Riverbend Physical Therapy is fictional
([`fixtures/COMPANY.md`](../../fixtures/COMPANY.md)), and so are all 20 calls here. The audio is generated with
ElevenLabs voices from scripts in [`fixtures/calls.json`](fixtures/calls.json); no real patient is involved.

## The customer problem

Hannah Cho, Riverbend's compliance lead, reviews **5 random front-desk calls a month** by ear. Six clinics
take hundreds of calls a week, in English and Spanish. What slips through:

1. **HIPAA identity checks get skipped.** Staff read out a patient's appointment, therapist or balance before
   asking for a date of birth, or to a spouse who was never verified.
2. **Red-flag symptoms get booked like routine visits.** "My leg went numb this morning" should mean "call 911",
   not "Friday at two".
3. **Wrong fees and missing recording notices** cause complaints and chargebacks.

Her rule: **the system can find problems, but nothing counts against a staff member until she confirms it.**

## How it works

```
call recording ──▶ Scribe v2 speech-to-text ──▶ speaker turns ──▶ code checks ─────────────┐
                    (diarized, word timestamps)   (staff vs caller)   disclosure, ID order,     ├─▶ scorecard + report
                                                                      fees, red flag → 911      │   evidence check
                                                  └──────────────▶ LLM judge (GPT-6.1 Terra) ──┘   (every fail quotes a
                                                                      advice, courtesy,             real transcript line)
                                                                      resolution + HIPAA 2nd opinion        │
                                                                                                            ▼
                                                                           HIPAA / safety fails ──▶ Hannah's review queue
                                                                                                    (pending until confirmed)
```

| Step | What | Where |
|---|---|---|
| Transcribe | ElevenLabs **Speech to Text, Scribe v2**, `diarize=true`, 2 speakers, word timestamps. Raw output cached so tests run offline | [`src/transcribe.mjs`](src/transcribe.mjs) |
| Turns | Words become speaker turns. Staff is whoever greets with the clinic name or the recording notice | [`src/turns.js`](src/turns.js) |
| Code checks | Four items decided from the transcript itself, in order. English and Spanish, with number words ("seventy-five dollar", "cuarenta dólares") parsed | [`src/checks.js`](src/checks.js) |
| Judge | Only the items that need judgement, plus a second opinion on HIPAA (whose identity was verified) | [`src/judge.mjs`](src/judge.mjs) |
| Evidence rule | A failure must quote a line that is really in the transcript, or it is dropped and counted | [`src/pipeline.mjs`](src/pipeline.mjs) |
| Review queue | HIPAA and safety failures wait as `pending`. Only `confirmed` ones count against staff, and confirming needs a named reviewer | [`src/review-queue.mjs`](src/review-queue.mjs) |

### The rubric ([`rubric.json`](rubric.json))

| Item | Checked by | Rule |
|---|---|---|
| recording_disclosure | code | "This call may be recorded" (or the Spanish) in staff's first two turns |
| identity_before_phi | code + judge | No details of existing care before the caller gives a date of birth staff asked for. Code checks the **order**; the judge checks **whose** identity was verified. Either one failing is a fail |
| fee_correct | code | Late cancel / no-show $40, self-pay evaluation $160, follow-up $110. Each amount is matched to its own kind; caller-quoted amounts are ignored |
| red_flag_911 | code | A red-flag symptom from the **caller** (numbness, chest pain or tightness, trouble breathing, severe new pain) must get 911 / ER guidance from **staff**. Denied symptoms ("no numbness") don't count |
| no_medical_advice | judge | No medication, doses or changes to treatment |
| courteous | judge | Polite, doesn't dismiss or blame |
| resolved | judge | Request handled, or a specific follow-up committed |

## Results

20 labeled calls (14 straightforward, 6 harder ones: caller quotes the wrong fee, recording notice only at the
end, verified caller asks about her husband, denied symptoms, caller says "911" but staff doesn't, a clean
Spanish control). 140 item scores. Measured 2026-10-29 on real Scribe transcripts of the generated audio.

| Variant | HIPAA recall (floor 1.0) | 911 recall (floor 1.0) | Fails with a real quote (floor 1.0) | Item accuracy (floor 0.95) | False alarms (max 0.05) | Gate | Judge cost / 20 calls |
|---|---|---|---|---|---|---|---|
| **Baseline**: diarized, code + judge | 1.0 | 1.0 | 1.0 | 0.993 to 1.0 | 0 to 0.008 | **passed** | $0.024 |
| No diarization: speaker labels thrown away | 1.0 | **0.0** | 1.0 | **0.85** | **0.136** | **blocked** | $0.028 |
| Code only: judge removed to save cost | **0.75** | 1.0 | 1.0 | 0.964 | 0 | **blocked** | $0 |
| Judge only: no diarization, no code checks | 1.0 | 1.0 | 1.0 | 0.986 | 0.016 | passed | $0.041 |

What this shows, honestly:

- **Speaker labels carry the safety check.** Without diarization the code can't tell a caller's symptom from
  staff's answer, so it never sees a red flag (911 recall 0.0) and every call "lacks" a recording notice.
- **Code alone has a blind spot.** It checks that a date of birth came before any care details, but in c17
  the caller verified *herself* and then got her husband's appointment and balance. Only the judge catches
  that, so HIPAA is a union of both detectors.
- **A frontier judge alone also passed this set.** On 20 short scripted calls GPT-6.1 Terra scored everything
  well with no code at all. It cost 1.7× as much, took 96s against 58s, and its answers vary between runs
  (the one baseline disagreement, whether "maybe try calling back another day" is discourteous, flips run to
  run). The code checks are deterministic, explainable to staff line by line, and free. Real calls are longer
  and messier than these; that comparison is worth re-running on real recordings before deciding.
- **The code checks were written with these fixtures in view.** The unit tests add held-out variations
  (negation, caller-quoted amounts, mixed price sentences), but a pilot on real calls would need its own
  labeled set.

Review queue after a full run: 7 pending flags (c02, c12, c13, c17 identity; c06 medical advice; c07, c19 red
flag), each with its quoted line. Nothing is confirmed until a named reviewer does it.

**Bonus, scoring the voice agents themselves:** [`score-convai.mjs`](score-convai.mjs) pulls finished ElevenLabs
Agents conversations (read-only) or a saved simulation and scores them with the same rubric. Run on the
Cedar Hollow receptionist's one real call, it found that agent's greeting has **no recording notice**.

**Cost:** 20 calls, 9,437 TTS characters (Text to Dialogue, eleven_v3) and about 11 minutes of Scribe
transcription for the whole build. Judge spend about $0.024 per 20-call run; all OpenRouter spend for the
build was about $0.35.

## Run it

From the repo root (needs `ELEVENLABS_API_KEY` and `OPENROUTER_API_KEY` in `.env`, and ffmpeg):

```bash
node agents/call-qa/scripts/generate-audio.mjs            # fixture audio (cached; --force to regenerate)
node agents/call-qa/run.mjs                               # score all 20 calls -> reports/ + review queue
node agents/call-qa/run.mjs --audio path/to/call.mp3      # score any recording
node agents/call-qa/src/review-queue.mjs list             # Hannah's queue
node agents/call-qa/src/review-queue.mjs confirm c02 identity_before_phi --by hannah
node agents/call-qa/score-convai.mjs --agent Riverbend    # audit the voice agents' own conversations
node agents/call-qa/evals/run.mjs [--variant no-diarization|code-only|judge-only]
node agents/call-qa/evals/gate.mjs [--variant ...]        # exit 1 blocks the change
node --test agents/call-qa/tests/*.test.mjs               # 30 offline tests, no keys
```

## Files

```
rubric.json                 the seven items, policy amounts, which failures go to review
fixtures/calls.json         20 call scripts with labels      fixtures/audio/*.mp3  generated audio (32 kbps)
fixtures/transcripts/       cached Scribe v2 responses (diarized, word timestamps)
src/                        transcribe, turns, checks (code), judge, pipeline, review queue
run.mjs  score-convai.mjs   score recordings / ElevenLabs conversations
reports/                    one JSON scorecard + Markdown report per call, review-queue.json
evals/                      run.mjs, gate.mjs, baseline.json, dated results per variant
```
