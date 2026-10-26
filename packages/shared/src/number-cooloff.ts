/** A Get-CsPhoneNumberAssignment record that went from assigned to unassigned between two Discovery syncs: released in Teams. */
export function numberReleasedInTeams(before: Record<string, unknown> | null | undefined, after: Record<string, unknown>): boolean {
  const status = (r: Record<string, unknown> | null | undefined) => (typeof r?.PstnAssignmentStatus === 'string' ? r.PstnAssignmentStatus : '');
  return !!before && status(before) !== '' && !/^unassigned$/i.test(status(before)) && /^unassigned$/i.test(status(after));
}

/** The message when a number cannot be assigned yet. */
export function coolingMessage(until: string): string {
  return `That number was released in Teams and is cooling off until ${until.slice(0, 10)}, so its new holder does not get the previous holder's calls. End the cool-off on the site's Numbers tab if it must be reused now.`;
}
