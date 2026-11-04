import type { Migration } from './types.js';
export const contentLibrarySql = `
CREATE TABLE library_content (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 owner_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 head_version INTEGER NOT NULL CHECK(head_version>=1),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE library_content_revisions (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 content_id UUID NOT NULL REFERENCES library_content(id) ON DELETE RESTRICT,
 version INTEGER NOT NULL CHECK(version>=1),
 status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','submitted','approved','changes_requested','archived')),
 exercise JSONB NOT NULL CHECK(jsonb_typeof(exercise)='object' AND exercise->>'classification' IN ('personal','team') AND NOT exercise ? 'owner' AND NOT exercise ? 'id'),
 category TEXT CHECK(category IS NULL OR category IN ('Mathematics','History','Science','Mixed')),
 curriculum JSONB NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(curriculum)='object'),
 geographic_scope TEXT NOT NULL CHECK(geographic_scope IN ('universal','country','region','city')),
 country_code TEXT REFERENCES countries(code) ON DELETE RESTRICT,
 admin1_code TEXT,
 geographic_id BIGINT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(content_id,version),
 FOREIGN KEY(country_code,admin1_code) REFERENCES geographic_regions(country_code,admin1_code) ON DELETE RESTRICT,
 FOREIGN KEY(geographic_id,country_code) REFERENCES geographic_cities(geoname_id,country_code) ON DELETE RESTRICT,
 CHECK((geographic_scope='universal' AND country_code IS NULL AND admin1_code IS NULL AND geographic_id IS NULL)
 OR (geographic_scope='country' AND country_code IS NOT NULL AND admin1_code IS NULL AND geographic_id IS NULL)
 OR (geographic_scope='region' AND country_code IS NOT NULL AND admin1_code IS NOT NULL AND geographic_id IS NULL)
 OR (geographic_scope='city' AND country_code IS NOT NULL AND admin1_code IS NULL AND geographic_id IS NOT NULL))
);
ALTER TABLE library_content ADD FOREIGN KEY(id,head_version) REFERENCES library_content_revisions(content_id,version) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX library_content_owner_idx ON library_content(owner_id,id);
CREATE INDEX library_content_classification_idx ON library_content_revisions((exercise->>'classification'),(exercise->>'type'),category,status);
CREATE INDEX library_content_geography_idx ON library_content_revisions(country_code,admin1_code,geographic_id);
CREATE INDEX library_content_curriculum_idx ON library_content_revisions USING gin(curriculum);
CREATE FUNCTION protect_library_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Content revisions cannot be deleted' USING ERRCODE='23514'; END IF;
 IF (to_jsonb(NEW)-'status') IS DISTINCT FROM (to_jsonb(OLD)-'status') OR (OLD.status<>'draft' AND NEW.status='draft') THEN
 RAISE EXCEPTION 'Content revisions are immutable; append a revision' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER library_revision_immutable BEFORE UPDATE OR DELETE ON library_content_revisions FOR EACH ROW EXECUTE FUNCTION protect_library_revision();
CREATE FUNCTION protect_library_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.id<>OLD.id OR NEW.owner_id<>OLD.owner_id OR NEW.created_at<>OLD.created_at OR NEW.head_version<>OLD.head_version+1 THEN
 RAISE EXCEPTION 'Content ownership is immutable and heads advance one revision' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER library_identity_immutable BEFORE UPDATE ON library_content FOR EACH ROW EXECUTE FUNCTION protect_library_identity();
`;
export default {id:'042_content_library', async up(client) {await client.query(contentLibrarySql);}} satisfies Migration;
