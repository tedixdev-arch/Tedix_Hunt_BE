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
