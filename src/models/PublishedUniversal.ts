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
