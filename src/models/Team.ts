import { pool } from '../lib/postgres.js';

export interface ITeam {
  id: string;
  huntId: string;
  name: string;
  createdAt: Date;
}

export interface ITeamMember {
  huntId: string;
  teamId: string;
  huntParticipantId: string;
  joinedAt: Date;
}

const mapTeam = (row: any): ITeam => ({
  id: row.id,
  huntId: row.hunt_id,
  name: row.name,
  createdAt: row.created_at,
});

const mapMember = (row: any): ITeamMember => ({
  huntId: row.hunt_id,
  teamId: row.team_id,
  huntParticipantId: row.hunt_participant_id,
  joinedAt: row.joined_at,
});

export const Team = {
  async create(huntId: string, name: string): Promise<ITeam> {
    const { rows } = await pool.query(
      'INSERT INTO teams (hunt_id, name) VALUES ($1, $2) RETURNING *',
      [huntId, name],
    );
    return mapTeam(rows[0]);
  },

  async findById(id: string): Promise<ITeam | null> {
    const { rows } = await pool.query('SELECT * FROM teams WHERE id = $1 LIMIT 1', [id]);
    return rows[0] ? mapTeam(rows[0]) : null;
  },

  async addParticipant(teamId: string, huntParticipantId: string): Promise<ITeamMember | null> {
    const { rows } = await pool.query(
      `INSERT INTO team_members (hunt_id, team_id, hunt_participant_id)
       SELECT t.hunt_id, t.id, hp.id
         FROM teams t
         JOIN hunt_participants hp ON hp.hunt_id = t.hunt_id
        WHERE t.id = $1 AND hp.id = $2
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [teamId, huntParticipantId],
    );
    return rows[0] ? mapMember(rows[0]) : null;
  },
};
