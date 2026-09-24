import type { Migration } from './types.js';

export const professionalActivationPurposesMigration: Migration = {
  id: '012_professional_activation_purposes',
  async up(client) {
    await client.query(`
      ALTER TABLE professional_activation_tokens
        DROP CONSTRAINT professional_activation_tokens_purpose_check;
      ALTER TABLE professional_activation_tokens
        ADD CONSTRAINT professional_activation_tokens_purpose_check
        CHECK (purpose IN ('admin_activation', 'organizer_activation', 'creator_activation'))
        NOT VALID;
      ALTER TABLE professional_activation_tokens
        VALIDATE CONSTRAINT professional_activation_tokens_purpose_check;
    `);
  },
};

export default professionalActivationPurposesMigration;
