import { describe, expect, it } from 'vitest';
import type { IHunt } from '../models/Hunt.js';
import { validateHuntForPublish } from './huntReadiness.js';

const completeHunt: IHunt = {
  id: 'hunt-1', organizationId: 'org-1', createdByUserId: 'user-1', name: 'City Hunt', status: 'draft',
  country: 'Romania', region: null, city: 'Cluj Napoca', startDate: '2026-09-12',
  startTime: '10:00:00', timezone: 'Europe/Bucharest', durationMinutes: 90, capacity: 24,
  contactName: 'Ana Pop', templateKey: 'signal-cluj-napoca', templateVersion: 1,
  templateSnapshot: {
    key: 'signal-cluj-napoca', version: 1, displayName: 'Signal: Cluj Napoca',
    theme: 'Smart Theme (Signal)', checkpointNames: ['Matthias Rex Statue'],
  },
  format: 'team', teamSize: 4, accessMode: 'invitation_only', difficulty: 'easy',
  checkpointOrder: 'recommended', accessCode: null, createdAt: new Date(), updatedAt: new Date(),
};

describe('validateHuntForPublish', () => {
  it('accepts complete persisted D1-D3 configuration without a region or rewards', () => {
    expect(validateHuntForPublish(completeHunt)).toEqual({ ready: true, issues: [] });
  });

  it.each([
    ['name', '', 'Add a Hunt name'], ['country', null, 'Add a country'], ['city', '', 'Add a city'],
    ['startDate', null, 'Add a Hunt date'], ['startTime', null, 'Add a start time'],
    ['timezone', '', 'Add a timezone'], ['durationMinutes', 0, 'Add a valid duration'],
    ['capacity', null, 'Add a valid capacity'], ['contactName', '', 'Add a local contact'],
  ] as const)('rejects invalid General Setup %s', (field, value, message) => {
    const result = validateHuntForPublish({ ...completeHunt, [field]: value });
    expect(result).toMatchObject({ ready: false, issues: [{ section: 'general', field, message }] });
  });

  it.each([
    ['templateKey', null], ['templateVersion', null], ['templateSnapshot', null],
  ] as const)('rejects missing template data %s', (field, value) => {
    const result = validateHuntForPublish({ ...completeHunt, [field]: value });
    expect(result.ready).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ section: 'template' }));
  });

  it.each([
    ['empty checkpoints', { ...completeHunt.templateSnapshot!, checkpointNames: [] }],
    ['key mismatch', { ...completeHunt.templateSnapshot!, key: 'other' }],
    ['version mismatch', { ...completeHunt.templateSnapshot!, version: 2 }],
    ['missing display name', { ...completeHunt.templateSnapshot!, displayName: '' }],
    ['missing theme', { ...completeHunt.templateSnapshot!, theme: '' }],
  ])('rejects a snapshot with %s', (_description, templateSnapshot) => {
    expect(validateHuntForPublish({ ...completeHunt, templateSnapshot }).ready).toBe(false);
  });

  it.each([
    ['format', null], ['teamSize', 3], ['accessMode', null],
    ['difficulty', null], ['checkpointOrder', null],
  ] as const)('rejects a missing or unsupported pilot option %s', (field, value) => {
    const result = validateHuntForPublish({ ...completeHunt, [field]: value } as IHunt);
    expect(result.ready).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ section: 'options', field }));
  });

  it('deduplicates higher-level option guidance', () => {
    const result = validateHuntForPublish({
      ...completeHunt, format: null, teamSize: null, accessMode: null,
      difficulty: null, checkpointOrder: null,
    });
    expect(result.issues).toEqual([
      { section: 'options', field: 'format', message: 'Save Participants & access' },
      { section: 'options', field: 'difficulty', message: 'Save Experience defaults' },
    ]);
  });
});
