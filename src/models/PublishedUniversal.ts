import { HuntTemplateKeyConflictError } from './HuntTemplate.js';
import { isTemplateContent, normalizeTemplateKey } from '../domain/creatorTemplates.js';
import { pool } from '../lib/postgres.js';

export interface PublishedUniversal {
  id: string;
  key: string;
  displayName: string;
  theme: string;
  creator: { id: string; name: string | null };
  publishedReference: { templateId: string; version: number };
}

// Approval's submitted_version pin is the sole publication authority. The exact
// independent decision is required; historical status alone never grants reuse.
const publishedQuery = `
  SELECT t.id, t.key, v.version, v.content,
         creator.id AS creator_id, creator.name AS creator_name
  FROM hunt_templates t
  JOIN hunt_template_versions v
    ON v.template_id = t.id AND v.version = t.submitted_version
  JOIN hunt_template_reviews r
    ON r.template_id = t.id AND r.version = t.submitted_version
   AND r.decision = 'approved' AND r.reviewer_user_id <> t.created_by_user_id
  JOIN users creator ON creator.id = t.created_by_user_id
  WHERE t.category = 'universal' AND t.origin = 'creator' AND t.status = 'approved'`;

const project = (row: any): PublishedUniversal => ({
  id: row.id,
  key: row.key,
  displayName: row.content.displayName,
  theme: row.content.theme,
  creator: { id: row.creator_id, name: row.creator_name },
  publishedReference: { templateId: row.id, version: row.version },
});

export const PublishedUniversals = {
  async list(): Promise<PublishedUniversal[]> {
    const { rows } = await pool.query(`${publishedQuery} ORDER BY t.key`);
    return rows.map(project);
  },
  async findByKey(key: string): Promise<(PublishedUniversal & { content: unknown }) | null> {
    const { rows } = await pool.query(`${publishedQuery} AND t.key = $1`, [key]);
    return rows[0] ? { ...project(rows[0]), content: rows[0].content } : null;
  },
};

export class UniversalCopyForbiddenError extends Error {}
export class UniversalCopySourceNotFoundError extends Error {}
export class UniversalCopyStaleError extends Error {}

export async function copyPublishedUniversal(
  sourceKey: string,
  expected: { templateId: string; version: number },
  key: string,
  creatorUserId: string,
) {
  if (normalizeTemplateKey(key) !== key) throw new Error('Invalid destination key');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Recheck persisted capability inside the same transaction. Share locks prevent
    // account blocking/retirement and role revocation until the copy commits.
    const actor = await client.query(`SELECT u.id FROM users u
      JOIN user_roles ur ON ur.user_id=u.id AND ur.role='creator'
      WHERE u.id=$1 AND u.account_status='active' AND u.is_guest=false
      FOR SHARE OF u, ur`, [creatorUserId]);
    if (!actor.rows[0]) throw new UniversalCopyForbiddenError();
    // Lock the identity first, then resolve in a fresh statement snapshot after any
    // publication writer commits. Never resolve MAX(version) or a historical pin.
    const source = await client.query('SELECT id FROM hunt_templates WHERE key=$1 FOR UPDATE', [sourceKey]);
    if (!source.rows[0]) throw new UniversalCopySourceNotFoundError();
    const resolved = await client.query(`${publishedQuery} AND t.id=$1 FOR SHARE OF r, v`, [source.rows[0].id]);
    const row = resolved.rows[0];
    if (!row) throw new UniversalCopySourceNotFoundError();
    if (row.id !== expected.templateId || row.version !== expected.version) throw new UniversalCopyStaleError();
    const content = { ...row.content, key, version: 1 };
    if (!isTemplateContent(content, key, 1)) throw new Error('Invalid published content');
    const inserted = await client.query(`INSERT INTO hunt_templates
      (key, origin, category, status, created_by_user_id,
       source_template_id, source_version, source_creator_user_id, source_review_decision)
      VALUES ($1, 'creator', 'local', 'draft', $2, $3, $4, $5, 'approved') RETURNING id`,
    [key, creatorUserId, row.id, row.version, row.creator_id]);
    await client.query(`INSERT INTO hunt_template_versions
      (template_id, version, content, origin, category, created_by_user_id)
      VALUES ($1, 1, $2, 'creator', 'local', $3)`, [inserted.rows[0].id, content, creatorUserId]);
    await client.query('COMMIT');
    return { key, version: 1, status: 'draft', origin: 'creator', category: 'local', content };
  } catch (error) {
    await client.query('ROLLBACK');
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
      throw new HuntTemplateKeyConflictError();
    }
    throw error;
  } finally { client.release(); }
}
