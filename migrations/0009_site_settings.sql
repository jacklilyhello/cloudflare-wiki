-- Public presentation values only. Secrets and deployment configuration never
-- belong in this singleton. Existing content and audit records remain intact.
CREATE TABLE site_settings (
  id INTEGER PRIMARY KEY CHECK (id=1),
  version INTEGER NOT NULL DEFAULT 1 CHECK (typeof(version)='integer' AND version BETWEEN 1 AND 9007199254740991),
  zh_name TEXT NOT NULL CHECK (length(zh_name) BETWEEN 1 AND 80 AND length(trim(zh_name))>0),
  zh_description TEXT NOT NULL CHECK (length(zh_description)<=300),
  en_name TEXT NOT NULL CHECK (length(en_name) BETWEEN 1 AND 80 AND length(trim(en_name))>0),
  en_description TEXT NOT NULL CHECK (length(en_description)<=300),
  default_language TEXT NOT NULL CHECK (default_language IN ('zh','en')),
  theme TEXT NOT NULL CHECK (theme IN ('system','light','dark')),
  accent TEXT NOT NULL CHECK (accent IN ('forest','ocean','plum')),
  logo TEXT NOT NULL CHECK (logo IN ('emby','book','none')),
  updated_at TEXT NOT NULL CHECK (coalesce(length(updated_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at)=updated_at,0))
);
INSERT INTO site_settings(id,zh_name,zh_description,en_name,en_description,default_language,theme,accent,logo,updated_at)
VALUES(1,'Emby Wiki','Emby Wiki 技术文档','Emby Wiki','Emby Wiki documentation','zh','system','forest','emby',strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- Extend the existing closed validator without rewriting immutable records.
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
    WHEN 'settings' THEN
      NEW.action='settings.update' AND NEW.language IS NULL AND NEW.subject_id='1'
      AND NEW.origin='current' AND NEW.source_page_event_id IS NULL
      AND json_type(NEW.details_json)='object'
      AND json_type(NEW.details_json,'$.changedFields')='array'
      AND json_remove(NEW.details_json,'$.changedFields')='{}'
      AND json_array_length(NEW.details_json,'$.changedFields') BETWEEN 1 AND 8
      AND NOT EXISTS(SELECT 1 FROM json_each(NEW.details_json,'$.changedFields')
        WHERE type<>'text' OR value NOT IN ('zh.name','zh.description','en.name','en.description','defaultLanguage','theme','accent','logo'))
      AND (SELECT count(DISTINCT value) FROM json_each(NEW.details_json,'$.changedFields'))=json_array_length(NEW.details_json,'$.changedFields')
    ELSE 0
  END,0);
END;

-- Insertion is a migration-only seed; REPLACE cannot reset the singleton.
CREATE TRIGGER site_settings_no_insert BEFORE INSERT ON site_settings
BEGIN
  SELECT RAISE(ABORT,'settings_singleton');
END;
CREATE TRIGGER site_settings_no_delete BEFORE DELETE ON site_settings
BEGIN
  SELECT RAISE(ABORT,'settings_singleton');
END;
CREATE TRIGGER site_settings_version BEFORE UPDATE ON site_settings
BEGIN
  -- Remote D1 parsing requires CASE expressions in triggers to be parenthesized.
  SELECT RAISE(ABORT,'settings_version') WHERE NEW.id IS NOT OLD.id OR
    (CASE WHEN (NEW.zh_name IS NOT OLD.zh_name OR NEW.zh_description IS NOT OLD.zh_description
    OR NEW.en_name IS NOT OLD.en_name OR NEW.en_description IS NOT OLD.en_description
    OR NEW.default_language IS NOT OLD.default_language OR NEW.theme IS NOT OLD.theme
    OR NEW.accent IS NOT OLD.accent OR NEW.logo IS NOT OLD.logo)
      THEN NEW.version IS NOT OLD.version+1
      ELSE NEW.version IS NOT OLD.version OR NEW.updated_at IS NOT OLD.updated_at
    END);
END;
CREATE TRIGGER audit_settings_update AFTER UPDATE ON site_settings
WHEN NEW.zh_name IS NOT OLD.zh_name OR NEW.zh_description IS NOT OLD.zh_description
    OR NEW.en_name IS NOT OLD.en_name OR NEW.en_description IS NOT OLD.en_description
    OR NEW.default_language IS NOT OLD.default_language OR NEW.theme IS NOT OLD.theme
    OR NEW.accent IS NOT OLD.accent OR NEW.logo IS NOT OLD.logo
BEGIN
  INSERT INTO audit_records(category,subject_id,subject_version,action,language,origin,details_json,created_at)
  VALUES('settings','1',NEW.version,'settings.update',NULL,'current',
    json_object('changedFields',json((SELECT json_group_array(value) FROM json_each(json_array(
      CASE WHEN NEW.zh_name IS NOT OLD.zh_name THEN 'zh.name' END,
      CASE WHEN NEW.zh_description IS NOT OLD.zh_description THEN 'zh.description' END,
      CASE WHEN NEW.en_name IS NOT OLD.en_name THEN 'en.name' END,
      CASE WHEN NEW.en_description IS NOT OLD.en_description THEN 'en.description' END,
      CASE WHEN NEW.default_language IS NOT OLD.default_language THEN 'defaultLanguage' END,
      CASE WHEN NEW.theme IS NOT OLD.theme THEN 'theme' END,
      CASE WHEN NEW.accent IS NOT OLD.accent THEN 'accent' END,
      CASE WHEN NEW.logo IS NOT OLD.logo THEN 'logo' END
    )) WHERE value IS NOT NULL))),NEW.updated_at);
END;
