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
