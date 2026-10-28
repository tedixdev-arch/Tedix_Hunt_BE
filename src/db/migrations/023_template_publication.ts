import type { Migration } from './types.js';

const migration: Migration = {
  id: '023_template_publication',
  async up(client) {
    await client.query(`
      -- A candidate's lifecycle is independent of the last approved Universal artifact.
      ALTER TABLE hunt_templates
        ADD COLUMN published_version INTEGER,
        ADD CONSTRAINT hunt_templates_published_category_check CHECK (
          published_version IS NULL OR (category IS NOT NULL AND category = 'universal' AND origin = 'creator')
        ),
        ADD CONSTRAINT hunt_templates_published_version_fkey
          FOREIGN KEY (id, published_version)
          REFERENCES hunt_template_versions(template_id, version) ON DELETE RESTRICT;

      -- Preserve exactly the products visible under C3/C4, without inventing approval evidence.
      UPDATE hunt_templates t SET published_version = t.submitted_version
      WHERE t.category = 'universal' AND t.origin = 'creator' AND t.status = 'approved'
        AND EXISTS (SELECT 1 FROM hunt_template_reviews r
          WHERE r.template_id = t.id AND r.version = t.submitted_version
            AND r.decision = 'approved' AND r.reviewer_user_id <> t.created_by_user_id);

      CREATE FUNCTION enforce_template_publication() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'UPDATE' AND OLD.published_version IS NOT NULL AND NEW.published_version IS NULL THEN
          RAISE EXCEPTION 'Publication cannot be withdrawn by candidate authoring' USING ERRCODE = '23514';
        END IF;
        IF NEW.published_version IS NOT NULL AND
           (TG_OP = 'INSERT' OR NEW.published_version IS DISTINCT FROM OLD.published_version) AND NOT EXISTS (
          SELECT 1 FROM hunt_templates t JOIN hunt_template_reviews r
            ON r.template_id = t.id AND r.version = t.published_version
          WHERE t.id = NEW.id AND t.status = 'approved' AND t.submitted_version = t.published_version
            AND r.decision = 'approved' AND r.reviewer_user_id <> t.created_by_user_id
        ) THEN
          RAISE EXCEPTION 'Publication requires exact independent approval' USING ERRCODE = '23514';
        END IF;
        RETURN NULL;
      END;
      $$;
      -- Deferred because approval updates the pin and inserts its review in one transaction.
      CREATE CONSTRAINT TRIGGER hunt_templates_publication_evidence
        AFTER INSERT OR UPDATE ON hunt_templates DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION enforce_template_publication();

      CREATE FUNCTION preserve_classified_template_review() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM hunt_templates WHERE id = OLD.template_id AND category IS NOT NULL) THEN
          RAISE EXCEPTION 'Classified review history is immutable' USING ERRCODE = '23514';
        END IF;
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER hunt_template_reviews_immutable_classified
        BEFORE UPDATE OR DELETE ON hunt_template_reviews
        FOR EACH ROW EXECUTE FUNCTION preserve_classified_template_review();
    `);
  },
};

export default migration;
