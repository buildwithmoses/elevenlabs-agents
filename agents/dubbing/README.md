# Home-exercise video dubbing (ElevenLabs Dubbing + Speech-to-Text)

Riverbend Physical Therapy's home exercise videos exist only in English, so a third of its patients do their
exercises from memory or guess. This pipeline dubs each video into **Spanish** and **Vietnamese** with the
ElevenLabs Dubbing API, then **checks what the dub actually says** before a clinician can publish it.

> **Fictional.** Riverbend, Dr. Elena Ruiz and the three videos are made up (see
> [`../../fixtures/COMPANY.md`](../../fixtures/COMPANY.md)). The videos were generated for this build with
> ElevenLabs text-to-speech and simple title cards. No real patient content.

## The customer problem

A wrong number in a home exercise video is a clinical error: "hold 5 seconds" heard as "15", "10 reps" as
"100", "left knee" as "right knee", or the "stop if you feel sharp pain" line dropped. Riverbend's rule is
that **anything clinical waits for Dr. Ruiz**, but she can't check 40 videos in three languages line by line,
and she doesn't speak Vietnamese. So she needs the pipeline to tell her exactly which facts are confirmed,
and to refuse to put anything in front of her that isn't.

## How it works

```
source video (EN) ──► ElevenLabs Dubbing API (es, vi) ──► dubbed video + the dub's own translated script
                                                              │
     1. TRANSLATION check (code): does the translated script keep every critical fact?
     2. AUDIO check: ElevenLabs Speech-to-Text listens to the dub, word timestamps on
          • code: every number spoken (digits or words, es + vi number parsers), as often as needed
          • code: the correct side said, the wrong side never said (clinical glossary per language)
          • code: the safety line present (glossary: "dolor agudo" + "para"; "đau nhói" + "dừng")
          • code: no new exercise numbers (10 → 100), each number spoken while its card is on screen
          • code: the audio matches the dub's own script (word overlap ≥ 60%), else "unintelligible"
          • LLM back-translation (GPT-6.1 Terra via OpenRouter) as a second opinion; a claim only
            counts if code confirms that number is really in the transcript (catches reps/sets swaps)
     3. If only the AUDIO failed: re-voice the dub's own translation with ElevenLabs eleven_v3,
        one sentence group per title card, and run every check again
     4. Review packet for Dr. Ruiz (review/<video>.<lang>.md): side by side, every fact, every issue
     5. approve.mjs: only Dr. Ruiz, only a clean dub, only the exact file QA checked (sha256)
     6. publish.mjs: only approved, unchanged files → published/ + manifest.json
```

Code decides; the model only offers a second opinion that code has to confirm. Nothing reaches patients
without a named clinician approving one exact video in one exact language.

## What happened on the real dubs

| Dub | Translation check | Audio check | Result |
|---|---|---|---|
| Spanish × 3 | pass | pass (audio matches script 100%) | ready for Dr. Ruiz |
| Vietnamese × 3 | **pass** | **fail**: speech-to-text matched only 13–61% of the dub's own script; numbers, the left side and safety lines missing | re-voiced with eleven_v3 → **pass** (92–100% match) → ready |

The Vietnamese finding is the important one. ElevenLabs translated all three correctly (the job's own
script keeps every fact), but the dubbed voice was not intelligible: Scribe heard "Giữa trong bà già" for
"Giữ trong ba giây" (hold for three seconds). Two checks show the problem is the voice, not the transcriber:
- Scribe v1 and v2 heard the same garbled audio.
- A control sentence voiced with `eleven_multilingual_v2` also came back garbled, while the same sentence
  voiced with `eleven_v3` came back word for word.

Without the audio check, the translation looked perfect and these would have shipped.

The title cards stay in English (dubbing changes the audio only). A real rollout would localize the cards too.

## Eval results

15 cases: the 6 real dubs plus 9 deliberately corrupted dubs ([`fixtures/corrupted.json`](fixtures/corrupted.json))
built from real transcripts: 10→100 reps, safety line dropped, left→right (Spanish and Vietnamese),
30→3 seconds rest, 5→15 seconds hold, 15→50 reps, and reps/sets swapped (same numbers, different meaning).
A simulated Dr. Ruiz approves **everything** a packet marks ready, on purpose, so the system itself has to
protect patients. The eval also attacks the approval rules: publish with no approval, approval by the front
desk manager, approving a blocked dub, and publishing a file changed after approval.

| Gate check | Floor | Baseline | Regression: no fact check |
|---|---|---|---|
| Every critical number spoken, or flagged | 1.0 | **1.0** | 0.0 |
| Safety line present, or flagged | 1.0 | **1.0** | 0.0 |
| Nothing published without approval (incl. 4 attacks) | 1.0 | **1.0** | 1.0 |
| Corrupted dubs caught, for the right reason | 1.0 | **1.0** (9/9) | 0.0 (0/9) |
| Corrupted dubs published | max 0 | **0** | **9** |
| Real dubs ready for review | info | 6/6 (3 after re-voicing) | 6/6 (3 unintelligible Vietnamese dubs included) |
| Spanish false alarms | info | 0 | 0 |
| Gate | | **PASSED** | **FAILED** (exit 1) |

The regression keeps the approval step, so "nothing published without approval" still holds: Dr. Ruiz
approved every one. That's the point. Without the fact check, her approval is blind, and the dub that says
"100 reps", the one that tells a patient to work the wrong knee and the three Vietnamese dubs nobody can
understand all go out with her name on them.

The reps/sets swap (c5) is the one case code alone can't see, since the numbers are all present. It is caught
only because the LLM's back-translation claimed "reps 3" and code confirmed a 3 is actually spoken. A claim
the transcript doesn't support is ignored (tested).

18 offline tests (saved transcripts, no keys): number parsing in both languages, every real and corrupted
transcript, claim verification, timing drift, wrong side, alignment, approval and publish rules.

## Cost

| Item | Usage |
|---|---|
| ElevenLabs Dubbing, 6 jobs (3 videos × 2 languages, ~19 s each) | 5,804 credits (926–990 per job, from the usage API) |
| ElevenLabs TTS: source narration 778 chars, re-voicing 764 chars, model control tests ~300 chars | ~1,850 credits |
| ElevenLabs Speech-to-Text (Scribe v1), 9 short files plus 2 control runs | a few hundred credits |
| OpenRouter judge (back-translation), all runs | under $0.06; about $0.019 per full eval |

About 8,000 ElevenLabs credits in total, under 0.5% of the plan's monthly 1.8M. The source videos are
~19 seconds each (57 s total) to keep dubbing credits low.

## Run it

From the repo root (`.env` needs `ELEVENLABS_API_KEY` and `OPENROUTER_API_KEY`):

```bash
node agents/dubbing/scripts/make-videos.mjs        # TTS narration + cards -> media/source/*.mp4 (committed)
node agents/dubbing/scripts/dub.mjs                # Dubbing API, es + vi; resumes by job id
node agents/dubbing/scripts/fetch-scripts.mjs      # the dub's own translated script per job
node agents/dubbing/scripts/transcribe.mjs         # Speech-to-Text of every dub (cached in fixtures/transcripts)
node agents/dubbing/scripts/qa.mjs                 # checks, re-voicing, review/<key>.md packets
node agents/dubbing/scripts/approve.mjs --key bridges.es --approver "Dr. Elena Ruiz"
node agents/dubbing/scripts/publish.mjs            # copies approved files to media/out/published/
node agents/dubbing/evals/run.mjs --label candidate && node agents/dubbing/evals/gate.mjs
node agents/dubbing/evals/run.mjs --variant no-fact-check --label no-fact-check   # the regression
node --test agents/dubbing/tests/*.test.mjs        # offline
```

Dubbed and re-voiced videos go to `media/out/` (gitignored). Transcripts, translated scripts,
back-translations and review packets are small and committed, so tests and the evals' QA run offline.

## Files

```
fixtures/videos.json        scripts and labeled critical facts      fixtures/corrupted.json   9 broken dubs
fixtures/transcripts/       Scribe output (original + re-voiced)    fixtures/scripts/         dub translations
fixtures/backtranslations/  LLM second opinions                     review/                   packets for Dr. Ruiz
src/numbers.js  src/checks.js  src/align.js  src/review.js  src/backtranslate.js
scripts/  make-videos, cards.py, dub, fetch-scripts, transcribe, pipeline, qa, revoice, approve, publish
evals/run.mjs  evals/gate.mjs  evals/baseline.json  evals/results/
```

## Limits

- Speech-to-text is the judge of what was said. If Scribe mishears a correct dub, the dub is blocked (safe
  direction); the packet shows exactly what was heard.
- Facts are checked per video, with timing per card. A fact repeated in two cards (heel slides says "left"
  twice) passes if it's said at least once and the wrong side is never said.
- Re-voicing needs the translation to split into the same number of sentences as the source; if it doesn't,
  the dub stays blocked for a person.
- The approver's identity is a name on the command line. In production this would be the clinician's login.
