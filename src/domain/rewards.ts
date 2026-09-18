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
    key: 'team-precision', scope: 'team', name: 'Team Precision',
    rule: 'Highest correct team answers ÷ submitted team answers.',
    description: 'Recognizes accurate collective decisions across the Hunt.',
    eligibility: 'Complete at least 70% of team challenges.',
  },
  {
    key: 'everyone-contributed', scope: 'team', name: 'Everyone Contributed',
    rule: 'Highest percentage of team stages where every active member contributed.',
    description: 'Recognizes balanced participation, not one dominant player.',
    eligibility: 'At least three completed team stages.',
  },
  {
    key: 'strong-comeback', scope: 'team', name: 'Strong Comeback',
    rule: 'Most challenges solved after an incorrect attempt without revealing the solution.',
    description: 'Recognizes constructive recovery when the first approach fails.',
    eligibility: 'Complete the Hunt without abandoning a team stage.',
  },
  {
    key: 'consistent-team', scope: 'team', name: 'Consistent Team',
    rule: 'Highest percentage of checkpoints with no skipped personal or team contribution.',
    description: 'Recognizes reliable participation throughout the whole Hunt.',
    eligibility: 'Complete at least 70% of checkpoints.',
  },
  {
    key: 'personal-precision', scope: 'personal', name: 'Personal Precision',
    rule: 'Highest correct first attempts ÷ personal challenges attempted.',
    description: 'Recognizes careful and accurate individual problem solving.',
    eligibility: 'Complete at least 70% of assigned personal challenges.',
  },
  {
    key: 'persistent-solver', scope: 'personal', name: 'Persistent Solver',
    rule: 'Most personal challenges solved after a wrong attempt without revealing the solution.',
    description: 'Recognizes persistence and learning from an unsuccessful attempt.',
    eligibility: 'Complete at least three personal challenges.',
  },
  {
    key: 'smart-help', scope: 'personal', name: 'Smart Help Use',
    rule: 'Most challenges solved after a hint without revealing the solution.',
    description: 'Recognizes effective use of help while preserving ownership of the answer.',
    eligibility: 'At least one hint-assisted correct solution.',
  },
  {
    key: 'reliable-contributor', scope: 'personal', name: 'Reliable Contributor',
    rule: 'Highest percentage of assigned challenges completed and contributions submitted.',
    description: 'Recognizes dependable participation at every team stage.',
    eligibility: 'Complete at least 70% of assigned personal challenges.',
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
