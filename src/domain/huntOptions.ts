export const huntOptions = {
  formats: [{ key: 'solo', label: 'Single Hunters' }, { key: 'team', label: 'Team Hunters' }],
  // The Template's team size range decides which of these a Hunt may use; 4 remains the default.
  teamSizes: [2, 3, 4, 5, 6, 7, 8, 9, 10],
  accessModes: [{ key: 'invitation_only', label: 'Invitation-only' }],
  difficulties: [{ key: 'easy', label: 'Easy' }],
  checkpointOrders: [{ key: 'recommended', label: 'Recommended route' }],
} as const;

// Remaining experience/access options retain their existing pilot restrictions.
// teamSizes above are the sizes any Template may allow; the Hunt's Template range is enforced on save and publish.
export const supportedHuntOptionValues = {
  accessMode: 'invitation_only',
  difficulty: 'easy',
  checkpointOrder: 'recommended',
} as const;

// PostgreSQL INTEGER representation, not Product Owner size/readiness policy.
export const validTeamSize = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 2147483647;

export const validParticipationConfiguration = (format: unknown, teamSize: unknown): boolean =>
  format === 'solo' ? teamSize === null : format === 'team' && validTeamSize(teamSize);
