import type { Migration } from './types.js';
export default {
  id: '036_hunt_invitation',
  async up(client) {
    await client.query('ALTER TABLE hunts ADD COLUMN invitation_enabled BOOLEAN NOT NULL DEFAULT true');
  },
} satisfies Migration;
