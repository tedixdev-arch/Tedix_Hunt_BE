import type { HuntStatus } from '../models/Hunt.js';

export type HuntLifecycleAction = 'publish' | 'start' | 'pause' | 'resume' | 'cancel' | 'finish';

/** Single source of Hunt lifecycle transitions, shared by Organizer actions and Admin overrides. */
export const lifecycleActions: Record<HuntLifecycleAction, { from: readonly HuntStatus[]; to: HuntStatus }> = {
  publish: { from: ['draft'], to: 'published' },
  start: { from: ['published'], to: 'active' },
  pause: { from: ['active'], to: 'paused' },
  resume: { from: ['paused'], to: 'active' },
  cancel: { from: ['draft', 'published', 'active', 'paused'], to: 'cancelled' },
  finish: { from: ['active', 'paused'], to: 'finished' },
};

export const isLifecycleAction = (value: unknown): value is HuntLifecycleAction =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(lifecycleActions, value);

/** Actions allowed from a status, in display order. */
export const actionsFrom = (status: HuntStatus): HuntLifecycleAction[] =>
  (Object.keys(lifecycleActions) as HuntLifecycleAction[]).filter(action => lifecycleActions[action].from.includes(status));

export const lifecyclePastTense: Record<HuntLifecycleAction, string> = {
  publish: 'published', start: 'started', pause: 'paused', resume: 'resumed', cancel: 'cancelled', finish: 'finished',
};
