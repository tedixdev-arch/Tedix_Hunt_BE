import type { Migration } from './types.js';

export const professionalActivationTokensMigration: Migration = {
  id: '011_professional_activation_tokens',
  async up(client) {
    await client.query(`
      CREATE TABLE professional_activation_tokens (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        purpose TEXT NOT NULL CHECK (purpose IN ('admin_activation')),
        expires_at TIMESTAMPTZ NOT NULL,
        consumed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        created_by UUID NOT NULL REFERENCES users(id)
      );

      CREATE UNIQUE INDEX professional_activation_tokens_active_user_purpose_key
        ON professional_activation_tokens (user_id, purpose)
        WHERE consumed_at IS NULL;
    `);
  },
};

export default professionalActivationTokensMigration;
