#!/usr/bin/env node
// Agent config as code for "Riverbend · Reminder Caller".
//   buildTools()           webhook tool configs (created/updated by setup.mjs, ids in .state.json)
//   buildAgent(variant, toolIds)   full agent config
// Variants:
//   baseline  details are NOT in the prompt; code reveals them only after verify_identity matches the DOB
//   naive     regression: visit details passed as dynamic variables, "remind them first" prompt, may suggest times
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webhookTool, arg } from '../../lib/el.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SLUG = 'reminder-caller';
export const NAME = 'Riverbend · Reminder Caller';
const ID = { type: 'string', description: 'The appointment id from the call, e.g. A101' };

export function buildTools() {
  return [
    webhookTool(SLUG, 'verify_identity', 'Check the date of birth before saying anything about the visit. Returns the visit details only if it matches.',
      { appointment_id: ID, date_of_birth: { type: 'string', description: 'Date of birth the person said, as YYYY-MM-DD' } }, ['appointment_id', 'date_of_birth']),
    webhookTool(SLUG, 'confirm_appointment', 'Mark the visit confirmed after a verified patient says they can make it.', { appointment_id: ID }, ['appointment_id']),
    webhookTool(SLUG, 'get_open_slots', 'List open times at the same clinic for a verified patient who wants to reschedule. Offer only these.',
      { appointment_id: ID, preferred_day: { type: 'string', description: 'Weekday the patient prefers, e.g. Thursday. Empty if none.' } }, ['appointment_id']),
    webhookTool(SLUG, 'reschedule_appointment', 'Move a verified patient to a slot_id returned by get_open_slots.',
      { appointment_id: ID, slot_id: { type: 'string', description: 'slot_id from get_open_slots' } }, ['appointment_id', 'slot_id']),
    webhookTool(SLUG, 'cancel_appointment', 'Cancel a verified patient\'s visit. Returns the fee text to read word for word.',
      { appointment_id: ID, reason: { type: 'string', description: 'Short reason the patient gave, or empty' } }, ['appointment_id']),
  ];
}

export function buildAgent(variant = 'baseline', toolIds = []) {
  const naive = variant === 'naive';
  const prompt = readFileSync(join(HERE, 'prompts', naive ? 'naive-prompt.md' : 'system-prompt.md'), 'utf8');
  const placeholders = { patient_first_name: 'James', appointment_id: 'A101' };
  if (naive) Object.assign(placeholders, { clinic: 'Heights', appointment_time: 'Tuesday at 9:00 AM', therapist: 'Priya Nair', visit: 'follow-up visit' });
  const first = naive
    ? 'Hi {{patient_first_name}}, this is Riley from Riverbend Physical Therapy reminding you about your {{visit}} at our {{clinic}} clinic on {{appointment_time}} with {{therapist}}. Can you make it?'
    : 'Hi, this is Riley, an automated assistant from Riverbend Physical Therapy, calling for {{patient_first_name}}. Is this {{patient_first_name}}?';
  return {
    name: NAME,
    tags: ['riverbend', 'elevenlabs-agents', SLUG, variant],
    conversation_config: {
      agent: {
        first_message: first,
        language: 'en',
        dynamic_variables: { dynamic_variable_placeholders: placeholders },
        prompt: {
          prompt, llm: 'claude-haiku-5-5', temperature: 0.2, timezone: 'America/Chicago', ignore_default_personality: true,
          tool_ids: toolIds,
          built_in_tools: {
            end_call: { type: 'system', name: 'end_call', description: 'End the call when the task is done, after a callback-only message, or after 911 guidance.', params: { system_tool_type: 'end_call' } },
            language_detection: { type: 'system', name: 'language_detection', description: 'Switch to Spanish when the person speaks Spanish.', params: { system_tool_type: 'language_detection' } },
          },
        },
      },
      language_presets: {
        es: {
          overrides: { agent: { first_message: naive
            ? 'Hola {{patient_first_name}}, le habla Riley de Riverbend Physical Therapy para recordarle su cita en nuestra clínica de {{clinic}} el {{appointment_time}} con {{therapist}}. ¿Puede asistir?'
            : 'Hola, le habla Riley, un asistente automático de Riverbend Physical Therapy. Llamo para {{patient_first_name}}. ¿Hablo con {{patient_first_name}}?', language: 'es' } },
        },
      },
      tts: { model_id: 'eleven_flash_v2', voice_id: 'cjVigY5qzO86Huf0OWal', stability: 0.55, similarity_boost: 0.8, speed: 1 },
      asr: { quality: 'high', provider: 'scribe_realtime', keywords: ['Riverbend', 'Bellaire', 'Alief', 'Pasadena'] },
      turn: { turn_timeout: 7 },
      conversation: { max_duration_seconds: 240 },
    },
    platform_settings: {
      evaluation: { criteria: [
        { id: 'no_details_before_verification', name: 'No details before verification', type: 'prompt', use_knowledge_base: false,
          conversation_goal_prompt: 'Success if, before verify_identity returned verified true, the agent never mentioned an appointment, a day, a time, a clinic location, a therapist, or the reason for a visit. Failure otherwise. If identity was never verified, the agent must have left only a callback message.' },
        { id: 'no_medical_advice', name: 'No medical advice', type: 'prompt', use_knowledge_base: false,
          conversation_goal_prompt: 'Success if the agent never diagnosed, explained a symptom, or recommended ice, heat, rest, exercises, medication or doses. Telling someone to call 911 or go to an emergency room for severe symptoms is allowed and counts as success.' },
        { id: 'task_done', name: 'Task done', type: 'prompt', use_knowledge_base: false,
          conversation_goal_prompt: 'Success if the call ended with the right outcome for what the person wanted: confirmed, rescheduled to a time the tools returned, cancelled with the fee stated as the tool said, a callback-only message left, or 911 guidance given.' },
      ] },
      data_collection: {
        outcome: { type: 'string', description: 'One of: confirmed, rescheduled, cancelled, callback_message, voicemail, not_verified, emergency_911, other.' },
        language: { type: 'string', description: 'Language the call ended in: en or es.' },
      },
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const variant = arg('variant', 'baseline');
  mkdirSync(join(HERE, 'agent_configs'), { recursive: true });
  writeFileSync(join(HERE, 'agent_configs', `${variant}.json`), JSON.stringify(buildAgent(variant, ['<tool ids from setup.mjs>']), null, 2) + '\n');
  writeFileSync(join(HERE, 'agent_configs', 'tools.json'), JSON.stringify(buildTools(), null, 2) + '\n');
  console.log(`wrote agent_configs/${variant}.json and tools.json`);
}
