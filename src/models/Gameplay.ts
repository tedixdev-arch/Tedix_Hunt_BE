import type { PoolClient } from 'pg';
import { pool } from '../lib/postgres.js';
import { fail } from '../domain/participantAccess.js';
import {
  checkPersonalAnswer, checkTeamAnswer, checkpointEntry, hasTeamStage, missionDto, navigationDto, personalChallengeDto,
  personalRevealDto, playableEntry, scoringPolicy, teamChallengeDto, teamRevealDto, GAMEPLAY_POLICY_REVISION,
} from '../domain/gameplay.js';
import { ParticipantAccess, type ParticipantHuntContext } from './ParticipantAccess.js';
import { publicSettings, setting } from '../domain/platformSettings.js';

interface ProgressRow {
  checkpoint_id: string; personal_attempts: number; team_attempts: number;
  personal_solved_at: Date | null; team_solved_at: Date | null; completed_at: Date | null;
}

const progressFor = async (client: PoolClient, participantId: string) => {
  const { rows } = await client.query<ProgressRow>('SELECT * FROM participant_checkpoint_progress WHERE participant_id=$1', [participantId]);
  return new Map(rows.map(row => [row.checkpoint_id, row]));
};

const scoreFor = async (client: Pick<PoolClient, 'query'>, participantId: string) => {
  const { rows } = await client.query('SELECT COALESCE(sum(points),0)::int AS total FROM participant_score_events WHERE participant_id=$1', [participantId]);
  return rows[0].total as number;
};

const award = (client: PoolClient, huntId: string, participantId: string, checkpointId: string | null,
  category: string, points: number, eventKey: string) => points === 0 ? Promise.resolve() : client.query(
  `INSERT INTO participant_score_events(hunt_id,participant_id,checkpoint_id,category,points,event_key)
   VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(participant_id,event_key) DO NOTHING`,
  [huntId, participantId, checkpointId, category, points, eventKey]);

const displayName = (row: { name: string | null; email: string | null; is_guest: boolean }, index: number) =>
  row.name?.trim() || (row.email ? row.email.split('@')[0] : `${row.is_guest ? 'Guest' : 'Player'} ${index + 1}`);

/** Ranking: score descending, then earliest finish, then earliest join. Shared by Participants and Organizers. */
const leaderboardRows = async (client: Pick<PoolClient, 'query'>, huntId: string) => {
  const { rows: hunts } = await client.query('SELECT template_snapshot FROM hunts WHERE id=$1', [huntId]);
  const starting = scoringPolicy(hunts[0]?.template_snapshot).startingScore;
  const { rows } = await client.query(`SELECT hp.id, hp.joined_at, hp.started_at, hp.finished_at, hp.last_activity_at,
      u.name, u.email, u.is_guest,
      COALESCE((SELECT sum(points) FROM participant_score_events e WHERE e.participant_id=hp.id),0)::int AS points,
      (SELECT count(*) FROM participant_checkpoint_progress p WHERE p.participant_id=hp.id AND p.completed_at IS NOT NULL)::int AS completed,
      (SELECT count(*) FROM hunt_checkpoint_identities c WHERE c.hunt_id=hp.hunt_id)::int AS total
    FROM hunt_participants hp JOIN users u ON u.id=hp.user_id WHERE hp.hunt_id=$1 ORDER BY hp.joined_at`, [huntId]);
  const named = rows.map((row, index) => ({ ...row, displayName: displayName(row, index), score: starting + row.points }));
  named.sort((a, b) => b.score - a.score
    || (a.finished_at && b.finished_at ? a.finished_at - b.finished_at : a.finished_at ? -1 : b.finished_at ? 1 : 0)
    || a.joined_at - b.joined_at);
  return named.map((row, index) => ({ ...row, rank: index + 1 }));
};

function currentCheckpoint(context: ParticipantHuntContext) {
  return context.checkpoints.find(c => !c.gameplayCompleted) ?? null;
}

async function buildState(context: ParticipantHuntContext, points: Map<string, any>, client: PoolClient,
  scope: { hunt: Record<string, any>; participant: Record<string, any>; execution: Record<string, any> }) {
  const progress = await progressFor(client, scope.participant.id);
  const policy = scoringPolicy(scope.execution);
  const current = currentCheckpoint(context);
  const ordinalOf = (id: string) => context.checkpoints.findIndex(c => c.checkpointId === id) + 1;
  let stage: 'navigate' | 'personal' | 'team' | 'finished' | 'waiting' = 'finished';
  let detail: Record<string, unknown> | null = null;
  if (current) {
    const ordinal = ordinalOf(current.checkpointId);
    const entry = checkpointEntry(scope.execution, ordinal);
    const row = progress.get(current.checkpointId);
    if (context.huntStatus !== 'active') stage = 'waiting';
    else if (current.accessState !== 'proximity_verified') stage = 'navigate';
    else if (!row?.personal_solved_at) stage = 'personal';
    else stage = 'team';
    detail = {
      checkpointId: current.checkpointId, ordinal, kind: current.kind,
      navigation: navigationDto(scope.execution, ordinal, points.get(current.checkpointId)?.point ?? null),
      ...(stage === 'personal' || stage === 'team') && playableEntry(entry) ? {
        story: personalChallengeDto(entry),
        personalAttempts: row?.personal_attempts ?? 0,
        ...(stage === 'team' ? { personalReveal: personalRevealDto(entry), team: teamChallengeDto(entry), teamAttempts: row?.team_attempts ?? 0 } : {}),
      } : {},
      playable: playableEntry(entry),
    };
  }
  const history = context.checkpoints.filter(c => c.gameplayCompleted).map(c => {
    const entry = checkpointEntry(scope.execution, ordinalOf(c.checkpointId)) ?? {};
    return { checkpointId: c.checkpointId, ordinal: ordinalOf(c.checkpointId), kind: c.kind,
      location: typeof entry.location === 'string' ? entry.location : null,
      storyObjective: typeof entry.storyObjective === 'string' ? entry.storyObjective : null,
      ...(hasTeamStage(entry) ? teamRevealDto(entry) : { storySuccess: typeof entry.successText === 'string' ? entry.successText : null }),
      completedAt: progress.get(c.checkpointId)?.completed_at ?? null };
  });
  return {
    huntId: context.huntId, participantId: context.participantId, huntName: scope.hunt.name as string,
    huntStatus: context.huntStatus, policyRevision: GAMEPLAY_POLICY_REVISION,
    mission: missionDto(scope.execution),
    score: policy.startingScore + await scoreFor(client, scope.participant.id),
    startedAt: scope.participant.started_at ?? null, finishedAt: scope.participant.finished_at ?? null,
    durationMinutes: scope.hunt.duration_minutes ?? null,
    checkpoints: context.checkpoints.map(c => ({ checkpointId: c.checkpointId, ordinal: ordinalOf(c.checkpointId), kind: c.kind,
      accessState: c.accessState, completed: c.gameplayCompleted })),
    stage, current: detail, history,
    safety: { emergencyNumber: publicSettings()['safety.emergencyNumber'] as string, notice: publicSettings()['safety.participantNotice'] as string },
  };
}

export const Gameplay = {
  state: (huntId: string, userId: string) => ParticipantAccess.withExecution(huntId, userId, buildState),

  answer: (huntId: string, userId: string, checkpointId: string, body: { stage: 'personal' | 'team'; answers?: Record<string, string>; answer?: string }) =>
    ParticipantAccess.withExecution(huntId, userId, async (context, points, client, scope) => {
      if (context.huntStatus !== 'active') return fail(409, 'invalid_hunt_state');
      const current = currentCheckpoint(context);
      if (!current || current.checkpointId !== checkpointId) return fail(409, 'checkpoint_not_current');
      if (current.accessState !== 'proximity_verified') return fail(409, 'checkpoint_not_verified');
      const ordinal = context.checkpoints.findIndex(c => c.checkpointId === checkpointId) + 1;
      const entry = checkpointEntry(scope.execution, ordinal);
      if (!playableEntry(entry)) return fail(422, 'challenge_unsupported');
      const participantId = scope.participant.id as string;
      await client.query(`INSERT INTO participant_checkpoint_progress(hunt_id,participant_id,checkpoint_id) VALUES($1,$2,$3)
        ON CONFLICT DO NOTHING`, [huntId, participantId, checkpointId]);
      const { rows } = await client.query<ProgressRow>('SELECT * FROM participant_checkpoint_progress WHERE participant_id=$1 AND checkpoint_id=$2 FOR UPDATE', [participantId, checkpointId]);
      const row = rows[0];
      const policy = scoringPolicy(scope.execution);
      const finish = current.kind === 'finish';
      const authored = typeof entry.checkpoint === 'number' ? entry.checkpoint : ordinal;
      const teamStage = hasTeamStage(entry);
      let correct: boolean;
      if (body.stage === 'personal') {
        if (row.personal_solved_at) return fail(409, 'stage_already_solved');
        correct = checkPersonalAnswer(entry, body.answers ?? {});
        const attempt = row.personal_attempts + 1;
        await client.query('UPDATE participant_checkpoint_progress SET personal_attempts=$3, personal_solved_at=CASE WHEN $4 THEN now() ELSE personal_solved_at END WHERE participant_id=$1 AND checkpoint_id=$2',
          [participantId, checkpointId, attempt, correct]);
        if (!correct) await award(client, huntId, participantId, checkpointId, 'failed_attempt', policy.failedVerifiedAttempt, `${checkpointId}:personal-fail:${attempt}`);
        else {
          await award(client, huntId, participantId, checkpointId, 'personal_solved', policy.personalSolved, `${checkpointId}:personal`);
          if (attempt === 1 && policy.firstAttemptEligible(authored)) await award(client, huntId, participantId, checkpointId, 'first_attempt_bonus', policy.firstAttemptAccuracyBonus, `${checkpointId}:first-attempt`);
        }
      } else {
        if (!teamStage) return fail(409, 'stage_unavailable');
        if (!row.personal_solved_at) return fail(409, 'personal_stage_required');
        if (row.team_solved_at) return fail(409, 'stage_already_solved');
        correct = checkTeamAnswer(entry, body.answer ?? '');
        await client.query('UPDATE participant_checkpoint_progress SET team_attempts=team_attempts+1, team_solved_at=CASE WHEN $3 THEN now() ELSE team_solved_at END WHERE participant_id=$1 AND checkpoint_id=$2',
          [participantId, checkpointId, correct]);
        if (correct) {
          if (finish) await award(client, huntId, participantId, checkpointId, 'finish_puzzle', policy.finishPointPuzzle, `${checkpointId}:finish`);
          else if (policy.teamEligible(authored)) await award(client, huntId, participantId, checkpointId, 'team_solved', policy.solvedTeamChallenge, `${checkpointId}:team`);
        }
      }
      await client.query('UPDATE hunt_participants SET last_activity_at=now(), started_at=COALESCE(started_at, now()) WHERE id=$1', [participantId]);
      await client.query('INSERT INTO participant_challenge_attempts(hunt_id,participant_id,checkpoint_id,stage,correct) VALUES($1,$2,$3,$4,$5)',
        [huntId, participantId, checkpointId, body.stage, correct]);
      const completes = correct && (body.stage === 'team' || !teamStage);
      if (completes) {
        await client.query('UPDATE participant_checkpoint_progress SET completed_at=now() WHERE participant_id=$1 AND checkpoint_id=$2', [participantId, checkpointId]);
        const next = context.checkpoints[ordinal];
        if (next) {
          await client.query(`UPDATE participant_checkpoint_access SET state='eligible_for_proximity'
            WHERE participant_id=$1 AND checkpoint_id=$2 AND state='not_yet_accessible'`, [participantId, next.checkpointId]);
        } else {
          await award(client, huntId, participantId, null, 'mission_completion', policy.missionCompletion, 'mission-completion');
          await client.query('UPDATE hunt_participants SET finished_at=COALESCE(finished_at, now()) WHERE id=$1', [participantId]);
        }
      }
      const refreshed = completes ? { ...context, checkpoints: context.checkpoints.map(c => c.checkpointId === checkpointId
        ? { ...c, gameplayCompleted: true, mayAccessGameplay: false }
        : c.checkpointId === context.checkpoints[ordinal]?.checkpointId && c.accessState === 'not_yet_accessible'
          ? { ...c, accessState: 'eligible_for_proximity' as const } : c) } : context;
      const participant = completes && !context.checkpoints[ordinal] ? { ...scope.participant, finished_at: new Date() } : scope.participant;
      return {
        correct, stage: body.stage, checkpointCompleted: completes,
        ...(correct && body.stage === 'personal' ? { reveal: personalRevealDto(entry) } : {}),
        ...(correct && body.stage === 'team' ? { reveal: teamRevealDto(entry) } : {}),
        state: await buildState(refreshed, points, client, { ...scope, participant }),
      };
    }),

  requestHelp: (huntId: string, userId: string, kind: 'help' | 'emergency', message: string) =>
    ParticipantAccess.withExecution(huntId, userId, async (_context, _points, client, scope) => {
      const { rows } = await client.query(`INSERT INTO hunt_help_requests(hunt_id,participant_id,kind,message) VALUES($1,$2,$3,$4)
        RETURNING id, kind, message, status, created_at`, [huntId, scope.participant.id, kind, message]);
      return { id: rows[0].id, kind: rows[0].kind, message: rows[0].message, status: rows[0].status, createdAt: rows[0].created_at };
    }),

  async leaderboard(huntId: string, userId: string) {
    const { rows } = await pool.query(`SELECT
      EXISTS(SELECT 1 FROM hunt_participants WHERE hunt_id=$1 AND user_id=$2) AS member,
      EXISTS(SELECT 1 FROM hunt_roles WHERE hunt_id=$1 AND user_id=$2) AS staff`, [huntId, userId]);
    if (!rows[0].member && !rows[0].staff) return fail(404, 'not_found');
    const board = await leaderboardRows(pool, huntId);
    const { rows: me } = await pool.query('SELECT id FROM hunt_participants WHERE hunt_id=$1 AND user_id=$2', [huntId, userId]);
    return { huntId, entries: board.map(row => ({ rank: row.rank, displayName: row.displayName, score: row.score,
      checkpointsCompleted: row.completed, checkpointsTotal: row.total, finishedAt: row.finished_at, isYou: row.id === me[0]?.id })) };
  },

  /** Organizer/supervisor live view. Never includes answers or private challenge content. */
  async monitor(huntId: string) {
    const { rows: hunts } = await pool.query("SELECT id, name, status, capacity, duration_minutes, to_char(start_date,'YYYY-MM-DD') AS start_date, start_time, timezone FROM hunts WHERE id=$1", [huntId]);
    if (!hunts[0]) return fail(404, 'not_found');
    const board = await leaderboardRows(pool, huntId);
    const { rows: current } = await pool.query(`SELECT DISTINCT ON (a.participant_id) a.participant_id, c.id AS checkpoint_id, c.ordinal, c.kind, a.state
      FROM participant_checkpoint_access a JOIN hunt_checkpoint_identities c ON c.id=a.checkpoint_id
      LEFT JOIN participant_checkpoint_progress p ON p.participant_id=a.participant_id AND p.checkpoint_id=a.checkpoint_id
      WHERE a.hunt_id=$1 AND p.completed_at IS NULL ORDER BY a.participant_id, c.ordinal`, [huntId]);
    const currentBy = new Map(current.map(row => [row.participant_id, row]));
    const { rows: help } = await pool.query(`SELECT r.id, r.participant_id, r.kind, r.message, r.status, r.created_at, r.resolved_at
      FROM hunt_help_requests r WHERE r.hunt_id=$1 ORDER BY (r.status='open') DESC, r.created_at DESC LIMIT 100`, [huntId]);
    const { rows: activity } = await pool.query(`SELECT a.participant_id, a.stage, a.correct, a.created_at, c.ordinal
      FROM participant_challenge_attempts a JOIN hunt_checkpoint_identities c ON c.id=a.checkpoint_id
      WHERE a.hunt_id=$1 ORDER BY a.created_at DESC LIMIT 30`, [huntId]);
    const names = new Map(board.map(row => [row.id, row.displayName]));
    return {
      hunt: { id: hunts[0].id, name: hunts[0].name, status: hunts[0].status, capacity: hunts[0].capacity, durationMinutes: hunts[0].duration_minutes,
        startDate: hunts[0].start_date, startTime: hunts[0].start_time, timezone: hunts[0].timezone },
      settings: { organizerCheckInEnabled: setting<boolean>('gameplay.organizerCheckInEnabled') },
      totals: { participants: board.length, started: board.filter(r => r.started_at).length, finished: board.filter(r => r.finished_at).length,
        openHelpRequests: help.filter(r => r.status === 'open').length },
      participants: board.map(row => {
        const now = currentBy.get(row.id);
        return { participantId: row.id, displayName: row.displayName, rank: row.rank, score: row.score, joinedAt: row.joined_at,
          startedAt: row.started_at, finishedAt: row.finished_at, lastActivityAt: row.last_activity_at,
          checkpointsCompleted: row.completed, checkpointsTotal: row.total,
          current: now ? { checkpointId: now.checkpoint_id, ordinal: now.ordinal, kind: now.kind, accessState: now.state } : null };
      }),
      helpRequests: help.map(r => ({ id: r.id, participantId: r.participant_id, displayName: names.get(r.participant_id) ?? 'Participant',
        kind: r.kind, message: r.message, status: r.status, createdAt: r.created_at, resolvedAt: r.resolved_at })),
      activity: activity.map(a => ({ participantId: a.participant_id, displayName: names.get(a.participant_id) ?? 'Participant',
        ordinal: a.ordinal, stage: a.stage, correct: a.correct, at: a.created_at })),
    };
  },

  /** D6 pilot fallback: an assigned Organizer confirms arrival when GPS is unavailable or unreliable. Audited by user ID. */
  async checkIn(huntId: string, participantId: string, checkpointId: string, organizerUserId: string) {
    if (!setting<boolean>('gameplay.organizerCheckInEnabled')) return fail(403, 'organizer_check_in_disabled');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: hunts } = await client.query('SELECT status FROM hunts WHERE id=$1 FOR UPDATE', [huntId]);
      if (!hunts[0]) return fail(404, 'not_found');
      if (hunts[0].status !== 'active') return fail(409, 'invalid_hunt_state');
      const { rowCount } = await client.query(`UPDATE participant_checkpoint_access SET state='proximity_verified', verified_at=now(), observed_at=now(),
        accuracy_meters=0, distance_meters=0, policy_revision='organizer-check-in', granted_by_user_id=$4
        WHERE hunt_id=$1 AND participant_id=$2 AND checkpoint_id=$3 AND state='eligible_for_proximity'`, [huntId, participantId, checkpointId, organizerUserId]);
      if (!rowCount) return fail(409, 'checkpoint_not_eligible');
      await client.query('COMMIT');
      return { participantId, checkpointId, accessState: 'proximity_verified' };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  },

  async resolveHelp(huntId: string, requestId: string, userId: string) {
    const { rows } = await pool.query(`UPDATE hunt_help_requests SET status='resolved', resolved_at=now(), resolved_by_user_id=$3
      WHERE hunt_id=$1 AND id=$2 AND status='open' RETURNING id, status, resolved_at`, [huntId, requestId, userId]);
    return rows[0] ? { id: rows[0].id, status: rows[0].status, resolvedAt: rows[0].resolved_at } : fail(404, 'not_found');
  },

  /** Platform-wide open help requests for the Admin Safety Alerts view. */
  async openAlerts() {
    const { rows } = await pool.query(`SELECT r.id, r.hunt_id, h.name AS hunt_name, r.kind, r.message, r.status, r.created_at, r.resolved_at,
        COALESCE(NULLIF(trim(u.name),''), split_part(u.email,'@',1), 'Participant') AS display_name
      FROM hunt_help_requests r JOIN hunts h ON h.id=r.hunt_id JOIN hunt_participants hp ON hp.id=r.participant_id JOIN users u ON u.id=hp.user_id
      ORDER BY (r.status='open') DESC, r.created_at DESC LIMIT 200`);
    return rows.map(r => ({ id: r.id, huntId: r.hunt_id, huntName: r.hunt_name, displayName: r.display_name, kind: r.kind,
      message: r.message, status: r.status, createdAt: r.created_at, resolvedAt: r.resolved_at }));
  },
};
