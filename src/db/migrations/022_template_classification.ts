import type { Migration } from './types.js';

export const templateClassificationMigration: Migration = {
  id: '022_template_classification',
  async up(client) {
    await client.query(`
      -- Additive only: NULL remains unclassified, including shipped Signal/starters.
      ALTER TABLE hunt_templates
        ADD COLUMN category TEXT CHECK (category IN ('universal', 'local')),
        ADD COLUMN source_template_id UUID,
        ADD COLUMN source_version INTEGER,
        ADD COLUMN source_creator_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
        ADD COLUMN source_review_decision TEXT,
        ADD CONSTRAINT hunt_templates_classified_owner_check CHECK (
          category IS NULL OR (origin = 'creator' AND created_by_user_id IS NOT NULL)
        ),
        ADD CONSTRAINT hunt_templates_source_check CHECK (
          (source_template_id IS NULL AND source_version IS NULL AND
           source_creator_user_id IS NULL AND source_review_decision IS NULL)
          OR
          (category IS NOT NULL AND category = 'local' AND
           source_template_id IS NOT NULL AND source_template_id <> id AND
           source_version IS NOT NULL AND source_version >= 1 AND
           source_creator_user_id IS NOT NULL AND source_review_decision IS NOT NULL AND
           source_review_decision = 'approved')
        );
      ALTER TABLE hunt_template_versions
        ADD COLUMN category TEXT CHECK (category IN ('universal', 'local'));
      ALTER TABLE hunt_template_reviews
        ADD CONSTRAINT hunt_template_reviews_exact_decision_key UNIQUE (template_id, version, decision);
      ALTER TABLE hunt_templates
        ADD CONSTRAINT hunt_templates_source_version_fkey
          FOREIGN KEY (source_template_id, source_version)
          REFERENCES hunt_template_versions(template_id, version) ON DELETE RESTRICT,
        ADD CONSTRAINT hunt_templates_source_review_fkey
          FOREIGN KEY (source_template_id, source_version, source_review_decision)
          REFERENCES hunt_template_reviews(template_id, version, decision) ON DELETE RESTRICT;
      CREATE INDEX hunt_templates_source_idx ON hunt_templates(source_template_id, source_version)
        WHERE source_template_id IS NOT NULL;
      
      CREATE FUNCTION enforce_template_identity_binding() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE source hunt_templates%ROWTYPE;
      BEGIN
        IF TG_OP = 'UPDATE' THEN
          IF NEW.category IS DISTINCT FROM OLD.category OR
             ROW(NEW.source_template_id, NEW.source_version, NEW.source_creator_user_id, NEW.source_review_decision)
               IS DISTINCT FROM
             ROW(OLD.source_template_id, OLD.source_version, OLD.source_creator_user_id, OLD.source_review_decision) OR
             (OLD.category IS NOT NULL AND
              ROW(NEW.id, NEW.key, NEW.origin, NEW.created_by_user_id) IS DISTINCT FROM
              ROW(OLD.id, OLD.key, OLD.origin, OLD.created_by_user_id)) THEN
            RAISE EXCEPTION 'Template category, classified ownership and source binding are immutable' USING ERRCODE = '23514';
          END IF;
        END IF;
        IF NEW.source_template_id IS NOT NULL THEN
          SELECT * INTO source FROM hunt_templates WHERE id = NEW.source_template_id FOR SHARE;
          IF NOT FOUND OR source.category IS DISTINCT FROM 'universal' OR
             source.created_by_user_id IS DISTINCT FROM NEW.source_creator_user_id THEN
            RAISE EXCEPTION 'Local source must bind an exact Universal and its original Creator' USING ERRCODE = '23514';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER hunt_templates_identity_binding
        BEFORE INSERT OR UPDATE ON hunt_templates
        FOR EACH ROW EXECUTE FUNCTION enforce_template_identity_binding();
      
      CREATE FUNCTION enforce_template_version_binding() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE identity_row hunt_templates%ROWTYPE;
      BEGIN
        IF TG_OP = 'UPDATE' THEN
          IF OLD.category IS NOT NULL OR
             ROW(NEW.category, NEW.template_id) IS DISTINCT FROM ROW(OLD.category, OLD.template_id) THEN
            RAISE EXCEPTION 'Template version classification and classified snapshots are immutable' USING ERRCODE = '23514';
          END IF;
        END IF;
        SELECT * INTO identity_row FROM hunt_templates WHERE id = NEW.template_id FOR SHARE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Template identity does not exist' USING ERRCODE = '23503';
        END IF;
        IF NEW.category IS DISTINCT FROM identity_row.category OR
           (NEW.category IS NOT NULL AND
            ROW(NEW.origin, NEW.created_by_user_id) IS DISTINCT FROM
            ROW(identity_row.origin, identity_row.created_by_user_id)) THEN
          RAISE EXCEPTION 'Template version must match identity category and classified owner' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER hunt_template_versions_identity_binding
        BEFORE INSERT OR UPDATE ON hunt_template_versions
        FOR EACH ROW EXECUTE FUNCTION enforce_template_version_binding();
    `);
  },
};

export default templateClassificationMigration;
