export const huntOptions = {
  formats: [{ key: 'team', label: 'Team Hunters' }],
  teamSizes: [4],
  accessModes: [{ key: 'invitation_only', label: 'Invitation-only' }],
  difficulties: [{ key: 'easy', label: 'Easy' }],
  checkpointOrders: [{ key: 'recommended', label: 'Recommended route' }],
} as const;

// Only these pilot values have runtime support. Prototype alternatives stay unavailable until
// their runtime behavior exists, so the API validation intentionally rejects them.
export const supportedHuntOptionValues = {
  format: 'team',
  teamSize: 4,
  accessMode: 'invitation_only',
  difficulty: 'easy',
  checkpointOrder: 'recommended',
} as const;
