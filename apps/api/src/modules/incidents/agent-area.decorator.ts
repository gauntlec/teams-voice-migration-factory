import { SetMetadata } from '@nestjs/common';
import type { AgentDomain } from '@tvmf/shared';

export const AGENT_AREA = 'agent:area';

/**
 * Which area of the agent API a route belongs to. AgentAuthGuard refuses an assistant that was not set up for it (403 `wrong_area`), so an
 * incident assistant cannot reach the service request routes and the other way round. Put it on a controller; put `'any'` on a route
 * (the events feed, `/me`) that every assistant may use.
 */
export const AgentArea = (area: AgentDomain | 'any') => SetMetadata(AGENT_AREA, area);
