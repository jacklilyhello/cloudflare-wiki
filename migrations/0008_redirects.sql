-- Old Workers omit origin, so their canonical and move-created routes remain
-- compatible. Origin describes creation, not whether an alias is editable.
ALTER TABLE page_routes ADD COLUMN origin TEXT NOT NULL DEFAULT 'automatic'
  CHECK (origin IN ('automatic','manual'));

CREATE TABLE route_registries (
  language TEXT PRIMARY KEY CHECK (language IN ('zh','en')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 9007199254740991),
  updated_at TEXT NOT NULL
);
INSERT INTO route_registries(language,updated_at)
VALUES('zh',strftime('%Y-%m-%dT%H:%M:%fZ','now')),('en',strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- Extend only the insert validator; immutable audit rows are never rewritten.
DROP TRIGGER audit_records_validate;
CREATE TRIGGER audit_records_validate BEFORE INSERT ON audit_records
BEGIN
  SELECT RAISE(ABORT,'audit_invalid') WHERE NOT coalesce(CASE NEW.category
    WHEN 'page' THEN
      NEW.action IN ('page.create','page.save_draft','page.publish','page.unpublish','page.move','page.delete','page.restore_revision','page.restore_deleted')
      AND NEW.language IS NOT NULL AND NEW.source_page_event_id IS NOT NULL
      AND json_type(NEW.details_json)='object'
      AND json_type(NEW.details_json,'$.revisionId') IN ('text','null')
      AND json_type(NEW.details_json,'$.fromPath') IN ('text','null')
      AND json_type(NEW.details_json,'$.toPath') IN ('text','null')
      AND json_remove(NEW.details_json,'$.revisionId','$.fromPath','$.toPath')='{}'
    WHEN 'navigation' THEN
      NEW.action='navigation.save' AND NEW.language IS NOT NULL AND NEW.subject_id=NEW.language
      AND NEW.origin='current' AND NEW.source_page_event_id IS NULL
      AND json_type(NEW.details_json)='object'
      AND json_extract(NEW.details_json,'$.previousMode') IN ('automatic','custom')
      AND json_extract(NEW.details_json,'$.mode') IN ('automatic','custom')
      AND json_type(NEW.details_json,'$.nodeCount')='integer'
      AND json_extract(NEW.details_json,'$.nodeCount') BETWEEN 0 AND 300
      AND json_remove(NEW.details_json,'$.previousMode','$.mode','$.nodeCount')='{}'
    WHEN 'administrator' THEN
      NEW.language IS NULL AND NEW.subject_id='1' AND NEW.origin='current' AND NEW.source_page_event_id IS NULL
      AND ((NEW.action='administrator.initialize' AND json_type(NEW.details_json)='null') OR
        (NEW.action='administrator.credentials' AND json_type(NEW.details_json)='object'
          AND json_type(NEW.details_json,'$.usernameChanged') IN ('true','false')
          AND json_type(NEW.details_json,'$.passwordChanged') IN ('true','false')
          AND json_remove(NEW.details_json,'$.usernameChanged','$.passwordChanged')='{}'))
    WHEN 'redirect' THEN
      NEW.language IS NOT NULL AND NEW.subject_id=NEW.language
      AND NEW.origin='current' AND NEW.source_page_event_id IS NULL
      AND json_type(NEW.details_json)='object'
      AND json_remove(NEW.details_json,'$.sourcePath','$.previousPath','$.targetTranslationId','$.previousTarget')='{}'
      AND CASE NEW.action
        WHEN 'redirect.create' THEN
          json_type(NEW.details_json,'$.sourcePath')='text'
          AND json_type(NEW.details_json,'$.targetTranslationId')='text'
          AND json_type(NEW.details_json,'$.previousPath')='null'
          AND json_type(NEW.details_json,'$.previousTarget')='null'
        WHEN 'redirect.update' THEN
          json_type(NEW.details_json,'$.sourcePath')='text'
          AND json_type(NEW.details_json,'$.targetTranslationId')='text'
          AND json_type(NEW.details_json,'$.previousPath')='text'
          AND json_type(NEW.details_json,'$.previousTarget')='text'
        WHEN 'redirect.delete' THEN
          json_type(NEW.details_json,'$.sourcePath')='null'
          AND json_type(NEW.details_json,'$.targetTranslationId')='null'
          AND json_type(NEW.details_json,'$.previousPath')='text'
          AND json_type(NEW.details_json,'$.previousTarget')='text'
        ELSE 0 END
      AND (json_type(NEW.details_json,'$.sourcePath')='null' OR length(json_extract(NEW.details_json,'$.sourcePath')) BETWEEN 1 AND 240)
      AND (json_type(NEW.details_json,'$.previousPath')='null' OR length(json_extract(NEW.details_json,'$.previousPath')) BETWEEN 1 AND 240)
      AND (json_type(NEW.details_json,'$.targetTranslationId')='null' OR length(json_extract(NEW.details_json,'$.targetTranslationId')) BETWEEN 1 AND 128)
      AND (json_type(NEW.details_json,'$.previousTarget')='null' OR length(json_extract(NEW.details_json,'$.previousTarget')) BETWEEN 1 AND 128)
    ELSE 0
  END,0);
END;

-- Protect current canonical paths even for deleted or unpublished pages.
CREATE TRIGGER page_routes_canonical_update BEFORE UPDATE ON page_routes
WHEN EXISTS(SELECT 1 FROM page_translations t WHERE t.language=OLD.language AND t.slug=OLD.path)
BEGIN
  SELECT RAISE(ABORT,'redirect_canonical');
END;
CREATE TRIGGER page_routes_canonical_delete BEFORE DELETE ON page_routes
WHEN EXISTS(SELECT 1 FROM page_translations t WHERE t.language=OLD.language AND t.slug=OLD.path)
BEGIN
  SELECT RAISE(ABORT,'redirect_canonical');
END;
CREATE TRIGGER page_routes_identity BEFORE UPDATE ON page_routes
WHEN NEW.language IS NOT OLD.language OR NEW.origin IS NOT OLD.origin OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT,'redirect_identity');
END;

-- Version advancement and its audit record share one ordered trigger body.
CREATE TRIGGER page_routes_insert AFTER INSERT ON page_routes
BEGIN
  UPDATE route_registries SET version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE language=NEW.language;
  INSERT INTO audit_records(category,subject_id,subject_version,action,language,origin,details_json,created_at)
  SELECT 'redirect',NEW.language,version,'redirect.create',NEW.language,'current',
    json_object('sourcePath',NEW.path,'previousPath',NULL,'targetTranslationId',NEW.translation_id,'previousTarget',NULL),
    updated_at FROM route_registries WHERE language=NEW.language AND NEW.origin='manual';
END;
CREATE TRIGGER page_routes_update AFTER UPDATE OF path,translation_id ON page_routes
WHEN NEW.path IS NOT OLD.path OR NEW.translation_id IS NOT OLD.translation_id
BEGIN
  UPDATE route_registries SET version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE language=NEW.language;
  INSERT INTO audit_records(category,subject_id,subject_version,action,language,origin,details_json,created_at)
  SELECT 'redirect',NEW.language,version,'redirect.update',NEW.language,'current',
    json_object('sourcePath',NEW.path,'previousPath',OLD.path,'targetTranslationId',NEW.translation_id,'previousTarget',OLD.translation_id),
    updated_at FROM route_registries WHERE language=NEW.language;
END;
CREATE TRIGGER page_routes_delete AFTER DELETE ON page_routes
BEGIN
  UPDATE route_registries SET version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE language=OLD.language;
  INSERT INTO audit_records(category,subject_id,subject_version,action,language,origin,details_json,created_at)
  SELECT 'redirect',OLD.language,version,'redirect.delete',OLD.language,'current',
    json_object('sourcePath',NULL,'previousPath',OLD.path,'targetTranslationId',NULL,'previousTarget',OLD.translation_id),
    updated_at FROM route_registries WHERE language=OLD.language;
END;

-- Moving back to an existing alias need not insert a route, but changes which
-- row is canonical and must invalidate a previously loaded registry version.
CREATE TRIGGER page_translations_route_version AFTER UPDATE OF slug ON page_translations
WHEN NEW.slug IS NOT OLD.slug
BEGIN
  UPDATE route_registries SET version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE language=NEW.language;
END;
