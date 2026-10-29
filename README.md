# ElevenLabs Agents: five voice and audio agents for one clinic group

Five agents for **Riverbend Physical Therapy**, a fictional group of six clinics in Houston where a third of
patients prefer Spanish and many in Alief prefer Vietnamese. Built on ElevenLabs Agents (ElevenAgents),
Speech-to-Text (Scribe), Text-to-Speech and Dubbing.

Riverbend's rule for every agent:

> "The voice agent schedules, answers from the knowledge base and hands off. It never gives medical advice,
> never reveals health information before verifying identity, and anything clinical waits for Dr. Ruiz."

So **code makes the decisions behind webhook tools, the agent only talks, a person approves anything clinical,
and an eval gate with hard floors blocks a bad change.**

> **Everything is fictional.** Riverbend, its patients, staff, insurers, calls and videos are made up
> ([`fixtures/COMPANY.md`](fixtures/COMPANY.md)). Phone numbers are 555-01xx. No real patient data is used.
> The account has no phone number attached, so the voice agents are tested with ElevenLabs' agent testing API
> (simulated callers, real webhook tool calls), not live phone calls.

## The five agents

| Agent | What it does | What the gate blocked |
|---|---|---|
| [Reminder caller](agents/reminder-caller/) | Calls tomorrow's patients, says nothing about the visit until the date of birth matches, confirms, reschedules or cancels with the late fee decided in code, and ranks the waitlist in code to refill freed slots | A version with visit details in the prompt: it leaked them before verification on 15 of 15 calls |
| [New-patient line](agents/lead-qualifier/) | Screens new patients, and code decides from the intake policy whether to book, quote self-pay, ask for a referral or claim number, or send them to the ER. One CRM lead per caller | A version that let the model decide: it booked a work injury without a claim number, told a caller "you're covered" and guessed at chest pain |
| [Multilingual support](agents/multilingual-support/) | Answers English, Spanish and Vietnamese callers in their language from a patient guide, verifies identity before account details, hands off to staff with one ticket per call | An English-only version: caller's language 0.389, handoffs 0.0 |
| [Call QA](agents/call-qa/) | Transcribes recorded calls with Scribe, checks HIPAA order, fees, recording notice and 911 guidance in code, uses an LLM only for soft items, and queues violations for a person | Without speaker labels it missed every 911 failure; without the judge it missed a privacy slip on a spouse's call |
| [Dubbing](agents/dubbing/) | Dubs home-exercise videos into Spanish and Vietnamese, checks every rep count, side and safety line in the dubbed audio, and publishes only what Dr. Ruiz approves | Without the fact check it published all 9 deliberately corrupted dubs (10 reps became 100, left became right, safety line dropped) |

## Results

All five ran against the hosted tools gateway on 2026-10-29.

| Agent | Cases | Hard floors | Quality | Gate |
|---|---|---|---|---|
| Reminder caller | 15 simulated calls | details before verification, double booking, slots from tool, late fee, medical advice, other patients' info, 911: all 1.0 | outcomes 1.0 | Passed |
| New-patient line | 16 simulated calls | policy violations, double booking, red flags, one CRM lead, medical advice, coverage promises: all 1.0 | qualified correctly 1.0 | Passed |
| Multilingual support | 18 simulated calls, 3 languages | language, verification, handoffs, no material invention, medical advice, 911: all 1.0 on 3 runs in a row | answer accuracy 0.944–1.0 | Passed 3 of 3 (after the fixes below) |
| Call QA | 20 recorded calls, 4 in Spanish | HIPAA-order recall, 911 recall, quoted evidence: all 1.0 | item accuracy 1.0, false alarms 0 | Passed |
| Dubbing | 6 real dubs + 9 corrupted | numbers, safety line, approval, corrupted caught: all 1.0, 0 corrupted published | 0 Spanish false alarms | Passed |

116 offline tests pass with no keys.

### Findings worth knowing

- **ElevenLabs' own test verdicts missed violations.** The platform's success conditions passed 14 of 16 calls
  on both broken versions of the new-patient line. The code checks on the tool log and transcript caught them.
- **Vietnamese dubs translated correctly but spoke unclearly.** The dubbed audio matched only 13–61% of its own
  script, and rep counts went missing. Re-voicing the dub's translation with `eleven_v3` brought all three to
  92–100%, and they passed.
- **The multilingual agent needed code and a stronger model, not just prompt edits.** It occasionally assumed
  today was a weekday, added "subtitles", or dropped a question from a callback ticket, and failed its gate on
  about half the runs. Three fixes got it passing 3 runs in a row: the guide now says what it didn't (city,
  no subtitles, who can access an account); the handoff tool refuses a ticket without the caller's list of
  questions and hands the list back for the agent to read aloud; and the agent moved from Claude Haiku 5.5 to
  Sonnet 5.5 after every remaining slip turned out to be in Vietnamese. Sonnet costs about 25% more credits per
  call. The English-only regression is still blocked on the new model.
- **A judge on its own can look as good as code on easy data.** On these short scripted calls a judge-only QA
  variant also passed, at 1.7x the cost and with answers that varied between runs. The code checks stay.

## How it's built

```
fixtures/COMPANY.md        the fictional clinic group, its policies and approvers
lib/el.mjs                 ElevenLabs REST, agent upsert, agent tests, OpenRouter judge, gateway helpers
gateway/server.mjs         one HTTPS tools backend for every agent (POST /<agent>/<tool>, X-Tools-Secret)
agents/<slug>/             build.mjs (agent config as code), setup.mjs, tools.mjs, src/ (code rules),
                           fixtures/, evals/run.mjs + gate.mjs + baseline.json, tests/
```

- **Agents as code.** Each agent's prompt, voice, language presets, tools and test scenarios are built by
  `build.mjs` and pushed with the ElevenLabs API. Regressions are separate builds of the same agent.
- **Webhook tools on one gateway.** Tools call `https://{{system__env_elagents_tools_host}}/<agent>/<tool>`
  with a secret header stored as an ElevenLabs environment variable. Moving the gateway from an ngrok tunnel
  to Railway was one script re-run, with no agent edits.
- **Evals.** The voice agents run as ElevenLabs agent tests with tool mocking off, so every tool call reaches
  the real gateway. Scores combine code checks on the gateway log and transcript, the platform's own
  verdicts, and an independent judge (GPT-6.1 Terra on OpenRouter) only where code can't decide.

## Run it

```bash
cp .env.example .env        # ELEVENLABS_API_KEY, OPENROUTER_API_KEY, TOOLS_SECRET, TOOLS_HOST
npm run gateway             # local tools gateway on :4700 (or deploy it: npm start on Railway)
npm run setup:shared        # tells ElevenLabs where the gateway is
npm test                    # offline tests, no keys
node agents/<slug>/setup.mjs && node agents/<slug>/evals/run.mjs && node agents/<slug>/evals/gate.mjs
```

The gateway re-imports an agent's `tools.mjs` when it changes, but not the files it imports. Restart it after
editing those.

Usage for the whole build: about 220,000 ElevenLabs credits (agent tests, dubbing, TTS and STT), roughly 12%
of the plan's monthly allowance, and about $2 of judge calls on OpenRouter.

Sibling builds: [n8n-agents](https://github.com/buildwithmoses/n8n-agents),
[langchain-agents](https://github.com/buildwithmoses/langchain-agents),
[openrouter-agents](https://github.com/buildwithmoses/openrouter-agents).
