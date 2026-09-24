import { z } from 'zod';
import {
  CALL_QUEUE_NO_AGENT_ACTIONS,
  CALL_QUEUE_NO_AGENT_APPLY_TO,
  CALL_QUEUE_OVERFLOW_ACTIONS,
  CALL_QUEUE_ROUTING_METHODS,
  CALL_QUEUE_TIMEOUT_ACTIONS,
} from './domain';

/**
 * The Auto Attendant / Call Queue creation wizard (Data Collection site
 * workspace, "Call flows" tab) - a guided, plain-language requirements
 * capture a non-technical customer stakeholder could plausibly fill in
 * themselves. Deliberately looser than the Teams-native shapes in dto.ts
 * (`buildAutoAttendantWritable`/`buildCallQueueWritable`) - free text where a
 * real identity would eventually be needed (a person's name, a department),
 * resolved later by `wizard-convert.ts` when an engineer imports the
 * capture into Design & Build. See the "Auto Attendant / Call Queue
 * Creation Wizard" plan for the full design.
 */

const str = (max: number) => z.string().trim().max(max);

/** "Where should this call go?" - the wizard's one routing control, plain-language kinds mapped onto AutoAttendantCallableEntity/CallQueueActionSettings by wizard-convert.ts. */
export const wizardTargetSchema = z
  .object({
    kind: z.enum(['person', 'team', 'message', 'voicemail', 'external', 'operator', 'call_queue']),
    /** Free text: a person's name/email, a department/queue name, a message to play, or an outside phone number - whichever `kind` calls for. Unused for 'voicemail'/'operator'. For 'call_queue' this is just the created queue's name for display - `flowId` is what actually resolves it. */
    label: str(200).optional(),
    /** kind === 'call_queue' only - the discovery_flows row this points at, always set once the "Set up a new call queue" nested wizard flow completes (see TargetPicker.tsx). */
    flowId: z.string().uuid().optional(),
  })
  .strict();
export type WizardTarget = z.infer<typeof wizardTargetSchema>;

export const wizardMenuOptionSchema = z
  .object({
    /** "1".."9","0","*","#" - auto-assigned in order, editable. */
    key: str(4).min(1),
    label: str(100).min(1),
    target: wizardTargetSchema,
  })
  .strict();
export type WizardMenuOption = z.infer<typeof wizardMenuOptionSchema>;

export const wizardCallFlowSchema = z
  .object({
    mode: z.enum(['menu', 'direct', 'voicemail']),
    greeting: str(1000).optional(),
    /** mode === 'direct' only. */
    target: wizardTargetSchema.optional(),
    /** mode === 'menu' only. */
    options: z.array(wizardMenuOptionSchema).max(12).optional(),
    allowDialByName: z.boolean().optional(),
  })
  .strict();
export type WizardCallFlow = z.infer<typeof wizardCallFlowSchema>;

const wizardTimeRangeSchema = z.object({ start: str(5), end: str(5) }).strict();
const wizardWeekdayHours = () => z.array(wizardTimeRangeSchema).max(4);
/** A simplified per-day open/close picker - mirrors dto.ts's autoAttendantScheduleSchema.weekly shape exactly (same field names/types) so wizard-convert.ts can pass it straight through. */
export const wizardWeeklyHoursSchema = z
  .object({
    monday: wizardWeekdayHours(),
    tuesday: wizardWeekdayHours(),
    wednesday: wizardWeekdayHours(),
    thursday: wizardWeekdayHours(),
    friday: wizardWeekdayHours(),
    saturday: wizardWeekdayHours(),
    sunday: wizardWeekdayHours(),
  })
  .strict();
export type WizardWeeklyHours = z.infer<typeof wizardWeeklyHoursSchema>;

export const autoAttendantWizardAnswersSchema = z
  .object({
    languageId: str(20).min(1),
    timeZoneId: str(80).min(1),
    hoursType: z.enum(['always', 'standard', 'custom']),
    /** hoursType === 'custom' only. */
    customHours: wizardWeeklyHoursSchema.optional(),
    businessFlow: wizardCallFlowSchema,
    /** Absent when hoursType === 'always' - the business-hours flow is used 24/7, matching Microsoft's own "no after-hours flow specified" behavior. */
    afterHoursFlow: wizardCallFlowSchema.optional(),
    operator: wizardTargetSchema.optional(),
    holidaysEnabled: z.boolean(),
    holidays: z
      .array(
        z
          .object({
            name: str(160).min(1),
            dateRange: z.object({ start: str(20), end: str(20) }).strict(),
            flow: wizardCallFlowSchema,
          })
          .strict(),
      )
      .max(10)
      .optional(),
  })
  .strict();
export type AutoAttendantWizardAnswers = z.infer<typeof autoAttendantWizardAnswersSchema>;

const callQueueActionAnswerSchema = (actions: readonly [string, ...string[]]) =>
  z
    .object({
      action: z.enum(actions),
      /** action === 'Forward' only - who/where to send the call, plain text, resolved later. */
      forwardTo: str(200).optional(),
    })
    .strict();

export const callQueueWizardAnswersSchema = z
  .object({
    languageId: str(20).min(1),
    /** Free-text names/emails - matched against this site's synced users by wizard-convert.ts; anything unmatched is surfaced as a warning at import time. */
    agents: z.array(str(200)).max(50),
    routingMethod: z.enum(CALL_QUEUE_ROUTING_METHODS),
    presenceBasedRouting: z.boolean(),
    agentAlertTime: z.number().int().min(15).max(180),
    overflowThreshold: z.number().int().min(0).max(200),
    overflow: callQueueActionAnswerSchema(CALL_QUEUE_OVERFLOW_ACTIONS),
    timeoutThreshold: z.number().int().min(0).max(2700),
    timeout: callQueueActionAnswerSchema(CALL_QUEUE_TIMEOUT_ACTIONS),
    noAgents: callQueueActionAnswerSchema(CALL_QUEUE_NO_AGENT_ACTIONS),
    noAgentsApplyTo: z.enum(CALL_QUEUE_NO_AGENT_APPLY_TO),
  })
  .strict();
export type CallQueueWizardAnswers = z.infer<typeof callQueueWizardAnswersSchema>;
