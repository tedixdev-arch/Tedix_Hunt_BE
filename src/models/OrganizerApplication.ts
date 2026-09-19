import { pool } from '../lib/postgres.js';

export type OrganizationType = 'school' | 'ngo' | 'community' | 'other';
export type OrganizerApplicationStatus = 'pending' | 'approved' | 'rejected';

export interface OrganizerApplication {
  id: string;
  name: string;
  email: string;
  organizationName: string;
  organizationType: OrganizationType;
  reason: string;
  phone: string | null;
  status: OrganizerApplicationStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateOrganizerApplicationInput {
  name: string;
  email: string;
  organizationName: string;
  organizationType: OrganizationType;
  reason: string;
  phone: string | null;
}

const mapRow = (row: any): OrganizerApplication => ({
  id: row.id,
  name: row.name,
  email: row.email,
  organizationName: row.organization_name,
  organizationType: row.organization_type,
  reason: row.reason,
  phone: row.phone,
  status: row.status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const OrganizerApplications = {
  async create(input: CreateOrganizerApplicationInput): Promise<OrganizerApplication> {
    const { rows } = await pool.query(
      `INSERT INTO organizer_applications
         (name, email, organization_name, organization_type, reason, phone)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [input.name, input.email, input.organizationName, input.organizationType, input.reason, input.phone],
    );
    return mapRow(rows[0]);
  },

  async findById(id: string): Promise<OrganizerApplication | null> {
    const { rows } = await pool.query(
      'SELECT * FROM organizer_applications WHERE id = $1 LIMIT 1',
      [id],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  },
};
