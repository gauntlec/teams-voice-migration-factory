import type { AuthedUser } from '../../common/request';

/**
 * A monitoring alert source as the "user" the incident services act for. Like an assistant it has no account or email; unlike
 * one it is not an AI: its events are "system" events, named for the source, and it never gets a lease or an autonomy level.
 */
export function intakeActor(source: { id: string; name: string }): AuthedUser {
  return {
    id: source.id,
    email: `intake:${source.name}`,
    displayName: `${source.name} (monitoring)`,
    role: 'ENGINEER',
    totpEnrolled: true,
    enrolOnly: false,
    pwresetOnly: false,
    system: { id: source.id, name: source.name },
  };
}
