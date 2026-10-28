import type { PoolClient } from 'pg';
import type { Locality } from './Geography.js';
import { pool } from '../lib/postgres.js';
import { isTemplateContent, isTemplateContentSubmittable } from '../domain/creatorTemplates.js';

export type HuntTemplateCategory = 'universal' | 'local';
export type HuntTemplateOrigin = 'platform' | 'creator';
export type HuntTemplateStatus = 'draft' | 'submitted' | 'changes_requested' | 'approved';

export interface PersistedHuntTemplate {
  id: string;
  key: string;
  origin: HuntTemplateOrigin;
  category: HuntTemplateCategory | null;
  createdByUserId: string | null;
  status: HuntTemplateStatus;
  submittedVersion: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export type LocalitySnapshot = Omit<Locality, 'active'>;
interface LocalityBinding {
  localityId: string | null;
  localitySnapshot: LocalitySnapshot | null;
}

export interface PersistedHuntTemplateVersion extends LocalityBinding {
  id: string;
  templateId: string;
  version: number;
  content: unknown;
  origin: HuntTemplateOrigin;
  category: HuntTemplateCategory | null;
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

export interface CreatorOwnedHuntTemplateVersion extends LocalityBinding {
  key: string;
  version: number;
  status: HuntTemplateStatus;
  origin: 'creator';
  category?: HuntTemplateCategory | null;
  submittedVersion: number | null;
  content: unknown;
}

export interface AdminTemplateReview extends LocalityBinding {
  key: string;
  version: number;
  status: 'submitted';
  origin: 'creator';
  category?: HuntTemplateCategory | null;
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
export class HuntTemplateNotDeletableError extends Error {}
export class HuntTemplateInUseError extends Error {}
export class HuntTemplateNotEditableError extends Error {}
export class HuntTemplateNotSubmittableError extends Error {}
export class HuntTemplateVersionNotLatestError extends Error {}
export class HuntTemplateNotReviewableError extends Error {}
export class HuntTemplateSelfApprovalError extends Error {}
export class InvalidHuntTemplateContentError extends Error {}

export class TemplateLocalityError extends Error {
  constructor(public readonly code: string, public readonly status: number) { super(code); }
}

// Called only after the identity/lifecycle/content checks, on the save transaction.
async function resolveLocalityBinding(
  client: PoolClient, category: HuntTemplateCategory | null, selection: unknown,
  previous?: { locality_id: string | null; locality_snapshot: LocalitySnapshot | null },
): Promise<LocalityBinding> {
  if (selection !== undefined && (category !== 'local'
    || (selection !== null && (typeof selection !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(selection))))) {
    throw new TemplateLocalityError('invalid_input', 400);
  }
  if (selection === undefined) return {
    localityId: previous?.locality_id ?? null, localitySnapshot: previous?.locality_snapshot ?? null,
  };
  if (selection === null) return { localityId: null, localitySnapshot: null };
  const initial = (await client.query('SELECT country_code FROM localities WHERE id=$1', [selection])).rows[0];
  if (!initial) throw new TemplateLocalityError('locality_not_found', 404);
  await client.query('SELECT code FROM countries WHERE code=$1 FOR SHARE', [initial.country_code]);
  const row = (await client.query(`SELECT l.id, l.country_code, c.display_name, l.name,
    l.administrative_context, l.latitude, l.longitude, l.active
    FROM localities l JOIN countries c ON c.code=l.country_code
    WHERE l.id=$1 FOR SHARE OF l`, [selection])).rows[0];
  if (!row || !row.active || row.country_code !== initial.country_code) {
    throw new TemplateLocalityError('locality_unavailable', 409);
  }
  return { localityId: row.id, localitySnapshot: {
    id: row.id, countryCode: row.country_code, countryDisplayName: row.display_name,
    name: row.name, administrativeContext: row.administrative_context,
    latitude: row.latitude, longitude: row.longitude,
  } };
}

const mapTemplate = (row: any): PersistedHuntTemplate => ({
  id: row.id,
  key: row.key,
  origin: row.origin,
  category: row.category ?? null,
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
  localityId: row.locality_id ?? null,
  localitySnapshot: row.locality_snapshot ?? null,
  origin: row.origin,
  category: row.category ?? null,
  createdByUserId: row.created_by_user_id,
  createdAt: row.created_at,
});

export const HuntTemplates = {
  async deleteCreatorDraft(key: string, creatorUserId: string): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `SELECT * FROM hunt_templates
         WHERE key = $1 AND origin = 'creator' AND created_by_user_id = $2
         FOR UPDATE`,
        [key, creatorUserId],
      );
      const template = result.rows[0];
      if (!template) throw new HuntTemplateNotFoundError();
      if (template.published_version != null
        || (template.status !== 'draft' && template.status !== 'changes_requested')) {
        throw new HuntTemplateNotDeletableError();
      }

      // A corrected draft still owns immutable prior review evidence.
      if (template.category != null) {
        const reviews = await client.query(
          'SELECT 1 FROM hunt_template_reviews WHERE template_id = $1 LIMIT 1', [template.id],
        );
        if (reviews.rows.length) throw new HuntTemplateNotDeletableError();
      }

      // Hunt references are snapshot fields, not foreign keys. Serialize their writes
      // until commit so a concurrent INSERT/UPDATE cannot escape the dependency check.
      // Approved catalog reads cannot select this locked, non-approved Template.
      await client.query('LOCK TABLE hunts IN SHARE ROW EXCLUSIVE MODE');
      const dependencies = await client.query(
        `SELECT 1 FROM hunts
         WHERE template_key = $1 OR template_snapshot->>'key' = $1 LIMIT 1`,
        [key],
      );
      if (dependencies.rows.length) throw new HuntTemplateInUseError();

      // ON DELETE CASCADE removes all unused draft versions. The deferred review
      // reference is safe even for changes_requested: both ends disappear together.
      await client.query('DELETE FROM hunt_templates WHERE id = $1', [template.id]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      // Any restrictive protected-record reference must preserve the whole draft.
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23503') {
        throw new HuntTemplateInUseError();
      }
      throw error;
    } finally {
      client.release();
    }
  },

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
      // Classified submissions also recheck the exact snapshot against the framework contract.
      // Legacy submission compatibility and immutable version pinning remain unchanged.
      if ((templateResult.rows[0].category != null && !isTemplateContent(latest.content, key, latest.version))
        || !isTemplateContentSubmittable(latest.content, templateResult.rows[0].category ?? null)) {
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
    localityId?: unknown,
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
      // Classified owners may correct a reviewed candidate or revise an approved product.
      if (template.status !== 'draft'
        && !(template.category != null && template.status === 'changes_requested')
        && !(template.category === 'universal' && template.status === 'approved')) {
        throw new HuntTemplateNotEditableError();
      }

      const versionResult = await client.query(
        `SELECT * FROM hunt_template_versions WHERE template_id = $1 ORDER BY version DESC LIMIT 1`,
        [template.id],
      );
      const nextVersion = (versionResult.rows[0]?.version ?? 0) + 1;
      if (!isTemplateContent(content, key, nextVersion)) {
        throw new InvalidHuntTemplateContentError();
      }
      const binding = await resolveLocalityBinding(client, template.category, localityId, versionResult.rows[0]);
      // Versions are complete immutable snapshots; existing rows are never updated.
      const inserted = await client.query(
        `INSERT INTO hunt_template_versions
           (template_id, version, content, origin, created_by_user_id, category, locality_id, locality_snapshot)
         VALUES ($1, $2, $3, 'creator', $4, $5, $6, $7) RETURNING *`,
        [template.id, nextVersion, content, creatorUserId, template.category, binding.localityId, binding.localitySnapshot],
      );
      // Keep publication/history intact; drafts have no active submission pin.
      if (template.status !== 'draft') {
        await client.query("UPDATE hunt_templates SET status = 'draft', submitted_version = NULL, updated_at = now() WHERE id = $1", [template.id]);
        template.status = 'draft';
        template.submittedVersion = null;
      }
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
    category?: HuntTemplateCategory,
    localityId?: unknown,
  ): Promise<{ template: PersistedHuntTemplate; version: PersistedHuntTemplateVersion }> {
    if ((category !== undefined && category !== 'universal' && category !== 'local')
      || !isTemplateContent(content, key, 1)) throw new InvalidHuntTemplateContentError();
    const client = await pool.connect();
    try {
      // Identity and immutable version 1 are one persistence operation: neither may exist alone.
      await client.query('BEGIN');
      const templateResult = await client.query(
        `INSERT INTO hunt_templates (key, origin, created_by_user_id, status, category)
         VALUES ($1, 'creator', $2, 'draft', $3) RETURNING *`,
        [key, creatorUserId, category ?? null],
      );
      const template = mapTemplate(templateResult.rows[0]);
      const binding = await resolveLocalityBinding(client, template.category, localityId);
      const versionResult = await client.query(
        `INSERT INTO hunt_template_versions
           (template_id, version, content, origin, created_by_user_id, category, locality_id, locality_snapshot)
         VALUES ($1, 1, $2, 'creator', $3, $4, $5, $6) RETURNING *`,
        [template.id, content, creatorUserId, template.category, binding.localityId, binding.localitySnapshot],
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

  async approveSubmittedCreator(key: string, reviewerUserId: string, expectedVersion?: number): Promise<ApprovedAdminTemplateReview | null> {
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
      if (row.status !== 'submitted' || row.submitted_version === null
        || (row.category != null && expectedVersion !== row.submitted_version)) {
        throw new HuntTemplateNotReviewableError();
      }

      if (row.created_by_user_id === reviewerUserId) throw new HuntTemplateSelfApprovalError();

      // submitted_version is the approved artifact; never substitute the latest version.
      const reviewResult = await client.query(
        `SELECT t.key, t.origin, t.category, v.version, v.content, v.locality_id, v.locality_snapshot,
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
        `UPDATE hunt_templates SET status = 'approved', updated_at = now(),
           published_version = CASE WHEN category = 'universal' THEN submitted_version ELSE published_version END
         WHERE id = $1 AND status = 'submitted'`,
        [row.id],
      );
      await client.query(
        `INSERT INTO hunt_template_reviews (template_id, version, reviewer_user_id, decision)
         VALUES ($1, $2, $3, 'approved')`,
        [row.id, row.submitted_version, reviewerUserId],
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
    reviewerUserId: string,
    expectedVersion?: number,
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
      if (row.status !== 'submitted' || row.submitted_version === null
        || (row.category != null && expectedVersion !== row.submitted_version)) {
        throw new HuntTemplateNotReviewableError();
      }

      // Resolve only the pinned review artifact; a newer version must never replace it.
      const reviewResult = await client.query(
        `SELECT t.key, t.origin, t.category, v.version, v.content, v.locality_id, v.locality_snapshot,
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
      await client.query(
        `INSERT INTO hunt_template_reviews (template_id, version, reviewer_user_id, decision)
         VALUES ($1, $2, $3, 'changes_requested')`,
        [row.id, row.submitted_version, reviewerUserId],
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

  // C1: only unclassified legacy records remain eligible through shared Organizer
  // resolution. Both classified categories stay closed until reviewed eligibility gates.
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
       WHERE t.status = 'approved' AND t.category IS NULL
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
       WHERE t.status = 'approved' AND t.category IS NULL AND t.key = $1`,
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
      `SELECT t.key, t.status, t.origin, t.category, t.submitted_version, latest.version, latest.content, latest.locality_id, latest.locality_snapshot
       FROM hunt_templates t
       JOIN LATERAL (
         SELECT version, content, locality_id, locality_snapshot
         FROM hunt_template_versions
         WHERE template_id = t.id
         ORDER BY version DESC
         LIMIT 1
       ) latest ON TRUE
       WHERE t.origin = 'creator' AND t.created_by_user_id = $1
       ORDER BY t.key ASC`,
      [creatorUserId],
    );
    return rows.map(({ key, version, status, origin, category, submitted_version, content, locality_id, locality_snapshot }) => ({
      key, version, status, origin, ...(category ? { category } : {}),
      submittedVersion: submitted_version ?? null, content,
      localityId: locality_id ?? null, localitySnapshot: locality_snapshot ?? null,
    }));
  },

  async findCreatorOwnedByKeyWithLatestVersion(
    key: string,
    creatorUserId: string,
  ): Promise<CreatorOwnedHuntTemplateVersion | null> {
    const { rows } = await pool.query(
      `SELECT t.key, t.status, t.origin, t.category, t.submitted_version, latest.version, latest.content, latest.locality_id, latest.locality_snapshot
       FROM hunt_templates t
       JOIN LATERAL (
         SELECT version, content, locality_id, locality_snapshot
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
          origin: rows[0].origin, ...(rows[0].category ? { category: rows[0].category } : {}), submittedVersion: rows[0].submitted_version ?? null,
          content: rows[0].content,
          localityId: rows[0].locality_id ?? null,
          localitySnapshot: rows[0].locality_snapshot ?? null,
        }
      : null;
  },

  async listSubmittedCreatorReviews(): Promise<AdminTemplateReview[]> {
    // Review is pinned to submitted_version. It must never drift to a newer version.
    const { rows } = await pool.query(
      `SELECT t.key, t.status, t.origin, t.category, v.version, v.content, v.locality_id, v.locality_snapshot,
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
      `SELECT t.key, t.status, t.origin, t.category, v.version, v.content, v.locality_id, v.locality_snapshot,
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
  ...(row.category ? { category: row.category } : {}),
  creator: { id: row.creator_id, name: row.creator_name, email: row.creator_email },
  content: row.content,
  localityId: row.locality_id ?? null,
  localitySnapshot: row.locality_snapshot ?? null,
});
