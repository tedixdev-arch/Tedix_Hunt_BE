import { createHash } from 'node:crypto';
import {
  SIGNAL_CLUJ_NAPOCA_V1_CHECKPOINTS_SHA256,
  signalClujNapocaV1,
} from '../../domain/templates/signalClujNapocaV1.js';
import type { Migration } from './types.js';

export const signalClujNapocaV1Migration: Migration = {
  id: '017_signal_cluj_napoca_v1',
  async up(client) {
    const digest = createHash('sha256')
      .update(JSON.stringify(signalClujNapocaV1.checkpoints))
      .digest('hex');
    if (digest !== SIGNAL_CLUJ_NAPOCA_V1_CHECKPOINTS_SHA256) {
      throw new Error(`Signal: Cluj Napoca v1 checkpoint digest mismatch: ${digest}`);
    }

    // Deliberately use plain inserts: an unexpected existing identity or v1 must fail rather
    // than silently replacing immutable platform content.
    const identity = await client.query<{ id: string }>(
      `INSERT INTO hunt_templates (key, origin, created_by_user_id, status)
       VALUES ($1, 'platform', NULL, 'approved')
       RETURNING id`,
      [signalClujNapocaV1.key],
    );
    await client.query(
      `INSERT INTO hunt_template_versions
         (template_id, version, content, origin, created_by_user_id)
       VALUES ($1, $2, $3, 'platform', NULL)`,
      [identity.rows[0].id, signalClujNapocaV1.version, signalClujNapocaV1],
    );
  },
};

export default signalClujNapocaV1Migration;
