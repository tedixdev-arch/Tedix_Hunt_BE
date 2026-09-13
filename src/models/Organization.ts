import { pool } from '../lib/postgres.js';

export interface PublicUser {
  id: string;
  email?: string | null;
  role: string;
  name?: string | null;
  isGuest: boolean;
  tedixUserId?: string | null;
  createdAt: Date;
}

export interface IOrganization {
  id: string;
  name: string;
  description?: string | null;
  owner: string | PublicUser;
  members: (string | PublicUser)[];
  createdAt: Date;
}

const PUBLIC_USER_COLUMNS = 'id, email, role, name, is_guest, tedix_user_id, created_at';

export interface CreateOrganizationInput {
  name: string;
  description?: string;
  owner: string;
  members: string[];
}

const mapRow = (row: any, members: string[] = []): IOrganization => ({
  id: row.id,
  name: row.name,
  description: row.description,
  owner: row.owner_id,
  members,
  createdAt: row.created_at,
});

const memberIds = async (organizationId: string): Promise<string[]> => {
  const { rows } = await pool.query(
    'SELECT user_id FROM organization_members WHERE organization_id = $1',
    [organizationId],
  );
  return rows.map((row) => row.user_id);
};

const userRowToPublicUser = (row: any): PublicUser => ({
  id: row.id,
  email: row.email,
  role: row.role,
  name: row.name,
  isGuest: row.is_guest,
  tedixUserId: row.tedix_user_id,
  createdAt: row.created_at,
});

export const Organization = {
  async create(input: CreateOrganizationInput): Promise<IOrganization> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO organizations (name, description, owner_id)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [input.name, input.description ?? null, input.owner],
      );
      const org = rows[0];

      for (const memberId of input.members) {
        await client.query(
          `INSERT INTO organization_members (organization_id, user_id)
           VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [org.id, memberId],
        );
      }

      await client.query('COMMIT');
      return mapRow(org, input.members);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  async findById(id: string, options: { populate?: boolean } = {}): Promise<IOrganization | null> {
    const { rows } = await pool.query('SELECT * FROM organizations WHERE id = $1 LIMIT 1', [id]);
    if (!rows[0]) return null;

    if (options.populate) {
      const { rows: memberRows } = await pool.query(
        `SELECT ${PUBLIC_USER_COLUMNS} FROM organization_members om
         JOIN users u ON u.id = om.user_id
         WHERE om.organization_id = $1`,
        [id],
      );
      const { rows: ownerRows } = await pool.query(
        `SELECT ${PUBLIC_USER_COLUMNS} FROM users WHERE id = $1`,
        [rows[0].owner_id],
      );
      return {
        ...mapRow(rows[0], memberRows.map((r) => r.id)),
        owner: ownerRows[0] ? userRowToPublicUser(ownerRows[0]) : rows[0].owner_id,
        members: memberRows.map(userRowToPublicUser),
      };
    }

    return mapRow(rows[0], await memberIds(id));
  },

  async findByOwnerOrMember(userId: string): Promise<IOrganization[]> {
    const { rows } = await pool.query(
      `SELECT DISTINCT o.* FROM organizations o
       LEFT JOIN organization_members om ON om.organization_id = o.id
       WHERE o.owner_id = $1 OR om.user_id = $1`,
      [userId],
    );

    return Promise.all(rows.map(async (row) => mapRow(row, await memberIds(row.id))));
  },

  async update(id: string, changes: { name?: string; description?: string }): Promise<IOrganization | null> {
    const { rows } = await pool.query(
      `UPDATE organizations SET
         name = COALESCE($2, name),
         description = COALESCE($3, description)
       WHERE id = $1
       RETURNING *`,
      [id, changes.name ?? null, changes.description ?? null],
    );
    return rows[0] ? mapRow(rows[0], await memberIds(id)) : null;
  },
};
