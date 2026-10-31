import { inheritedRadii, type CheckpointRadii, withRadiusDefaults } from '../domain/checkpointRadius.js';
import { allocateCustomExercises, validateCustomExercises, CustomExerciseValidationError } from '../domain/customExercises.js';
import type { PoolClient } from 'pg';
import type { Locality } from './Geography.js';
import { pool } from '../lib/postgres.js';
import { isTemplateContent, isTemplateContentSubmittable } from '../domain/creatorTemplates.js';

export type HuntTemplateCategory = 'universal' | 'local';
export type HuntTemplateOrigin = 'platform' | 'creator';
export type HuntTemplateStatus = 'draft' | 'submitted' | 'changes_requested' | 'approved';

export interface LocalApprovalState {
  localApprovedVersion: number | null;
  localApproval: {
    version: number | null;
    authority: 'approved' | 'historical' | 'integrity_exception' | 'none';
    independentEvidence: boolean;
    localityBound: boolean;
  };
  localSuspension: { at: Date; byUserId: string; reason: string; version: number } | null;
}

export interface PersistedHuntTemplate extends Partial<LocalApprovalState> {
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

export interface CreatorOwnedHuntTemplateVersion extends LocalityBinding, Partial<LocalApprovalState> {
  /** Universal GET projections only: exact retained C5 pin; null means never published. */
  publishedVersion?: number | null;
  key: string;
  version: number;
  status: HuntTemplateStatus;
  origin: 'creator';
  category?: HuntTemplateCategory | null;
  submittedVersion: number | null;
  content: unknown;
}

export interface AdminTemplateReview extends LocalityBinding, Partial<LocalApprovalState> {
  key: string;
  version: number;
  status: 'submitted';
  origin: 'creator';
  category?: HuntTemplateCategory | null;
  currentLocality?: Locality | null;
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
export class TemplateApprovalEvidenceError extends Error {}
export class TemplateEligibilityConflictError extends Error {}
export class InvalidHuntTemplateContentError extends Error {}

export class TemplateLocalityError extends Error {
  constructor(public readonly code: string, public readonly status: number) { super(code); }
}

// Called only after the identity/lifecycle/content checks, on the save transaction.
async function resolveLocalityBinding(
  client: PoolClient, category: HuntTemplateCategory | null, selection: unknown,
  previous?: { locality_id: string | null; locality_snapshot: LocalitySnapshot | null },
  transition = false,
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
  if (!row || !row.active) throw new TemplateLocalityError('locality_unavailable', 409);
  if (row.country_code !== initial.country_code) {
    throw new TemplateLocalityError(transition ? 'locality_geography_changed' : 'locality_unavailable', 409);
  }
  return { localityId: row.id, localitySnapshot: {
    id: row.id, countryCode: row.country_code, countryDisplayName: row.display_name,
    name: row.name, administrativeContext: row.administrative_context,
    latitude: row.latitude, longitude: row.longitude,
  } };
}

// The saved artifact is compared numerically while catalog text remains separate context.
async function validateLocality(client: PoolClient, row: any): Promise<void> {
  if (!row.locality_id || !row.locality_snapshot) throw new TemplateLocalityError('locality_required', 400);
  const current = await resolveLocalityBinding(client, 'local', row.locality_id, undefined, true).catch(error => {
    if (error instanceof TemplateLocalityError && error.code === 'locality_not_found') {
      throw new TemplateLocalityError('locality_unavailable', 409);
    }
    throw error;
  });
  const saved = row.locality_snapshot;
  const live = current.localitySnapshot!;
  if (saved.id !== row.locality_id || live.id !== saved.id || saved.countryCode !== live.countryCode
    || !Number.isFinite(saved.latitude) || Math.abs(saved.latitude) > 90
    || !Number.isFinite(saved.longitude) || Math.abs(saved.longitude) > 180
    || Number(saved.latitude) !== Number(live.latitude) || Number(saved.longitude) !== Number(live.longitude)) {
    throw new TemplateLocalityError('locality_geography_changed', 409);
  }
}

// Same statement joins the exact authority and its evidence, avoiding mixed reader snapshots.
const localAuthorityColumns = `t.local_approved_version, t.local_suspended_at,
  t.local_suspended_by_user_id, t.local_suspension_reason, t.local_suspended_version,
  authority.version AS authority_version, authority.locality_id AS authority_locality_id,
  authority.locality_snapshot AS authority_locality_snapshot,
  COALESCE(evidence.decision='approved' AND evidence.reviewer_user_id<>t.created_by_user_id, false) AS independent_evidence`;
const localAuthorityJoins = `LEFT JOIN hunt_template_versions authority
  ON authority.template_id=t.id AND authority.version=COALESCE(t.local_approved_version,
    CASE WHEN t.category='local' AND t.status='approved' THEN t.submitted_version END)
  LEFT JOIN hunt_template_reviews evidence ON evidence.template_id=t.id AND evidence.version=authority.version`;
async function readLocalState(client: PoolClient, id: string) {
  const row = (await client.query(`SELECT t.*, ${localAuthorityColumns}
    FROM hunt_templates t ${localAuthorityJoins} WHERE t.id=$1`, [id])).rows[0];
  return mapLocalApproval(row);
}

export const mapLocalApproval = (row: any): LocalApprovalState => ({
  localApprovedVersion: row.local_approved_version ?? null,
  localApproval: {
    version: row.authority_version ?? row.local_approved_version ?? (row.category === 'local' && row.status === 'approved' ? row.submitted_version : null),
    authority: row.category !== 'local' ? 'none' : row.local_approved_version != null
      ? 'approved' : row.status === 'approved'
        ? (row.authority_version != null ? 'historical' : 'integrity_exception') : 'none',
    independentEvidence: row.independent_evidence ?? false,
    localityBound: row.authority_locality_id != null && row.authority_locality_snapshot != null,
  },
  localSuspension: row.local_suspended_at == null ? null : {
    at: row.local_suspended_at, byUserId: row.local_suspended_by_user_id,
    reason: row.local_suspension_reason, version: row.local_suspended_version,
  },
});

const mapTemplate = (row: any): PersistedHuntTemplate => ({
  ...(row.category === 'local' ? mapLocalApproval(row) : {}),
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
      if (template.local_approved_version != null || template.local_suspended_at != null
        || template.published_version != null
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

      if (templateResult.rows[0].category === 'local') await validateLocality(client, latest);

      // Status and its exact immutable review artifact change in one transaction.
      const updated = await client.query(
        `UPDATE hunt_templates
         SET status = 'submitted', submitted_version = $2, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [templateResult.rows[0].id, requestedVersion],
      );
      const state = templateResult.rows[0].category === 'local' ? await readLocalState(client, templateResult.rows[0].id) : {};
      await client.query('COMMIT');
      return { template: { ...mapTemplate(updated.rows[0]), ...state }, version: mapVersion(latest) };
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
    adminRadiusEdit?: { version: number; radii: Partial<CheckpointRadii> },
  ): Promise<{ template: PersistedHuntTemplate; version: PersistedHuntTemplateVersion }> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Account before Template: agrees with selection and account retirement writers.
      await client.query('SELECT id FROM users WHERE id=$1 FOR SHARE', [creatorUserId]);
      if (adminRadiusEdit && !(await client.query("SELECT 1 FROM user_roles WHERE user_id=$1 AND role='admin' AND EXISTS(SELECT 1 FROM users WHERE id=$1 AND account_status='active' AND NOT is_guest) FOR SHARE", [creatorUserId])).rowCount)
        throw new HuntTemplateNotFoundError();
      // The identity lock serializes version allocation across application instances.
      const templateResult = await client.query(
        `SELECT * FROM hunt_templates
         WHERE key = $1 AND origin = 'creator' AND (created_by_user_id = $2 OR $3)
         FOR UPDATE`,
        [key, creatorUserId, !!adminRadiusEdit],
      );
      if (!templateResult.rows[0]) throw new HuntTemplateNotFoundError();
      const template = mapTemplate(templateResult.rows[0]);
      if (adminRadiusEdit && (template.category !== 'local' || template.status !== 'draft')) throw new HuntTemplateNotEditableError();
      const ownerId = template.createdByUserId;
      // Classified owners may correct a reviewed candidate or revise an approved product.
      if (template.status !== 'draft'
        && !(template.category != null && template.status === 'changes_requested')
        && !(template.category != null && template.status === 'approved')) {
        throw new HuntTemplateNotEditableError();
      }

      const versionResult = await client.query(
        `SELECT * FROM hunt_template_versions WHERE template_id = $1 ORDER BY version DESC LIMIT 1`,
        [template.id],
      );
      if (adminRadiusEdit) {
        const latest = versionResult.rows[0];
        if (!latest || latest.version !== adminRadiusEdit.version) throw new HuntTemplateVersionNotLatestError();
        const candidate = structuredClone(latest.content);
        const radii = inheritedRadii(candidate);
        for (const point of adminRadiusEdit.radii.checkpointPositions ?? []) {
          if (!radii.checkpointPositions.some(p => p.checkpointNumber === point.checkpointNumber)) throw new InvalidHuntTemplateContentError();
          const saved = candidate.configuration.checkpointPositions.find((p: any) => p.checkpointNumber === point.checkpointNumber);
          saved.radiusMeters = point.radiusMeters;
        }
        if (adminRadiusEdit.radii.finishPoint) {
          if (!candidate.configuration.finishPoint) throw new InvalidHuntTemplateContentError();
          candidate.configuration.finishPoint.radiusMeters = adminRadiusEdit.radii.finishPoint.radiusMeters;
        }
        candidate.version = latest.version + 1;
        content = candidate;
      }
      const nextVersion = (versionResult.rows[0]?.version ?? 0) + 1;
      const customIssues = validateCustomExercises(content);
      if (customIssues.length) throw new CustomExerciseValidationError(customIssues);
      if (!isTemplateContent(content, key, nextVersion)) {
        throw new InvalidHuntTemplateContentError();
      }
      content = allocateCustomExercises(withRadiusDefaults(content, versionResult.rows[0]?.content), key, nextVersion, versionResult.rows[0]?.content);
      if (template.category === 'local' && template.status === 'approved' && template.localApprovedVersion == null) {
        const evidence = await client.query(`SELECT v.version FROM hunt_template_versions v
          JOIN hunt_template_reviews r ON r.template_id=v.template_id AND r.version=v.version
          WHERE v.template_id=$1 AND v.version=$2 AND r.decision='approved'
            AND r.reviewer_user_id<>$3`, [template.id, template.submittedVersion, creatorUserId]);
        if (!evidence.rows[0]) throw new TemplateApprovalEvidenceError();
        // Capture before any candidate mutation. The SQL guard verifies committed evidence.
        await client.query('UPDATE hunt_templates SET local_approved_version=submitted_version WHERE id=$1', [template.id]);
        template.localApprovedVersion = template.submittedVersion;
      }
      const binding = await resolveLocalityBinding(client, template.category, localityId, versionResult.rows[0]);
      // Versions are complete immutable snapshots; existing rows are never updated.
      const inserted = await client.query(
        `INSERT INTO hunt_template_versions
           (template_id, version, content, origin, created_by_user_id, category, locality_id, locality_snapshot)
         VALUES ($1, $2, $3, 'creator', $4, $5, $6, $7) RETURNING *`,
        [template.id, nextVersion, content, ownerId, template.category, binding.localityId, binding.localitySnapshot],
      );
      // Keep publication/history intact; drafts have no active submission pin.
      if (template.status !== 'draft') {
        await client.query("UPDATE hunt_templates SET status = 'draft', submitted_version = NULL, updated_at = now() WHERE id = $1", [template.id]);
        template.status = 'draft';
        template.submittedVersion = null;
      }
      if (template.category === 'local') Object.assign(template, await readLocalState(client, template.id));
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
    const customIssues = validateCustomExercises(content);
    if (customIssues.length) throw new CustomExerciseValidationError(customIssues);
    if ((category !== undefined && category !== 'universal' && category !== 'local')
      || !isTemplateContent(content, key, 1)) throw new InvalidHuntTemplateContentError();
    content = allocateCustomExercises(withRadiusDefaults(content), key, 1);
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
    const { rows } = await pool.query(`SELECT t.*, ${localAuthorityColumns} FROM hunt_templates t ${localAuthorityJoins} WHERE t.key = $1`, [key]);
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
      // Account before Template: agrees with selection and account retirement writers.
      await client.query('SELECT id FROM users WHERE id=$1 FOR SHARE', [reviewerUserId]);
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
        `SELECT t.key, t.status, t.origin, t.category, t.submitted_version, ${localAuthorityColumns},
              (SELECT jsonb_build_object('id',l.id,'countryCode',l.country_code,
                'countryDisplayName',c.display_name,'name',l.name,'administrativeContext',l.administrative_context,
                'latitude',l.latitude,'longitude',l.longitude,'active',l.active)
               FROM localities l JOIN countries c ON c.code=l.country_code WHERE l.id=v.locality_id) AS current_locality,
              v.version, v.content, v.locality_id, v.locality_snapshot,
                creator.id AS creator_id, creator.name AS creator_name,
                creator.email AS creator_email
         FROM hunt_templates t
       ${localAuthorityJoins}
         JOIN hunt_template_versions v
           ON v.template_id = t.id AND v.version = t.submitted_version
         JOIN users creator ON creator.id = t.created_by_user_id
         WHERE t.id = $1`,
        [row.id],
      );
      if (!reviewResult.rows[0]) throw new HuntTemplateNotReviewableError();

      if (row.category === 'local') {
        const artifact = reviewResult.rows[0];
        if (!isTemplateContent(artifact.content, key, artifact.version)
          || !isTemplateContentSubmittable(artifact.content, 'local')) throw new InvalidHuntTemplateContentError();
        await validateLocality(client, artifact);
      }
      await client.query(
        `UPDATE hunt_templates SET status = 'approved', updated_at = now(),
           published_version = CASE WHEN category = 'universal' THEN submitted_version ELSE published_version END,
           local_approved_version = CASE WHEN category = 'local' THEN submitted_version ELSE local_approved_version END
         WHERE id = $1 AND status = 'submitted'`,
        [row.id],
      );
      await client.query(
        `INSERT INTO hunt_template_reviews (template_id, version, reviewer_user_id, decision)
         VALUES ($1, $2, $3, 'approved')`,
        [row.id, row.submitted_version, reviewerUserId],
      );
      const state = row.category === 'local' ? await readLocalState(client, row.id) : {};
      await client.query('COMMIT');
      return { ...mapAdminReview({ ...reviewResult.rows[0], status: 'approved' }), ...state, status: 'approved' };
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
      // Account before Template: agrees with selection and account retirement writers.
      await client.query('SELECT id FROM users WHERE id=$1 FOR SHARE', [reviewerUserId]);
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
        `SELECT t.key, t.status, t.origin, t.category, t.submitted_version, ${localAuthorityColumns},
              (SELECT jsonb_build_object('id',l.id,'countryCode',l.country_code,
                'countryDisplayName',c.display_name,'name',l.name,'administrativeContext',l.administrative_context,
                'latitude',l.latitude,'longitude',l.longitude,'active',l.active)
               FROM localities l JOIN countries c ON c.code=l.country_code WHERE l.id=v.locality_id) AS current_locality,
              v.version, v.content, v.locality_id, v.locality_snapshot,
                creator.id AS creator_id, creator.name AS creator_name,
                creator.email AS creator_email
         FROM hunt_templates t
       ${localAuthorityJoins}
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
      const state = row.category === 'local' ? await readLocalState(client, row.id) : {};
      await client.query('COMMIT');
      return {
        ...mapAdminReview({ ...reviewResult.rows[0], status: 'changes_requested' }), ...state,
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
      `SELECT t.key, t.status, t.origin, t.category, t.submitted_version, t.published_version, ${localAuthorityColumns}, latest.version, latest.content, latest.locality_id, latest.locality_snapshot
       FROM hunt_templates t
       ${localAuthorityJoins}
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
    return rows.map((row) => {
      const { key, version, status, origin, category, submitted_version, content, locality_id, locality_snapshot } = row;
      return ({
      ...(category === 'local' ? mapLocalApproval(row) : {}),
      ...(category === 'universal' ? { publishedVersion: row.published_version } : {}),
      key, version, status, origin, ...(category ? { category } : {}),
      submittedVersion: submitted_version ?? null, content,
      localityId: locality_id ?? null, localitySnapshot: locality_snapshot ?? null,
    }); });
  },

  async findCreatorOwnedByKeyWithLatestVersion(
    key: string,
    creatorUserId: string,
  ): Promise<CreatorOwnedHuntTemplateVersion | null> {
    const { rows } = await pool.query(
      `SELECT t.key, t.status, t.origin, t.category, t.submitted_version, t.published_version, ${localAuthorityColumns}, latest.version, latest.content, latest.locality_id, latest.locality_snapshot
       FROM hunt_templates t
       ${localAuthorityJoins}
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
          ...(rows[0].category === 'local' ? mapLocalApproval(rows[0]) : {}),
          ...(rows[0].category === 'universal' ? { publishedVersion: rows[0].published_version } : {}),
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
      `SELECT t.key, t.status, t.origin, t.category, t.submitted_version, ${localAuthorityColumns},
              (SELECT jsonb_build_object('id',l.id,'countryCode',l.country_code,
                'countryDisplayName',c.display_name,'name',l.name,'administrativeContext',l.administrative_context,
                'latitude',l.latitude,'longitude',l.longitude,'active',l.active)
               FROM localities l JOIN countries c ON c.code=l.country_code WHERE l.id=v.locality_id) AS current_locality,
              v.version, v.content, v.locality_id, v.locality_snapshot,
              creator.id AS creator_id, creator.name AS creator_name,
              creator.email AS creator_email
       FROM hunt_templates t
       ${localAuthorityJoins}
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
      `SELECT t.key, t.status, t.origin, t.category, t.submitted_version, ${localAuthorityColumns},
              (SELECT jsonb_build_object('id',l.id,'countryCode',l.country_code,
                'countryDisplayName',c.display_name,'name',l.name,'administrativeContext',l.administrative_context,
                'latitude',l.latitude,'longitude',l.longitude,'active',l.active)
               FROM localities l JOIN countries c ON c.code=l.country_code WHERE l.id=v.locality_id) AS current_locality,
              v.version, v.content, v.locality_id, v.locality_snapshot,
              creator.id AS creator_id, creator.name AS creator_name,
              creator.email AS creator_email
       FROM hunt_templates t
       ${localAuthorityJoins}
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

  async findApprovedLocalReviewByKey(key: string) {
    const { rows } = await pool.query(`SELECT t.*, ${localAuthorityColumns},
      (SELECT max(version) FROM hunt_template_versions WHERE template_id=t.id) AS candidate_version,
      authority.content, authority.locality_id, authority.locality_snapshot,
      creator.id AS creator_id, creator.name AS creator_name, creator.email AS creator_email,
      current_locality.id AS current_locality_id, current_locality.country_code,
      current_locality.name AS current_name, current_locality.administrative_context,
      current_locality.latitude, current_locality.longitude, current_locality.active,
      country.display_name AS country_display_name
      FROM hunt_templates t ${localAuthorityJoins}
      JOIN users creator ON creator.id=t.created_by_user_id
      LEFT JOIN localities current_locality ON current_locality.id=authority.locality_id
      LEFT JOIN countries country ON country.code=current_locality.country_code
      WHERE t.key=$1 AND t.origin='creator' AND t.category='local'`, [key]);
    const row = rows[0];
    if (!row) return null;
    const state = mapLocalApproval(row);
    if (state.localApproval.authority === 'none') throw new TemplateEligibilityConflictError();
    return { ...mapAdminReview({ ...row, version: row.authority_version ?? null }), ...state,
      candidateStatus: row.status, candidateVersion: row.candidate_version, submittedVersion: row.submitted_version,
      currentLocality: row.current_locality_id == null ? null : {
        id: row.current_locality_id, countryCode: row.country_code, countryDisplayName: row.country_display_name,
        name: row.current_name, administrativeContext: row.administrative_context,
        latitude: row.latitude, longitude: row.longitude, active: row.active,
      },
    };
  },

  async suspendLocal(key: string, expectedVersion: number, actor: string, reason: string) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM users WHERE id=$1 FOR SHARE', [actor]);
      const admin = await client.query(`SELECT 1 FROM user_roles
        WHERE user_id=$1 AND role='admin' FOR SHARE`, [actor]);
      const account = (await client.query("SELECT account_status,is_guest FROM users WHERE id=$1", [actor])).rows[0];
      if (!admin.rowCount || !account || account.account_status !== 'active' || account.is_guest)
        throw new TemplateLocalityError('forbidden', 403);
      const row = (await client.query(`SELECT * FROM hunt_templates
        WHERE key=$1 AND origin='creator' FOR UPDATE`, [key])).rows[0];
      if (!row) throw new HuntTemplateNotFoundError();
      const authority = row.local_approved_version ?? (row.status === 'approved' ? row.submitted_version : null);
      if (row.category !== 'local' || row.local_suspended_at != null || authority == null || authority !== expectedVersion
        || !(await client.query('SELECT 1 FROM hunt_template_versions WHERE template_id=$1 AND version=$2', [row.id, authority])).rowCount) {
        throw new TemplateEligibilityConflictError();
      }
      if (typeof reason !== 'string' || !reason.trim() || reason.length > 1000) throw new TemplateLocalityError('invalid_input', 400);
      const result = await client.query(`UPDATE hunt_templates SET local_suspended_at=now(),
        local_suspended_by_user_id=$2, local_suspension_reason=$3, local_suspended_version=$4,
        updated_at=now() WHERE id=$1 RETURNING *`, [row.id, actor, reason.trim(), authority]);
      await client.query('COMMIT');
      return { key, localApprovedVersion: result.rows[0].local_approved_version,
        localSuspension: mapLocalApproval(result.rows[0]).localSuspension };
    } catch (error) {
      await client.query('ROLLBACK'); throw error;
    } finally { client.release(); }
  },

  async list(): Promise<HuntTemplateWithLatestVersion[]> {
    const { rows } = await pool.query(
      `SELECT t.*, ${localAuthorityColumns}, latest.version AS latest_version,
              latest.created_at AS latest_version_created_at
       FROM hunt_templates t
       ${localAuthorityJoins}
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
  ...(row.category === 'local' ? { ...mapLocalApproval(row), currentLocality: row.current_locality ?? null } : {}),
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
