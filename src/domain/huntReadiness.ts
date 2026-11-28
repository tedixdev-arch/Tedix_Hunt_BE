import { validParticipationConfiguration } from './huntOptions.js';
import { inRange, templateParticipation } from './templateParticipation.js';
import { hasCustomExercises, validateCustomExercises } from './customExercises.js';
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
  // Custom and Library exercises are played by participant gameplay (docs/Custom_Exercise_Gameplay.md);
  // the snapshot must still satisfy the exercise schemas it was approved under.
  if (hasCustomExercises(snapshot) && validateCustomExercises(snapshot).length) add({ section: 'template', field: 'templateSnapshot',
    message: 'This Hunt template has exercises that are no longer valid; ask the Creator to fix and resubmit the template' });
  const usableSnapshot = snapshot !== null && typeof snapshot === 'object'
    && hasText(snapshot.key) && Number.isInteger(snapshot.version) && (snapshot.version as number) >= 1
    && hasText(snapshot.displayName) && hasText(snapshot.theme)
    && Array.isArray(snapshot.checkpoints) && snapshot.checkpoints.length > 0;
  if (!hasText(hunt.templateKey)) {
    add({ section: 'template', field: 'templateKey', message: 'Select a Hunt template' });
  }
  if (!Number.isInteger(hunt.templateVersion) || (hunt.templateVersion ?? 0) < 1) {
    add({ section: 'template', field: 'templateVersion', message: 'Select a Hunt template' });
  }
  if (!usableSnapshot || hunt.templateKey !== snapshot?.key || hunt.templateVersion !== snapshot?.version) {
    add({ section: 'template', field: 'templateSnapshot', message: 'Select a Hunt template' });
  }

  if (!validParticipationConfiguration(hunt.format, hunt.teamSize) || hunt.accessMode !== 'invitation_only') {
    const field = hunt.format !== 'team' && hunt.format !== 'solo' ? 'format' : !validParticipationConfiguration(hunt.format, hunt.teamSize) ? 'teamSize' : 'accessMode';
    add({ section: 'options', field, message: 'Save Participants & access' });
  }
  // Pilot Solo gameplay plays every Personal and Team stage for each participant, so Solo discards no required
  // content. The Template's participation rules (format, participant and team size ranges) bind the Hunt; Templates
  // without a team size range keep the historical pilot size of 4 (variable sizes need D2/D5 approval).
  const rules = templateParticipation(snapshot);
  if (rules.format && hunt.format && hunt.format !== rules.format) {
    add({ section: 'options', field: 'format', message: `Use the template's format: ${rules.format === 'solo' ? 'Single Hunters' : 'Team Hunters'}` });
  }
  if (rules.participants && Number.isInteger(hunt.capacity) && !inRange(hunt.capacity as number, rules.participants)) {
    add({ section: 'general', field: 'capacity', message: `Participants must be between ${rules.participants.min} and ${rules.participants.max} for this template` });
  }
  if (hunt.format === 'team' && hunt.teamSize !== null) {
    if (rules.teamSize) {
      if (!inRange(hunt.teamSize, rules.teamSize)) add({ section: 'options', field: 'teamSize',
        message: `Team size must be between ${rules.teamSize.min} and ${rules.teamSize.max} for this template` });
    } else if (hunt.teamSize !== 4) {
      add({ section: 'options', field: 'teamSize',
        message: 'Variable Team-size gameplay readiness requires approved membership and content compatibility (D2/D5)' });
    }
  }
  if (hunt.difficulty !== 'easy' || hunt.checkpointOrder !== 'recommended') {
    const field = hunt.difficulty !== 'easy' ? 'difficulty' : 'checkpointOrder';
    add({ section: 'options', field, message: 'Save Experience defaults' });
  }

  return { ready: issues.length === 0, issues };
}
