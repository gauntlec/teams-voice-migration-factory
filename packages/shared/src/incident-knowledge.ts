/**
 * Knowledge from resolved incidents (docs/INTAKE.md): what an engineer learned fixing something, kept so the next person (or
 * assistant) starts with it, and a plain tip a customer can try before raising the same thing. Matching is by category, sub-category and
 * the words of the incident, scored here; feedback ("this helped") sharpens it.
 */
import { z } from 'zod';
import { INC_CATEGORY_KEYS } from './incidents';

export interface KnowledgeSnippet {
  id: string;
  title: string;
  category: string;
  subcategory: string | null;
  symptoms: string;
  fix: string;
  /** What a customer is told. Empty = not shown to customers. */
  customer_text: string;
  helpful: number;
  not_helpful: number;
}

export const knowledgeCreateSchema = z
  .object({
    title: z.string().trim().min(3).max(160),
    category: z.enum(INC_CATEGORY_KEYS),
    subcategory: z.string().trim().max(60).nullable().optional(),
    symptoms: z.string().trim().max(4000).default(''),
    fix: z.string().trim().min(3, 'Say what fixed it').max(6000),
    /** A tip a customer can try. Written for them: no internal names, nothing about causes inside the platform. */
    customerText: z.string().trim().max(1500).default(''),
    sourceIncidentId: z.guid().nullable().optional(),
  })
  .strict();
export type KnowledgeCreateInput = z.infer<typeof knowledgeCreateSchema>;

export const knowledgeUpdateSchema = z
  .object({
    title: z.string().trim().min(3).max(160).optional(),
    category: z.enum(INC_CATEGORY_KEYS).optional(),
    subcategory: z.string().trim().max(60).nullable().optional(),
    symptoms: z.string().trim().max(4000).optional(),
    fix: z.string().trim().min(3).max(6000).optional(),
    customerText: z.string().trim().max(1500).optional(),
  })
  .strict();
export type KnowledgeUpdateInput = z.infer<typeof knowledgeUpdateSchema>;

export const knowledgeFeedbackSchema = z.object({ helpful: z.boolean() }).strict();

export const knowledgeMatchQuerySchema = z
  .object({ category: z.enum(INC_CATEGORY_KEYS), subcategory: z.string().trim().max(60).optional(), q: z.string().trim().max(2000).optional() })
  .strict();

const STOP = new Set('about after again against also another because been before being between both cannot could does doing done down during each from have having here into just like more most much only other over same should some such than that their them then there these they this those through under until very want were what when where which while will with would your calls call phone phones users user'.split(' '));

/** The meaningful words of a text: lower case, 4+ letters, no common words. */
export function knowledgeTokens(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z][a-z0-9+]{3,}/g) ?? []).filter((w) => !STOP.has(w)));
}

export const KNOWLEDGE_MIN_SCORE = 3;

/** How well a snippet fits an incident: the same category and sub-category, shared words, and what people said about it. */
export function knowledgeScore(s: KnowledgeSnippet, q: { category: string; subcategory?: string | null; text?: string }): number {
  let score = 0;
  if (s.category === q.category) score += 3;
  if (s.subcategory && q.subcategory && s.subcategory === q.subcategory) score += 3;
  const mine = knowledgeTokens(`${s.title} ${s.symptoms}`);
  let shared = 0;
  for (const w of knowledgeTokens(q.text ?? '')) if (mine.has(w)) shared++;
  score += Math.min(6, shared);
  if (s.helpful > s.not_helpful) score += 0.5;
  // Something people keep saying does not help sinks.
  if (s.not_helpful >= 3 && s.not_helpful > s.helpful * 2) score -= 4;
  return score;
}

/** The best matches, best first. A snippet from another category needs to share real words to appear. */
export function knowledgeMatches<T extends KnowledgeSnippet>(snippets: T[], q: { category: string; subcategory?: string | null; text?: string }, limit = 3): T[] {
  return snippets
    .map((s) => ({ s, score: knowledgeScore(s, q) }))
    .filter((x) => x.score >= KNOWLEDGE_MIN_SCORE)
    .sort((a, b) => b.score - a.score || b.s.helpful - a.s.helpful)
    .slice(0, limit)
    .map((x) => x.s);
}
