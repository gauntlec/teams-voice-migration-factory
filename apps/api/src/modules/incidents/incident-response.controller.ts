import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { incidentResponseSchema, type IncidentResponseInput } from '@tvmf/shared';
import { Public } from '../../auth/auth.decorators';
import { ZodBody } from '../../common/zod.pipe';
import { IncidentResponseService } from './incident-response.service';

/**
 * The "Is it fixed?" answer page's two calls. Unauthenticated by design - the
 * signed link in the email is the credential (see incident-links.ts) - and so
 * tightly scoped: it can only read one incident's title and status, or say
 * "fixed" / "still broken" on it.
 */
@Controller('public/incident-response')
export class IncidentResponseController {
  constructor(private readonly svc: IncidentResponseService) {}

  @Get()
  @Public()
  preview(@Query('t') token: string) {
    return this.svc.preview(String(token ?? ''));
  }

  @Post()
  @Public()
  respond(@Body(new ZodBody(incidentResponseSchema)) body: IncidentResponseInput) {
    return this.svc.respond(body);
  }
}
