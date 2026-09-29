import { pool } from '../lib/postgres.js';

export type HuntTemplateOrigin = 'platform' | 'creator';
export type HuntTemplateStatus = 'draft' | 'submitted' | 'changes_requested' | 'approved';

export interface PersistedHuntTemplate {
  id: string;
  key: string;
  origin: HuntTemplateOrigin;
  createdByUserId: string | null;
  status: HuntTemplateStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface PersistedHuntTemplateVersion {
  id: string;
  templateId: string;
  version: number;
  content: unknown;
  origin: HuntTemplateOrigin;
  createdByUserId: string | null;
  createdAt: Date;
}

export interface HuntTemplateWithLatestVersion extends PersistedHuntTemplate {
  latestVersion: number | null;
  latestVersionCreatedAt: Date | null;
}

export interface ApprovedHuntTemplateVersion {
  key: string;
  version: number;
  content: unknown;
}

export interface CreatorOwnedHuntTemplateVersion {
  key: string;
  version: number;
  status: HuntTemplateStatus;
  origin: 'creator';
  content: unknown;
}

interface TemplateProvenance {
  origin: HuntTemplateOrigin;
  createdByUserId?: string | null;
}

export interface CreateHuntTemplateInput extends TemplateProvenance {
  key: string;
  status: HuntTemplateStatus;
}

export interface CreateHuntTemplateVersionInput extends TemplateProvenance {
  templateId: string;
  version: number;
  content: unknown;
}

export class HuntTemplateKeyConflictError extends Error {
  constructor() {
    super('Hunt Template key already exists');
    this.name = 'HuntTemplateKeyConflictError';
  }
}

const mapTemplate = (row: any): PersistedHuntTemplate => ({
  id: row.id,
  key: row.key,
  origin: row.origin,
  createdByUserId: row.created_by_user_id,
  status: row.status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapVersion = (row: any): PersistedHuntTemplateVersion => ({
  id: row.id,
  templateId: row.template_id,
  version: row.version,
  content: row.content,
  origin: row.origin,
  createdByUserId: row.created_by_user_id,
  createdAt: row.created_at,
});

export const HuntTemplates = {
  async createCreatorDraft(
    key: string,
    content: unknown,
    creatorUserId: string,
  ): Promise<{ template: PersistedHuntTemplate; version: PersistedHuntTemplateVersion }> {
    const client = await pool.connect();
    try {
      // Identity and immutable version 1 are one persistence operation: neither may exist alone.
      await client.query('BEGIN');
      const templateResult = await client.query(
        `INSERT INTO hunt_templates (key, origin, created_by_user_id, status)
         VALUES ($1, 'creator', $2, 'draft') RETURNING *`,
        [key, creatorUserId],
      );
      const template = mapTemplate(templateResult.rows[0]);
      const versionResult = await client.query(
        `INSERT INTO hunt_template_versions
           (template_id, version, content, origin, created_by_user_id)
         VALUES ($1, 1, $2, 'creator', $3) RETURNING *`,
        [template.id, content, creatorUserId],
      );
      const version = mapVersion(versionResult.rows[0]);
      await client.query('COMMIT');
      return { template, version };
    } catch (error) {
      await client.query('ROLLBACK');
      // Convert the key's unique constraint violation into a stable domain error.
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
        throw new HuntTemplateKeyConflictError();
      }
      throw error;
    } finally {
      client.release();
    }
  },

  async create(input: CreateHuntTemplateInput): Promise<PersistedHuntTemplate> {
    const { rows } = await pool.query(
      `INSERT INTO hunt_templates (key, origin, created_by_user_id, status)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [input.key, input.origin, input.createdByUserId ?? null, input.status],
    );
    return mapTemplate(rows[0]);
  },

  async createVersion(input: CreateHuntTemplateVersionInput): Promise<PersistedHuntTemplateVersion> {
    const { rows } = await pool.query(
      `INSERT INTO hunt_template_versions
         (template_id, version, content, origin, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [input.templateId, input.version, input.content, input.origin, input.createdByUserId ?? null],
    );
    return mapVersion(rows[0]);
  },

  async createVersion1(
    input: Omit<CreateHuntTemplateVersionInput, 'version'>,
  ): Promise<PersistedHuntTemplateVersion> {
    return this.createVersion({ ...input, version: 1 });
  },

  async findByKey(key: string): Promise<PersistedHuntTemplate | null> {
    const { rows } = await pool.query('SELECT * FROM hunt_templates WHERE key = $1', [key]);
    return rows[0] ? mapTemplate(rows[0]) : null;
  },

  async getVersion(templateId: string, version: number): Promise<PersistedHuntTemplateVersion | null> {
    const { rows } = await pool.query(
      `SELECT * FROM hunt_template_versions WHERE template_id = $1 AND version = $2`,
      [templateId, version],
    );
    return rows[0] ? mapVersion(rows[0]) : null;
  },

  async getLatestVersion(templateId: string): Promise<PersistedHuntTemplateVersion | null> {
    const { rows } = await pool.query(
      `SELECT * FROM hunt_template_versions WHERE template_id = $1
       ORDER BY version DESC LIMIT 1`,
      [templateId],
    );
    return rows[0] ? mapVersion(rows[0]) : null;
  },

  async listApprovedWithLatestVersion(): Promise<ApprovedHuntTemplateVersion[]> {
    const { rows } = await pool.query(
      `SELECT t.key, latest.version, latest.content
       FROM hunt_templates t
       JOIN LATERAL (
         SELECT version, content
         FROM hunt_template_versions
         WHERE template_id = t.id
         ORDER BY version DESC
         LIMIT 1
       ) latest ON TRUE
       WHERE t.status = 'approved'
       ORDER BY t.key ASC`,
    );
    return rows.map(({ key, version, content }) => ({ key, version, content }));
  },

  async findApprovedByKeyWithLatestVersion(
    key: string,
  ): Promise<ApprovedHuntTemplateVersion | null> {
    const { rows } = await pool.query(
      `SELECT t.key, latest.version, latest.content
       FROM hunt_templates t
       JOIN LATERAL (
         SELECT version, content
         FROM hunt_template_versions
         WHERE template_id = t.id
         ORDER BY version DESC
         LIMIT 1
       ) latest ON TRUE
       WHERE t.status = 'approved' AND t.key = $1`,
      [key],
    );
    return rows[0]
      ? { key: rows[0].key, version: rows[0].version, content: rows[0].content }
      : null;
  },

  async listCreatorOwnedWithLatestVersion(
    creatorUserId: string,
  ): Promise<CreatorOwnedHuntTemplateVersion[]> {
    // Ownership belongs in SQL so private rows never leave PostgreSQL for route-level filtering.
    const { rows } = await pool.query(
      `SELECT t.key, t.status, t.origin, latest.version, latest.content
       FROM hunt_templates t
       JOIN LATERAL (
         SELECT version, content
         FROM hunt_template_versions
         WHERE template_id = t.id
         ORDER BY version DESC
         LIMIT 1
       ) latest ON TRUE
       WHERE t.origin = 'creator' AND t.created_by_user_id = $1
       ORDER BY t.key ASC`,
      [creatorUserId],
    );
    return rows.map(({ key, version, status, origin, content }) => ({
      key, version, status, origin, content,
    }));
  },

  async findCreatorOwnedByKeyWithLatestVersion(
    key: string,
    creatorUserId: string,
  ): Promise<CreatorOwnedHuntTemplateVersion | null> {
    const { rows } = await pool.query(
      `SELECT t.key, t.status, t.origin, latest.version, latest.content
       FROM hunt_templates t
       JOIN LATERAL (
         SELECT version, content
         FROM hunt_template_versions
         WHERE template_id = t.id
         ORDER BY version DESC
         LIMIT 1
       ) latest ON TRUE
       WHERE t.origin = 'creator' AND t.created_by_user_id = $1 AND t.key = $2`,
      [creatorUserId, key],
    );
    return rows[0]
      ? {
          key: rows[0].key, version: rows[0].version, status: rows[0].status,
          origin: rows[0].origin, content: rows[0].content,
        }
      : null;
  },

  async list(): Promise<HuntTemplateWithLatestVersion[]> {
    const { rows } = await pool.query(
      `SELECT t.*, latest.version AS latest_version,
              latest.created_at AS latest_version_created_at
       FROM hunt_templates t
       LEFT JOIN LATERAL (
         SELECT version, created_at FROM hunt_template_versions
         WHERE template_id = t.id ORDER BY version DESC LIMIT 1
       ) latest ON TRUE
       ORDER BY t.created_at DESC, t.key`,
    );
    return rows.map((row) => ({
      ...mapTemplate(row),
      latestVersion: row.latest_version,
      latestVersionCreatedAt: row.latest_version_created_at,
    }));
  },
};
