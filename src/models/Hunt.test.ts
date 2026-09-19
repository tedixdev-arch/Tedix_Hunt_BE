import { beforeEach, describe, expect, it, vi } from 'vitest';

const { query, connect } = vi.hoisted(() => ({ query: vi.fn(), connect: vi.fn() }));
vi.mock('../lib/postgres.js', () => ({ pool: { query, connect } }));

import { Hunt } from './Hunt.js';
import { HuntParticipant } from './HuntParticipant.js';
import { HuntRoles } from './HuntRole.js';
import { Team } from './Team.js';

const createdAt = new Date('2026-09-17T12:00:00Z');

describe('core Hunt persistence', () => {
  beforeEach(() => query.mockReset());

  it('creates a draft and its organizer role in one transaction', async () => {
    const client = { query: vi.fn(), release: vi.fn() };
    const row = {
      id: 'hunt-1', organization_id: 'org-1', created_by_user_id: 'user-1', name: 'City Hunt',
      status: 'draft', created_at: createdAt, updated_at: createdAt,
    };
    connect.mockResolvedValueOnce(client);
    client.query
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({});

    await expect(Hunt.createWithOrganizerRole({
      organizationId: 'org-1', createdByUserId: 'user-1', name: 'City Hunt',
    })).resolves.toMatchObject({ status: 'draft' });
    expect(client.query.mock.calls.map(([sql]) => sql.trim().split(/\s/)[0])).toEqual([
      'BEGIN', 'INSERT', 'INSERT', 'COMMIT',
    ]);
    expect(client.release).toHaveBeenCalled();
  });

  it('rolls back Hunt creation when organizer assignment fails', async () => {
    const client = { query: vi.fn(), release: vi.fn() };
    connect.mockResolvedValueOnce(client);
    client.query
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ id: 'hunt-1' }] })
      .mockRejectedValueOnce(new Error('role failure'))
      .mockResolvedValueOnce({});

    await expect(Hunt.createWithOrganizerRole({
      organizationId: 'org-1', createdByUserId: 'user-1', name: 'City Hunt',
    })).rejects.toThrow('role failure');
    expect(client.query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
  });

  it('updates lifecycle state only when the current status is allowed', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await expect(Hunt.transitionStatus({
      id: 'hunt-1', from: ['published'], to: 'active',
    })).resolves.toBeNull();
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('status = ANY($3::text[])'),
      ['hunt-1', 'active', ['published']],
    );
  });

  it('creates and finds a Hunt', async () => {
    const row = {
      id: 'hunt-1',
      organization_id: 'org-1',
      created_by_user_id: 'user-1',
      name: 'City Hunt',
      status: 'draft',
      created_at: createdAt,
      updated_at: createdAt,
    };
    query.mockResolvedValueOnce({ rows: [row] }).mockResolvedValueOnce({ rows: [row] });

    await expect(Hunt.create({
      organizationId: 'org-1',
      createdByUserId: 'user-1',
      name: 'City Hunt',
    })).resolves.toMatchObject({ id: 'hunt-1', organizationId: 'org-1', status: 'draft' });
    expect(query).toHaveBeenNthCalledWith(1, expect.stringContaining('INSERT INTO hunts'), [
      'org-1', 'user-1', 'City Hunt', 'draft',
    ]);
    await expect(Hunt.findById('hunt-1')).resolves.toMatchObject({ id: 'hunt-1' });
  });

  it('lists each accessible Hunt once with its roles in deterministic order', async () => {
    const older = new Date('2026-09-16T12:00:00Z');
    query.mockResolvedValueOnce({ rows: [{
      id: 'hunt-1',
      organization_id: 'org-1',
      created_by_user_id: 'user-2',
      name: 'Shared Hunt',
      status: 'paused',
      created_at: older,
      updated_at: createdAt,
      hunt_roles: ['organizer', 'supervisor'],
    }] });

    await expect(Hunt.findForUser('user-1')).resolves.toEqual([{
      id: 'hunt-1', organizationId: 'org-1', createdByUserId: 'user-2', name: 'Shared Hunt',
      status: 'paused', createdAt: older, updatedAt: createdAt,
      country: null, region: null, city: null, startDate: null, startTime: null, timezone: null,
      durationMinutes: null, capacity: null, contactName: null,
      templateKey: null, templateVersion: null, templateSnapshot: null,
      format: null, teamSize: null, accessMode: null, difficulty: null, checkpointOrder: null,
      accessCode: null,
      huntRoles: ['organizer', 'supervisor'],
    }]);
    expect(query).toHaveBeenCalledWith(expect.stringMatching(
      /JOIN hunt_roles[\s\S]*WHERE hr\.user_id = \$1[\s\S]*GROUP BY h\.id[\s\S]*ORDER BY h\.updated_at DESC, h\.created_at DESC/,
    ), ['user-1']);
  });

  it('returns an empty Hunt list when the user has no Hunt-specific roles', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await expect(Hunt.findForUser('user-1')).resolves.toEqual([]);
  });

  it('maps General Setup and safely updates only supplied draft fields', async () => {
    const updatedAt = new Date('2026-09-17T13:00:00Z');
    const row = {
      id: 'hunt-1', organization_id: 'org-1', created_by_user_id: 'user-1', name: 'City Hunt',
      status: 'draft', country: 'Romania', region: 'Cluj', city: 'Cluj Napoca',
      start_date: '2026-09-12', start_time: '10:00:00', timezone: 'Europe/Bucharest',
      duration_minutes: 90, capacity: 24, contact_name: 'Ana Pop',
      created_at: createdAt, updated_at: updatedAt,
    };
    query.mockResolvedValueOnce({ rows: [row] });

    await expect(Hunt.updateDraft('hunt-1', { city: 'Cluj Napoca', durationMinutes: 90 }))
      .resolves.toMatchObject({
        city: 'Cluj Napoca', startDate: '2026-09-12', startTime: '10:00:00',
        timezone: 'Europe/Bucharest', durationMinutes: 90, capacity: 24,
        contactName: 'Ana Pop', updatedAt,
      });
    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(/SET city = \$2, duration_minutes = \$3, updated_at = now\(\)[\s\S]*WHERE id = \$1 AND status = 'draft'/),
      ['hunt-1', 'Cluj Napoca', 90],
    );
  });

  it('atomically stores a backend template selection only on a draft', async () => {
    const snapshot = {
      key: 'signal-cluj-napoca', version: 1, displayName: 'Signal: Cluj Napoca',
      theme: 'Smart Theme (Signal)', checkpointNames: ['Matthias Rex Statue'],
    };
    query.mockResolvedValueOnce({ rows: [{
      id: 'hunt-1', organization_id: 'org-1', created_by_user_id: 'user-1', name: 'City Hunt',
      status: 'draft', template_key: snapshot.key, template_version: 1,
      template_snapshot: snapshot, created_at: createdAt, updated_at: createdAt,
    }] });

    await expect(Hunt.updateDraft('hunt-1', {
      templateKey: snapshot.key, templateVersion: snapshot.version, templateSnapshot: snapshot,
    })).resolves.toMatchObject({
      templateKey: snapshot.key, templateVersion: 1, templateSnapshot: snapshot,
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(/template_key = \$2, template_version = \$3, template_snapshot = \$4[\s\S]*status = 'draft'/),
      ['hunt-1', snapshot.key, 1, snapshot],
    );
  });

  it('maps and partially updates supported pilot options only on a draft', async () => {
    query.mockResolvedValueOnce({ rows: [{
      id: 'hunt-1', organization_id: 'org-1', created_by_user_id: 'user-1', name: 'City Hunt',
      status: 'draft', hunt_format: 'team', team_size: 4, access_mode: 'invitation_only',
      difficulty: 'easy', checkpoint_order: 'recommended', created_at: createdAt, updated_at: createdAt,
    }] });

    await expect(Hunt.updateDraft('hunt-1', {
      difficulty: 'easy', checkpointOrder: 'recommended',
    })).resolves.toMatchObject({
      format: 'team', teamSize: 4, accessMode: 'invitation_only', difficulty: 'easy',
      checkpointOrder: 'recommended',
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(/difficulty = \$2, checkpoint_order = \$3[\s\S]*WHERE id = \$1 AND status = 'draft'/),
      ['hunt-1', 'easy', 'recommended'],
    );
  });

  it('maps and finds a Hunt by its access code', async () => {
    query.mockResolvedValueOnce({ rows: [{
      id: 'hunt-1', organization_id: 'org-1', created_by_user_id: 'user-1', name: 'City Hunt',
      status: 'published', access_code: '7KPM4XQ2', created_at: createdAt, updated_at: createdAt,
    }] });
    await expect(Hunt.findByAccessCode('7KPM4XQ2')).resolves.toMatchObject({ accessCode: '7KPM4XQ2' });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('access_code = $1'), ['7KPM4XQ2']);
  });

  it('persists access idempotently and retries database-enforced collisions', async () => {
    const collision = Object.assign(new Error('duplicate'), { code: '23505' });
    const row = {
      id: 'hunt-1', organization_id: 'org-1', created_by_user_id: 'user-1', name: 'City Hunt',
      status: 'published', access_code: 'M8R2HD7W', created_at: createdAt, updated_at: createdAt,
    };
    query.mockRejectedValueOnce(collision).mockResolvedValueOnce({ rows: [row] });
    const codes = ['7KPM4XQ2', 'M8R2HD7W'];
    await expect(Hunt.ensureAccessCode('hunt-1', () => codes.shift()!)).resolves.toMatchObject({
      accessCode: 'M8R2HD7W',
    });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('returns the persisted code when a concurrent request already created it', async () => {
    const row = {
      id: 'hunt-1', organization_id: 'org-1', created_by_user_id: 'user-1', name: 'City Hunt',
      status: 'active', access_code: '7KPM4XQ2', created_at: createdAt, updated_at: createdAt,
    };
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [row] });
    await expect(Hunt.ensureAccessCode('hunt-1', () => 'M8R2HD7W')).resolves.toMatchObject({
      accessCode: '7KPM4XQ2',
    });
  });

  it('bounds access-code collision retries', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      query.mockRejectedValueOnce(Object.assign(new Error('duplicate'), { code: '23505' }));
    }
    await expect(Hunt.ensureAccessCode('hunt-1', () => '7KPM4XQ2', 5))
      .rejects.toThrow('hunt_access_code_generation_failed');
    expect(query).toHaveBeenCalledTimes(5);
  });

  it('enrolls idempotently and finds a Hunt participant', async () => {
    const row = { id: 'participant-1', hunt_id: 'hunt-1', user_id: 'user-2', joined_at: createdAt };
    query.mockResolvedValueOnce({ rows: [row] }).mockResolvedValueOnce({ rows: [row] });

    await expect(HuntParticipant.enroll('hunt-1', 'user-2')).resolves.toMatchObject({
      id: 'participant-1', huntId: 'hunt-1', userId: 'user-2',
    });
    expect(query).toHaveBeenNthCalledWith(1, expect.stringContaining('ON CONFLICT'), [
      'hunt-1', 'user-2',
    ]);
    await expect(HuntParticipant.findByHuntAndUser('hunt-1', 'user-2')).resolves.toMatchObject({
      id: 'participant-1',
    });
  });

  it('creates and finds a team, then adds a same-Hunt participant', async () => {
    const team = { id: 'team-1', hunt_id: 'hunt-1', name: 'Explorers', created_at: createdAt };
    const member = {
      hunt_id: 'hunt-1', team_id: 'team-1', hunt_participant_id: 'participant-1', joined_at: createdAt,
    };
    query
      .mockResolvedValueOnce({ rows: [team] })
      .mockResolvedValueOnce({ rows: [team] })
      .mockResolvedValueOnce({ rows: [member] });

    await expect(Team.create('hunt-1', 'Explorers')).resolves.toMatchObject({ id: 'team-1' });
    await expect(Team.findById('team-1')).resolves.toMatchObject({ huntId: 'hunt-1' });
    await expect(Team.addParticipant('team-1', 'participant-1')).resolves.toMatchObject({
      huntParticipantId: 'participant-1',
    });
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining('JOIN hunt_participants'), [
      'team-1', 'participant-1',
    ]);
  });

  it('assigns and checks Hunt-specific roles without duplicate assignments', async () => {
    query.mockResolvedValueOnce({ rowCount: 1 }).mockResolvedValueOnce({ rowCount: 0 });
    await expect(HuntRoles.assign('hunt-1', 'user-1', 'organizer')).resolves.toBe(true);
    expect(query).toHaveBeenNthCalledWith(1, expect.stringContaining('ON CONFLICT'), [
      'hunt-1', 'user-1', 'organizer',
    ]);
    await expect(HuntRoles.hasRole('hunt-1', 'user-1', 'supervisor')).resolves.toBe(false);
  });

  it('rejects unsupported Hunt roles before querying PostgreSQL', async () => {
    await expect(HuntRoles.assign('hunt-1', 'user-1', 'participant' as never)).rejects.toThrow(
      'invalid_hunt_role',
    );
    expect(query).not.toHaveBeenCalled();
  });
});
