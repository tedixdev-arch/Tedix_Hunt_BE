import { describe, expect, it } from 'vitest';
import { parseRange, participationForSelection, participationViolation, templateParticipation } from './templateParticipation.js';
import { validateHuntForPublish } from './huntReadiness.js';

const snapshot = (configuration: Record<string, unknown>) => ({ configuration });
const team = snapshot({ format: 'Team Hunters', participants: '16–40', teamSize: '3–5' });
const solo = snapshot({ format: 'Single Hunters', participants: '2–10', teamSize: '3–5' });

describe('template participation rules', () => {
  it('parses stored ranges', () => {
    expect(parseRange('16–40')).toEqual({ min: 16, max: 40 });
    expect(parseRange('3-5')).toEqual({ min: 3, max: 5 });
    expect(parseRange('4')).toEqual({ min: 4, max: 4 });
    expect(parseRange(4)).toEqual({ min: 4, max: 4 });
    for (const bad of ['18+', '5–3', '', 'abc', null, '0']) expect(parseRange(bad)).toBeNull();
  });

  it('reads format and ranges; Single Hunters and legacy formats have no team size range', () => {
    expect(templateParticipation(team)).toEqual({ format: 'team', participants: { min: 16, max: 40 }, teamSize: { min: 3, max: 5 } });
    expect(templateParticipation(solo)).toEqual({ format: 'solo', participants: { min: 2, max: 10 }, teamSize: null });
    expect(templateParticipation(snapshot({ format: 'Single and Team Hunters', teamSize: '4' })).format).toBeNull();
    expect(templateParticipation(snapshot({ format: 'Team Hunters', teamSize: '2–12' })).teamSize).toBeNull();
    expect(templateParticipation(null)).toEqual({ format: null, participants: null, teamSize: null });
  });

  it('chooses the format and a valid team size on selection', () => {
    expect(participationForSelection(team, { format: null, teamSize: null })).toEqual({ format: 'team', teamSize: 4 });
    expect(participationForSelection(team, { format: 'team', teamSize: 5 })).toEqual({ format: 'team', teamSize: 5 });
    expect(participationForSelection(snapshot({ format: 'Team Hunters', teamSize: '6–8' }), { format: 'team', teamSize: 4 })).toEqual({ format: 'team', teamSize: 6 });
    expect(participationForSelection(solo, { format: 'team', teamSize: 4 })).toEqual({ format: 'solo', teamSize: null });
    expect(participationForSelection(snapshot({}), { format: 'team', teamSize: 7 })).toEqual({ format: 'team', teamSize: 7 });
    expect(participationForSelection(snapshot({}), { format: null, teamSize: null })).toEqual({ format: 'team', teamSize: 4 });
  });

  it('rejects values outside the template rules', () => {
    expect(participationViolation(team, { teamSize: 6 })).toMatchObject({ error: 'team_size_out_of_template_range', min: 3, max: 5 });
    expect(participationViolation(team, { teamSize: 2 })).toMatchObject({ error: 'team_size_out_of_template_range' });
    expect(participationViolation(team, { capacity: 41 })).toMatchObject({ error: 'capacity_out_of_template_range', min: 16, max: 40 });
    expect(participationViolation(team, { capacity: 15 })).toMatchObject({ error: 'capacity_out_of_template_range' });
    expect(participationViolation(team, { format: 'solo' })).toMatchObject({ error: 'format_fixed_by_template' });
    expect(participationViolation(team, { format: 'team', capacity: 16, teamSize: 3 })).toBeNull();
    expect(participationViolation(snapshot({}), { capacity: 999, teamSize: 9 })).toBeNull();
  });

  it('publish readiness enforces template ranges instead of the fixed team size of 4', () => {
    const base = { name: 'H', country: 'RO', city: 'Cluj', startDate: '2027-01-01', startTime: '10:00:00', timezone: 'Europe/Bucharest',
      durationMinutes: 60, contactName: 'C', templateKey: 'k', templateVersion: 1, accessMode: 'invitation_only', difficulty: 'easy',
      checkpointOrder: 'recommended' } as any;
    const content = { key: 'k', version: 1, displayName: 'T', theme: 'X', checkpoints: [{ checkpoint: 1 }], configuration: team.configuration };
    const messages = (hunt: object) => validateHuntForPublish({ ...base, templateSnapshot: content, ...hunt }).issues.map(i => i.message);
    expect(messages({ format: 'team', teamSize: 5, capacity: 20 })).toEqual([]);
    expect(messages({ format: 'team', teamSize: 6, capacity: 20 })).toEqual(['Team size must be between 3 and 5 for this template']);
    expect(messages({ format: 'team', teamSize: 4, capacity: 50 })).toEqual(['Participants must be between 16 and 40 for this template']);
    expect(messages({ format: 'solo', teamSize: null, capacity: 20 })).toEqual(["Use the template's format: Team Hunters"]);
    const legacy = { ...content, configuration: {} };
    expect(validateHuntForPublish({ ...base, templateSnapshot: legacy, format: 'team', teamSize: 6, capacity: 20 }).issues.map(i => i.field)).toEqual(['teamSize']);
  });
});
