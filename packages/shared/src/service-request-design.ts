/**
 * Managed Services -> design and deploy inside a service request.
 *
 * An engineer designs a request on its Design tab with the normal Design &
 * Build editors. Every Design & Build row made there (or by "Prefill from the
 * request") is linked to the request in service_request_items, and the
 * request's Deploy tab runs What-If / Deploy on just those rows. A live run
 * that finishes cleanly moves the request to Deployed.
 *
 * Rows stay ordinary Design & Build rows: they also show on the site's Design
 * & Build page, flagged with the request reference.
 */
import { z } from 'zod';
import type { DEPLOYMENT_SHEETS } from './domain';
import { SR_BUILD_KIND } from './service-request-build';
import type { SrStatus, SrType } from './service-requests';

/** What a request can be linked to. `site` is a new site (Data Collection); the rest are Design & Build rows. */
export const SR_ITEM_KINDS = ['site', 'user', 'cap', 'resource_account', 'shared_calling_policy', 'call_queue', 'auto_attendant', 'number_range'] as const;
export type SrItemKind = (typeof SR_ITEM_KINDS)[number];

export const SR_ITEM_KIND_LABELS: Record<SrItemKind, string> = {
  site: 'Site',
  user: 'User',
  cap: 'Common area phone',
  resource_account: 'Resource account',
  shared_calling_policy: 'Shared calling policy',
  call_queue: 'Call queue',
  auto_attendant: 'Auto attendant',
  number_range: 'Number range',
};

/** Rows a deployment can push to Teams, and the deployment sheet each one is on. */
export const SR_ITEM_SHEET: Partial<Record<SrItemKind, (typeof DEPLOYMENT_SHEETS)[number]>> = {
  user: 'users',
  cap: 'caps',
  resource_account: 'resource_accounts',
  shared_calling_policy: 'shared_calling_policies',
  call_queue: 'call_queues',
  auto_attendant: 'auto_attendants',
};

/**
 * Design & Build create routes (POST t/:tenantId/build/<segment>) whose new
 * row is linked to the request named in SR_DESIGN_HEADER. Only these: bulk,
 * populate, templates and so on act on the whole site and never link.
 */
export const SR_BUILD_ROUTE_KIND: Record<string, SrItemKind> = {
  users: 'user',
  caps: 'cap',
  'resource-accounts': 'resource_account',
  'shared-calling-policies': 'shared_calling_policy',
  'call-queues': 'call_queue',
  'auto-attendants': 'auto_attendant',
};

/** Sent by the request's Design tab on Design & Build create calls: "link what this makes to request <id>". */
export const SR_DESIGN_HEADER = 'x-service-request';

/**
 * Request types designed on the Design tab and deployed on the Deploy tab.
 * A new site is made in Data Collection, and new numbers / "other" are
 * handled by hand, so those keep the manual status buttons only.
 */
export function srHasDesign(type: SrType): boolean {
  const kind = SR_BUILD_KIND[type];
  return kind !== null && kind !== 'site';
}

/** A "new phone numbers" request is designed by adding the numbers to the site's inventory (Design tab), and has nothing to deploy. */
export function srHasNumbersDesign(type: SrType): boolean {
  return type === 'new_phone_numbers';
}

/** The Design tab can change rows only while the request is Planned. */
export function srDesignEditable(status: SrStatus): boolean {
  return status === 'planned';
}

/** One row linked to a request, as the Design tab lists it. */
export interface SrItem {
  kind: SrItemKind;
  row_id: string;
  /** UPN or name; null when the row was deleted from Design & Build since. */
  label: string | null;
  site_id: string | null;
  created_at: string;
}

/** GET /service-requests/:id/design */
export interface SrDesignSummary {
  items: SrItem[];
  /** Linked rows that still exist and can be deployed. */
  deployableCount: number;
  /** Why "Mark as designed & built" is not allowed yet; empty when it is. */
  builtBlockers: string[];
}

/** One deployment run started from a request. */
export interface SrDeploymentRun {
  id: string;
  mode: 'dry_run' | 'execute';
  status: string;
  summary: Record<string, number>;
  created_at: string;
  finished_at: string | null;
}

/**
 * Which deployment sheets a set of linked rows needs, in deployment order.
 * Sites aren't deployed, so a request with only a site has none.
 */
export function srItemSheets(kinds: Iterable<SrItemKind>): (typeof DEPLOYMENT_SHEETS)[number][] {
  const order: (typeof DEPLOYMENT_SHEETS)[number][] = ['users', 'caps', 'resource_accounts', 'shared_calling_policies', 'call_queues', 'auto_attendants'];
  const wanted = new Set<string>();
  for (const k of kinds) {
    const sheet = SR_ITEM_SHEET[k];
    if (sheet) wanted.add(sheet);
  }
  return order.filter((s) => wanted.has(s));
}

/**
 * Why a request can't be marked Designed & built yet. Requests without a
 * design (new site, numbers, other) are never blocked here.
 */
export function srBuiltBlockers(
  type: SrType,
  args: { siteId: string | null; deployableCount: number; missingCount: number; rangeCount?: number; otherSiteCount?: number },
): string[] {
  if (srHasNumbersDesign(type)) return (args.rangeCount ?? 0) > 0 ? [] : ['Add the new numbers to the site on the Design tab first.'];
  if (!srHasDesign(type)) return [];
  const out: string[] = [];
  if (!args.siteId) out.push('The request has no site, so there is nothing to design against.');
  if (args.deployableCount === 0) out.push('Design at least one row on the Design tab first.');
  const other = args.otherSiteCount ?? 0;
  if (other > 0) {
    out.push(`${other} linked row${other === 1 ? ' is' : 's are'} on a different site from the request, so ${other === 1 ? 'it' : 'they'} can't be deployed from here. Remove ${other === 1 ? 'it' : 'them'} from the request.`);
  }
  if (args.missingCount > 0) {
    out.push(
      `${args.missingCount} linked row${args.missingCount === 1 ? ' was' : 's were'} deleted from Design & Build. Remove ${args.missingCount === 1 ? 'it' : 'them'} from the request or design ${args.missingCount === 1 ? 'it' : 'them'} again.`,
    );
  }
  return out;
}

/** POST /service-requests/:id/deploy - What-If or Deploy just the request's rows. */
export const serviceRequestDeploySchema = z
  .object({
    connectionId: z.string().uuid(),
    mode: z.enum(['dry_run', 'execute']),
    /** Needed for a live deploy outside the customer's change window; recorded on the request. */
    outsideWindowReason: z.string().trim().min(3).max(1000).optional(),
  })
  .strict();

/** POST /service-requests/:id/approval - the customer's approver decides. */
export const serviceRequestApprovalSchema = z
  .object({
    approve: z.boolean(),
    note: z.string().trim().max(2000).optional(),
  })
  .strict()
  .refine((v) => v.approve || !!v.note, { message: 'Say why it is rejected', path: ['note'] });
export type ServiceRequestApprovalInput = z.infer<typeof serviceRequestApprovalSchema>;

/** POST /service-requests/:id/numbers - add a range to the site's inventory for a "new phone numbers" request. */
export const serviceRequestNumbersSchema = z
  .object({
    range_start: z.string().trim().regex(/^\+?\d{6,15}$/, 'Enter the first number, e.g. +442079460100'),
    range_end: z.string().trim().regex(/^\+?\d{6,15}$/, 'Enter the last number'),
    carrier: z.string().trim().max(160).optional(),
  })
  .strict();
export type ServiceRequestNumbersInput = z.infer<typeof serviceRequestNumbersSchema>;
export type ServiceRequestDeployInput = z.infer<typeof serviceRequestDeploySchema>;

/** What can be attached to a request: pictures, PDF, Office documents, CSV and text. 10 MB each. */
export const SR_ATTACHMENT_TYPES = /^(image\/(png|jpeg|gif|webp)|application\/pdf|text\/(plain|csv)|application\/vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet|presentationml\.presentation)|application\/msword|application\/vnd\.ms-excel)$/;
export const SR_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
