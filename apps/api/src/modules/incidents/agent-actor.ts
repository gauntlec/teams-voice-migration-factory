import { AGENT_CUSTOMER_LABEL, agentLabel } from '@tvmf/shared';
import type { AuthedUser } from '../../common/request';

/**
 * An AI agent as the "user" the incident services act for. It has the engineer's reach inside
 * the services (the autonomy checks live in the agent API, before it gets here), but its events
 * are attributed to the agent, it is labelled "(AI)" everywhere, and it can never be emailed
 * or sign in: the id is the agent's id, the "email" a label.
 */
export function agentActor(agent: { id: string; name: string }): AuthedUser {
  return {
    id: agent.id,
    email: `agent:${agent.name}`,
    displayName: agentLabel(agent.name),
    role: 'ENGINEER',
    totpEnrolled: true,
    enrolOnly: false,
    pwresetOnly: false,
    agent: { id: agent.id, name: agent.name },
  };
}

/** The author columns for an incident event. */
export function actorCols(user: AuthedUser): { author_id: string; actor_type: 'user' | 'agent' } {
  return { author_id: user.id, actor_type: user.agent ? 'agent' : 'user' };
}

/** What to call someone in front of a customer: an agent is always just "Voxshift assistant". */
export function customerFacingName(user: AuthedUser): string {
  return user.agent ? AGENT_CUSTOMER_LABEL : user.displayName;
}
