import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { ZodBody } from './zod.pipe';

describe('ZodBody', () => {
  const schema = z.object({ note: z.string().optional() }).strict();

  it('parses a valid body', () => {
    expect(new ZodBody(schema).transform({ note: 'hi' })).toEqual({ note: 'hi' });
  });

  it('treats a missing body (Express 5 leaves req.body undefined) as an empty object', () => {
    expect(new ZodBody(schema).transform(undefined)).toEqual({});
  });

  it('still rejects a missing body when a field is required', () => {
    expect(() => new ZodBody(z.object({ id: z.string() })).transform(undefined)).toThrow(BadRequestException);
  });
});
