import { describe, expect, it } from 'vitest';
import { numberReleasedInTeams } from './number-cooloff';

describe('numberReleasedInTeams', () => {
  it('is true only for assigned -> unassigned', () => {
    expect(numberReleasedInTeams({ PstnAssignmentStatus: 'UserAssigned' }, { PstnAssignmentStatus: 'Unassigned' })).toBe(true);
    expect(numberReleasedInTeams({ PstnAssignmentStatus: 'VoiceApplicationAssigned' }, { PstnAssignmentStatus: 'unassigned' })).toBe(true);
    expect(numberReleasedInTeams({ PstnAssignmentStatus: 'Unassigned' }, { PstnAssignmentStatus: 'Unassigned' })).toBe(false);
    expect(numberReleasedInTeams(null, { PstnAssignmentStatus: 'Unassigned' })).toBe(false);
    expect(numberReleasedInTeams({ PstnAssignmentStatus: 'UserAssigned' }, { PstnAssignmentStatus: 'UserAssigned' })).toBe(false);
  });
});
