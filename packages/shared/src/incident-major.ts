/**
 * Incident management, chunk 4: major incidents, problem records, post-incident
 * reviews and the monthly report. Pure rules and the DTOs the API validates with.
 * See docs/INCIDENT-MANAGEMENT.md, section 5.
 */
import { z } from 'zod';
import { INC_CATEGORY_KEYS, INC_OPEN_STATUSES, INC_PRIORITIES, INC_STATUSES, type IncPriority, type IncStatus } from './incidents';

/* ------------------------------ major incidents ------------------------------ */

/** Minutes between customer updates on a major incident, by priority, unless the lead picks another. */
export const INC_MAJOR_DEFAULT_INTERVAL: Record<IncPriority, number> = { p1: 30, p2: 60, p3: 120, p4: 240 };
export const INC_MAJOR_MIN_INTERVAL = 10;
export const INC_MAJOR_MAX_INTERVAL = 480;
/** An update this many minutes late goes to the lead and the whole team, not only the comms owner. */
export const INC_MAJOR_ESCALATE_AFTER_MINUTES = 15;

export interface IncMajorInput {
  major: boolean;
  major_ended_at: string | Date | null;
  status: IncStatus;
}

/** A live major incident: declared, not yet resolved (or cancelled / merged). */
export function incMajorActive(i: IncMajorInput): boolean {
  return i.major && !i.major_ended_at && INC_OPEN_STATUSES.includes(i.status);
}

export type IncMajorClockState = 'on_track' | 'due' | 'overdue' | 'none';
export interface IncMajorClock {
  state: IncMajorClockState;
  dueAt: string | null;
  /** Milliseconds until the next update is due (negative = late). */
  leftMs: number | null;
}

/** Where the cadence of customer updates stands: on track, due now, or late (past the escalation point). */
export function incMajorUpdateClock(i: IncMajorInput & { next_update_due_at: string | Date | null }, now = Date.now()): IncMajorClock {
  if (!incMajorActive(i) || !i.next_update_due_at) return { state: 'none', dueAt: null, leftMs: null };
  const due = new Date(i.next_update_due_at).getTime();
  const left = due - now;
  const late = -left > INC_MAJOR_ESCALATE_AFTER_MINUTES * 60_000;
  return { state: left > 0 ? 'on_track' : late ? 'overdue' : 'due', dueAt: new Date(due).toISOString(), leftMs: left };
}

const intervalSchema = z.number().int().min(INC_MAJOR_MIN_INTERVAL).max(INC_MAJOR_MAX_INTERVAL);

/** POST /incidents/:id/major - declare it a major incident. */
export const declareMajorSchema = z
  .object({
    /** Runs the response. Must be an engineer on the customer or a Super Admin. */
    leadId: z.string().uuid(),
    /** Writes the customer updates; defaults to the lead. */
    commsId: z.string().uuid().optional(),
    intervalMinutes: intervalSchema.optional(),
    /** The first customer update: what we know, and what we're doing. */
    summary: z.string().trim().min(5, 'Say what we know so far').max(4000),
  })
  .strict();
export type DeclareMajorInput = z.infer<typeof declareMajorSchema>;

/** POST /incidents/:id/major/updates - a customer update on a live major incident. */
export const majorUpdateSchema = z
  .object({
    body: z.string().trim().min(1, 'Write the update').max(4000),
    /** Change the cadence from here on. */
    intervalMinutes: intervalSchema.optional(),
  })
  .strict();
export type MajorUpdateInput = z.infer<typeof majorUpdateSchema>;

/** PATCH /incidents/:id/major - change the lead or comms owner. */
export const majorRolesSchema = z.object({ leadId: z.string().uuid().optional(), commsId: z.string().uuid().optional() }).strict();
export type MajorRolesInput = z.infer<typeof majorRolesSchema>;

/** POST /incidents/:id/children - link live incidents under a major incident. */
export const linkChildrenSchema = z.object({ childIds: z.array(z.string().uuid()).min(1).max(50) }).strict();
export type LinkChildrenInput = z.infer<typeof linkChildrenSchema>;

/* ------------------------------ problems ------------------------------ */

export const INC_PROBLEM_STATUSES = ['investigating', 'known_error', 'fix_planned', 'resolved'] as const;
export type IncProblemStatus = (typeof INC_PROBLEM_STATUSES)[number];
export const INC_PROBLEM_STATUS_LABELS: Record<IncProblemStatus, string> = {
  investigating: 'Investigating',
  known_error: 'Known error',
  fix_planned: 'Fix planned',
  resolved: 'Resolved',
};

/** PRB-0003 */
export function incProblemReference(number: number): string {
  return `PRB-${String(number).padStart(4, '0')}`;
}

/** A known error: the cause is understood and there is a way round it, so new incidents of the same kind can use it. */
export function incIsKnownError(p: { status: IncProblemStatus; workaround: string }): boolean {
  return (p.status === 'known_error' || p.status === 'fix_planned') && p.workaround.trim().length > 0;
}

/** Whether a problem explains an incident of this category (a problem with no sub-category covers them all). */
export function incProblemMatches(p: { category: string | null; subcategory: string | null }, category: string, subcategory: string | null): boolean {
  if (!p.category || p.category !== category) return false;
  return !p.subcategory || p.subcategory === subcategory;
}

const problemFields = {
  title: z.string().trim().min(3, 'Give the problem a short title').max(160),
  description: z.string().trim().max(4000),
  category: z.enum(INC_CATEGORY_KEYS).nullable(),
  subcategory: z.string().trim().max(60).nullable(),
  status: z.enum(INC_PROBLEM_STATUSES),
  rootCause: z.string().trim().max(4000),
  workaround: z.string().trim().max(4000),
  customerNote: z.string().trim().max(1000),
  ownerId: z.string().uuid().nullable(),
};

/** POST /incidents/problems */
export const createProblemSchema = z
  .object({
    title: problemFields.title,
    description: problemFields.description.default(''),
    category: problemFields.category.default(null),
    subcategory: problemFields.subcategory.default(null),
    status: problemFields.status.default('investigating'),
    rootCause: problemFields.rootCause.default(''),
    workaround: problemFields.workaround.default(''),
    customerNote: problemFields.customerNote.default(''),
    ownerId: problemFields.ownerId.default(null),
    /** Link this incident to the new problem straight away. */
    incidentId: z.string().uuid().optional(),
  })
  .strict();
export type CreateProblemInput = z.infer<typeof createProblemSchema>;

/** PATCH /incidents/problems/:id */
export const updateProblemSchema = z.object(Object.fromEntries(Object.entries(problemFields).map(([k, v]) => [k, v.optional()])) as { [K in keyof typeof problemFields]: z.ZodOptional<(typeof problemFields)[K]> }).strict();
export type UpdateProblemInput = z.infer<typeof updateProblemSchema>;

/** POST /incidents/:id/problem - link (or with null, unlink) the problem behind an incident. */
export const linkProblemSchema = z.object({ problemId: z.string().uuid().nullable() }).strict();
export type LinkProblemInput = z.infer<typeof linkProblemSchema>;

/** GET /incidents/known-errors?category=&subcategory= - what a customer or engineer can be told before raising one. */
export const knownErrorsQuerySchema = z.object({ category: z.enum(INC_CATEGORY_KEYS), subcategory: z.string().trim().max(60).optional() }).strict();
export type KnownErrorsQuery = z.infer<typeof knownErrorsQuerySchema>;

/* ------------------------------ post-incident review ------------------------------ */

export interface IncReviewAction {
  text: string;
  owner?: string;
  /** YYYY-MM-DD */
  due?: string;
  /** The service request this became, if it did. */
  serviceRequestId?: string;
}

/** The headings of a review, in order. The timeline between "what happened" and "cause" is built from the incident. */
export const INC_REVIEW_SECTIONS = [
  { key: 'summary', label: 'What happened', help: 'In a few sentences: what broke, who was affected and for how long.' },
  { key: 'cause', label: 'Why it happened', help: 'The cause, in plain words.' },
  { key: 'went_well', label: 'What worked', help: 'What helped us find it or fix it quickly.' },
  { key: 'went_badly', label: "What didn't", help: 'What slowed us down or made it worse.' },
] as const;

/** PUT /incidents/:id/review */
export const incidentReviewSchema = z
  .object({
    summary: z.string().trim().max(4000),
    cause: z.string().trim().max(4000),
    wentWell: z.string().trim().max(4000),
    wentBadly: z.string().trim().max(4000),
    actions: z
      .array(
        z
          .object({
            text: z.string().trim().min(1).max(300),
            owner: z.string().trim().max(120).optional(),
            due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
            serviceRequestId: z.string().uuid().optional(),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();
export type IncidentReviewInput = z.infer<typeof incidentReviewSchema>;

/* ------------------------------ MSP queue and reports ------------------------------ */

/** GET /msp/incidents */
export const mspIncidentsQuerySchema = z
  .object({
    status: z.enum([...INC_STATUSES, 'open', 'all'] as [string, ...string[]]).default('open'),
    /** Super Admins only: limit to one MSP ('none' = customers with no MSP). */
    mspId: z.union([z.string().uuid(), z.literal('none')]).optional(),
    /** Only incidents assigned to me. */
    mine: z.enum(['true']).optional(),
    priority: z.enum(INC_PRIORITIES).optional(),
  })
  .strict();
export type MspIncidentsQuery = z.infer<typeof mspIncidentsQuerySchema>;

/** GET /incidents/report?from=&to= (ISO dates; `to` exclusive). */
export const incidentReportQuerySchema = z
  .object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
  })
  .strict();
export type IncidentReportQuery = z.infer<typeof incidentReportQuerySchema>;
