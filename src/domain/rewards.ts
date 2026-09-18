export const rewardProviders = [
  { key: 'organizer', label: 'Organizer' },
  { key: 'tedix_inventory', label: 'Tedix inventory' },
] as const;

export const rewardKinds = [
  { key: 'physical', label: 'Physical' },
  { key: 'virtual', label: 'Virtual' },
] as const;

export const virtualRewardCategories = [
  { key: 'achievement', label: 'Achievement' },
  { key: 'digital_certificate', label: 'Digital certificate' },
  { key: 'profile_badge', label: 'Profile badge' },
  { key: 'hunt_passport_collectible', label: 'Hunt Passport collectible' },
  { key: 'partner_digital_benefit', label: 'Partner digital benefit' },
] as const;

export const specialAwardDefinitions = [
  {
    key: 'team-precision', scope: 'team', name: 'Precision Award',
    rule: 'Highest percentage of correct answers',
    description: 'Recognizes the team with the strongest answer accuracy.',
    eligibility: 'Teams that complete the Hunt',
  },
  {
    key: 'team-speed', scope: 'team', name: 'Speed Award',
    rule: 'Fastest completion time',
    description: 'Recognizes the team that completes the Hunt fastest.',
    eligibility: 'Teams that complete the Hunt',
  },
  {
    key: 'team-collaboration', scope: 'team', name: 'Collaboration Award',
    rule: 'Highest team collaboration score',
    description: 'Recognizes outstanding teamwork across the Hunt.',
    eligibility: 'Teams with recorded collaboration activity',
  },
  {
    key: 'personal-precision', scope: 'personal', name: 'Personal Precision Award',
    rule: 'Highest individual percentage of correct answers',
    description: 'Recognizes the participant with the strongest answer accuracy.',
    eligibility: 'Participants who complete the Hunt',
  },
  {
    key: 'personal-explorer', scope: 'personal', name: 'Explorer Award',
    rule: 'Most checkpoints completed',
    description: 'Recognizes the participant who completes the most checkpoints.',
    eligibility: 'Participants with recorded checkpoint activity',
  },
] as const;

export type RewardProvider = typeof rewardProviders[number]['key'];
export type RewardKind = typeof rewardKinds[number]['key'];
export type VirtualRewardCategory = typeof virtualRewardCategories[number]['key'];

export const rewardOptions = {
  providers: rewardProviders,
  kinds: rewardKinds,
  virtualCategories: virtualRewardCategories,
  specialAwardDefinitions,
};

export const isRewardProvider = (value: unknown): value is RewardProvider =>
  rewardProviders.some(({ key }) => key === value);
export const isRewardKind = (value: unknown): value is RewardKind =>
  rewardKinds.some(({ key }) => key === value);
export const isVirtualRewardCategory = (value: unknown): value is VirtualRewardCategory =>
  virtualRewardCategories.some(({ key }) => key === value);
export const isSpecialAwardDefinition = (value: unknown): value is typeof specialAwardDefinitions[number]['key'] =>
  specialAwardDefinitions.some(({ key }) => key === value);
