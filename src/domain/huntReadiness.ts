import type { IHunt } from '../models/Hunt.js';

export interface HuntReadinessIssue {
  field: string;
  section: 'general' | 'template' | 'options';
  message: string;
}

export interface HuntReadinessResult {
  ready: boolean;
  issues: HuntReadinessIssue[];
}

export function validateHuntForPublish(hunt: IHunt): HuntReadinessResult {
  const issues: HuntReadinessIssue[] = [];
  const messages = new Set<string>();
  const add = (issue: HuntReadinessIssue) => {
    // A section can have several invalid persisted values but only needs one user action.
    if (!messages.has(issue.message)) {
      messages.add(issue.message);
      issues.push(issue);
    }
  };
  const hasText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

  if (!hasText(hunt.name)) add({ section: 'general', field: 'name', message: 'Add a Hunt name' });
  if (!hasText(hunt.country)) add({ section: 'general', field: 'country', message: 'Add a country' });
  if (!hasText(hunt.city)) add({ section: 'general', field: 'city', message: 'Add a city' });
  if (!hasText(hunt.startDate)) add({ section: 'general', field: 'startDate', message: 'Add a Hunt date' });
  if (!hasText(hunt.startTime)) add({ section: 'general', field: 'startTime', message: 'Add a start time' });
  if (!hasText(hunt.timezone)) add({ section: 'general', field: 'timezone', message: 'Add a timezone' });
  if (!Number.isInteger(hunt.durationMinutes) || (hunt.durationMinutes ?? 0) < 1) {
    add({ section: 'general', field: 'durationMinutes', message: 'Add a valid duration' });
  }
  if (!Number.isInteger(hunt.capacity) || (hunt.capacity ?? 0) < 1) {
    add({ section: 'general', field: 'capacity', message: 'Add a valid capacity' });
  }
  if (!hasText(hunt.contactName)) add({ section: 'general', field: 'contactName', message: 'Add a local contact' });

  const snapshot = hunt.templateSnapshot;
  const usableSnapshot = snapshot !== null && typeof snapshot === 'object'
    && hasText(snapshot.key) && Number.isInteger(snapshot.version) && snapshot.version >= 1
    && hasText(snapshot.displayName) && hasText(snapshot.theme)
    && Array.isArray(snapshot.checkpointNames) && snapshot.checkpointNames.length > 0;
  if (!hasText(hunt.templateKey)) {
    add({ section: 'template', field: 'templateKey', message: 'Select a Hunt template' });
  }
  if (!Number.isInteger(hunt.templateVersion) || (hunt.templateVersion ?? 0) < 1) {
    add({ section: 'template', field: 'templateVersion', message: 'Select a Hunt template' });
  }
  if (!usableSnapshot || hunt.templateKey !== snapshot?.key || hunt.templateVersion !== snapshot?.version) {
    add({ section: 'template', field: 'templateSnapshot', message: 'Select a Hunt template' });
  }

  if (hunt.format !== 'team' || hunt.teamSize !== 4 || hunt.accessMode !== 'invitation_only') {
    const field = hunt.format !== 'team' ? 'format' : hunt.teamSize !== 4 ? 'teamSize' : 'accessMode';
    add({ section: 'options', field, message: 'Save Participants & access' });
  }
  if (hunt.difficulty !== 'easy' || hunt.checkpointOrder !== 'recommended') {
    const field = hunt.difficulty !== 'easy' ? 'difficulty' : 'checkpointOrder';
    add({ section: 'options', field, message: 'Save Experience defaults' });
  }

  return { ready: issues.length === 0, issues };
}
