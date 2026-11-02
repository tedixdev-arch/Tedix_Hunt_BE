export const huntOptions = {
  formats: [{ key: 'solo', label: 'Solo' }, { key: 'team', label: 'Team Hunters' }],
  teamSizes: [4],
  accessModes: [{ key: 'invitation_only', label: 'Invitation-only' }],
  difficulties: [{ key: 'easy', label: 'Easy' }],
  checkpointOrders: [{ key: 'recommended', label: 'Recommended route' }],
} as const;

// Remaining experience/access options retain their existing pilot restrictions.
// teamSizes above advertises the historical pilot, not a variable-size policy.
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
