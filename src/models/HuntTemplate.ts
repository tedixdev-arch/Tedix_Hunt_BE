import { pool } from '../lib/postgres.js';
import { isTemplateContent, isTemplateContentSubmittable } from '../domain/creatorTemplates.js';

export type HuntTemplateOrigin = 'platform' | 'creator';
export type HuntTemplateStatus = 'draft' | 'submitted' | 'changes_requested' | 'approved';

export interface PersistedHuntTemplate {
  id: string;
  key: string;
  origin: HuntTemplateOrigin;
  createdByUserId: string | null;
  status: HuntTemplateStatus;
  submittedVersion: number | null;
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
  submittedVersion: number | null;
  content: unknown;
}

export interface AdminTemplateReview {
  key: string;
  version: number;
  status: 'submitted';
  origin: 'creator';
  creator: { id: string; name: string | null; email: string | null };
  content: unknown;
}

export interface ApprovedAdminTemplateReview extends Omit<AdminTemplateReview, 'status'> {
  status: 'approved';
}

export interface ChangesRequestedAdminTemplateReview extends Omit<AdminTemplateReview, 'status'> {
  status: 'changes_requested';
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

export class HuntTemplateNotFoundError extends Error {}
export class HuntTemplateNotEditableError extends Error {}
export class HuntTemplateNotSubmittableError extends Error {}
export class HuntTemplateVersionNotLatestError extends Error {}
export class HuntTemplateNotReviewableError extends Error {}
export class InvalidHuntTemplateContentError extends Error {}

const mapTemplate = (row: any): PersistedHuntTemplate => ({
  id: row.id,
  key: row.key,
  origin: row.origin,
  createdByUserId: row.created_by_user_id,
  status: row.status,
  submittedVersion: row.submitted_version ?? null,
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
  async submitCreatorDraft(
    key: string,
    requestedVersion: number,
    creatorUserId: string,
  ): Promise<{ template: PersistedHuntTemplate; version: PersistedHuntTemplateVersion }> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Ownership is checked in the locking query both to avoid disclosure and to serialize
      // submission against createCreatorVersion's lock on the same identity row.
      const templateResult = await client.query(
        `SELECT * FROM hunt_templates
         WHERE key = $1 AND origin = 'creator' AND created_by_user_id = $2
         FOR UPDATE`,
        [key, creatorUserId],
      );
      if (!templateResult.rows[0]) throw new HuntTemplateNotFoundError();
      if (templateResult.rows[0].status !== 'draft') throw new HuntTemplateNotSubmittableError();

      const versionResult = await client.query(
        `SELECT * FROM hunt_template_versions
         WHERE template_id = $1 ORDER BY version DESC LIMIT 1`,
        [templateResult.rows[0].id],
      );
      const latest = versionResult.rows[0];
      if (!latest || latest.version !== requestedVersion) {
        throw new HuntTemplateVersionNotLatestError();
      }
      // Only the submission boundary requires a complete 1..N geographic structure. Draft
      // versions stay progressively authorable, while legacy content without the contract works.
      if (!isTemplateContentSubmittable(latest.content)) {
        throw new InvalidHuntTemplateContentError();
      }

      // Status and its exact immutable review artifact change in one transaction.
      const updated = await client.query(
        `UPDATE hunt_templates
         SET status = 'submitted', submitted_version = $2, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [templateResult.rows[0].id, requestedVersion],
      );
      await client.query('COMMIT');
      return { template: mapTemplate(updated.rows[0]), version: mapVersion(latest) };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },

  async createCreatorVersion(
    key: string,
    content: unknown,
    creatorUserId: string,
  ): Promise<{ template: PersistedHuntTemplate; version: PersistedHuntTemplateVersion }> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // The identity lock serializes version allocation across application instances.
      const templateResult = await client.query(
        `SELECT * FROM hunt_templates
         WHERE key = $1 AND origin = 'creator' AND created_by_user_id = $2
         FOR UPDATE`,
        [key, creatorUserId],
      );
      if (!templateResult.rows[0]) throw new HuntTemplateNotFoundError();
      const template = mapTemplate(templateResult.rows[0]);
      // Only draft authoring is editable in this workflow slice.
      if (template.status !== 'draft') throw new HuntTemplateNotEditableError();

      const versionResult = await client.query(
        `SELECT COALESCE(MAX(version), 0)::integer AS current_version
         FROM hunt_template_versions WHERE template_id = $1`,
        [template.id],
      );
      const nextVersion = versionResult.rows[0].current_version + 1;
      if (!isTemplateContent(content, key, nextVersion)) {
        throw new InvalidHuntTemplateContentError();
      }
      // Versions are complete immutable snapshots; existing rows are never updated.
      const inserted = await client.query(
        `INSERT INTO hunt_template_versions
           (template_id, version, content, origin, created_by_user_id)
         VALUES ($1, $2, $3, 'creator', $4) RETURNING *`,
        [template.id, nextVersion, content, creatorUserId],
      );
      await client.query('COMMIT');
      return { template, version: mapVersion(inserted.rows[0]) };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },

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

  async approveSubmittedCreator(key: string): Promise<ApprovedAdminTemplateReview | null> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Lock the Creator identity first: only one concurrent Admin can perform the transition.
      const templateResult = await client.query(
        `SELECT * FROM hunt_templates
         WHERE key = $1 AND origin = 'creator'
         FOR UPDATE`,
        [key],
      );
      const row = templateResult.rows[0];
      if (!row) {
        await client.query('ROLLBACK');
        return null;
      }
      if (row.status !== 'submitted' || row.submitted_version === null) {
        throw new HuntTemplateNotReviewableError();
      }

      // submitted_version is the approved artifact; never substitute the latest version.
      const reviewResult = await client.query(
        `SELECT t.key, t.origin, v.version, v.content,
                creator.id AS creator_id, creator.name AS creator_name,
                creator.email AS creator_email
         FROM hunt_templates t
         JOIN hunt_template_versions v
           ON v.template_id = t.id AND v.version = t.submitted_version
         JOIN users creator ON creator.id = t.created_by_user_id
         WHERE t.id = $1`,
        [row.id],
      );
      if (!reviewResult.rows[0]) throw new HuntTemplateNotReviewableError();

      await client.query(
        `UPDATE hunt_templates SET status = 'approved', updated_at = now()
         WHERE id = $1 AND status = 'submitted'`,
        [row.id],
      );
      await client.query('COMMIT');
      return { ...mapAdminReview({ ...reviewResult.rows[0], status: 'approved' }), status: 'approved' };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },

  async requestChangesForSubmittedCreator(
    key: string,
  ): Promise<ChangesRequestedAdminTemplateReview | null> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // The identity lock serializes request-changes with every other Admin decision.
      const templateResult = await client.query(
        `SELECT * FROM hunt_templates
         WHERE key = $1 AND origin = 'creator'
         FOR UPDATE`,
        [key],
      );
      const row = templateResult.rows[0];
      if (!row) {
        await client.query('ROLLBACK');
        return null;
      }
      if (row.status !== 'submitted' || row.submitted_version === null) {
        throw new HuntTemplateNotReviewableError();
      }

      // Resolve only the pinned review artifact; a newer version must never replace it.
      const reviewResult = await client.query(
        `SELECT t.key, t.origin, v.version, v.content,
                creator.id AS creator_id, creator.name AS creator_name,
                creator.email AS creator_email
         FROM hunt_templates t
         JOIN hunt_template_versions v
           ON v.template_id = t.id AND v.version = t.submitted_version
         JOIN users creator ON creator.id = t.created_by_user_id
         WHERE t.id = $1`,
        [row.id],
      );
      if (!reviewResult.rows[0]) throw new HuntTemplateNotReviewableError();

      // Preserve submitted_version: it records the immutable artifact that was reviewed.
      await client.query(
        `UPDATE hunt_templates SET status = 'changes_requested', updated_at = now()
         WHERE id = $1 AND status = 'submitted'`,
        [row.id],
      );
      await client.query('COMMIT');
      return {
        ...mapAdminReview({ ...reviewResult.rows[0], status: 'changes_requested' }),
        status: 'changes_requested',
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },

  async listApprovedWithLatestVersion(): Promise<ApprovedHuntTemplateVersion[]> {
    const { rows } = await pool.query(
      `SELECT t.key, latest.version, latest.content
       FROM hunt_templates t
       JOIN LATERAL (
         SELECT version, content
         FROM hunt_template_versions
         WHERE template_id = t.id
           AND (t.origin = 'platform' OR version = t.submitted_version)
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
           AND (t.origin = 'platform' OR version = t.submitted_version)
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
      `SELECT t.key, t.status, t.origin, t.submitted_version, latest.version, latest.content
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
    return rows.map(({ key, version, status, origin, submitted_version, content }) => ({
      key, version, status, origin, submittedVersion: submitted_version ?? null, content,
    }));
  },

  async findCreatorOwnedByKeyWithLatestVersion(
    key: string,
    creatorUserId: string,
  ): Promise<CreatorOwnedHuntTemplateVersion | null> {
    const { rows } = await pool.query(
      `SELECT t.key, t.status, t.origin, t.submitted_version, latest.version, latest.content
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
          origin: rows[0].origin, submittedVersion: rows[0].submitted_version ?? null,
          content: rows[0].content,
        }
      : null;
  },

  async listSubmittedCreatorReviews(): Promise<AdminTemplateReview[]> {
    // Review is pinned to submitted_version. It must never drift to a newer version.
    const { rows } = await pool.query(
      `SELECT t.key, t.status, t.origin, v.version, v.content,
              creator.id AS creator_id, creator.name AS creator_name,
              creator.email AS creator_email
       FROM hunt_templates t
       JOIN hunt_template_versions v
         ON v.template_id = t.id AND v.version = t.submitted_version
       JOIN users creator ON creator.id = t.created_by_user_id
       WHERE t.origin = 'creator'
         AND t.status = 'submitted'
         AND t.submitted_version IS NOT NULL
       ORDER BY t.key ASC`,
    );
    return rows.map(mapAdminReview);
  },

  async findSubmittedCreatorReviewByKey(key: string): Promise<AdminTemplateReview | null> {
    const { rows } = await pool.query(
      `SELECT t.key, t.status, t.origin, v.version, v.content,
              creator.id AS creator_id, creator.name AS creator_name,
              creator.email AS creator_email
       FROM hunt_templates t
       JOIN hunt_template_versions v
         ON v.template_id = t.id AND v.version = t.submitted_version
       JOIN users creator ON creator.id = t.created_by_user_id
       WHERE t.origin = 'creator'
         AND t.status = 'submitted'
         AND t.submitted_version IS NOT NULL
         AND t.key = $1`,
      [key],
    );
    return rows[0] ? mapAdminReview(rows[0]) : null;
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

const mapAdminReview = (row: any): AdminTemplateReview => ({
  key: row.key,
  version: row.version,
  status: row.status,
  origin: row.origin,
  creator: { id: row.creator_id, name: row.creator_name, email: row.creator_email },
  content: row.content,
});
