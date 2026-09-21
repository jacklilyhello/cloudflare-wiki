CREATE TABLE audit_records (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL CHECK (length(category) BETWEEN 1 AND 32 AND category NOT GLOB '*[^a-z]*'),
  subject_id TEXT NOT NULL CHECK (length(subject_id) BETWEEN 1 AND 128),
  subject_version INTEGER NOT NULL CHECK (subject_version > 0),
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 64),
  language TEXT CHECK (language IS NULL OR language IN ('zh','en')),
  origin TEXT NOT NULL CHECK (origin IN ('legacy','current')),
  source_page_event_id TEXT UNIQUE REFERENCES page_events(id),
  details_json TEXT NOT NULL CHECK (json_valid(details_json) AND length(CAST(details_json AS BLOB)) <= 2048),
  created_at TEXT NOT NULL CHECK (coalesce(length(created_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at,0))
);
CREATE INDEX audit_records_category_seq ON audit_records(category,seq DESC);
CREATE INDEX audit_records_action_seq ON audit_records(action,seq DESC);
CREATE INDEX audit_records_language_seq ON audit_records(language,seq DESC);
CREATE INDEX audit_records_subject_seq ON audit_records(subject_id,seq DESC);
CREATE INDEX audit_records_time_seq ON audit_records(created_at,seq DESC);

-- Keep the current closed event schemas in one replaceable validator. A reviewed
-- future migration can extend it without rebuilding immutable historical rows.
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
    ELSE 0
  END,0);
END;

-- Earlier page events have no actor provenance; retain their original time.
INSERT INTO audit_records(category,subject_id,subject_version,action,language,origin,source_page_event_id,details_json,created_at)
SELECT 'page',e.translation_id,e.version,'page.'||e.event_type,t.language,'legacy',e.id,
  json_object('revisionId',e.revision_id,'fromPath',e.from_path,'toPath',e.to_path),e.created_at
FROM page_events e JOIN page_translations t ON t.id=e.translation_id
ORDER BY e.created_at,e.id;

CREATE TRIGGER audit_records_no_update BEFORE UPDATE ON audit_records
BEGIN
  SELECT RAISE(ABORT,'audit_immutable');
END;
CREATE TRIGGER audit_records_no_delete BEFORE DELETE ON audit_records
BEGIN
  SELECT RAISE(ABORT,'audit_immutable');
END;

CREATE TRIGGER audit_page_event AFTER INSERT ON page_events
BEGIN
  INSERT INTO audit_records(category,subject_id,subject_version,action,language,origin,source_page_event_id,details_json,created_at)
  SELECT 'page',NEW.translation_id,NEW.version,'page.'||NEW.event_type,t.language,'current',NEW.id,
    json_object('revisionId',NEW.revision_id,'fromPath',NEW.from_path,'toPath',NEW.to_path),NEW.created_at
  FROM page_translations t WHERE t.id=NEW.translation_id;
END;

-- The tree version advances last, after the replacement nodes are in place.
CREATE TRIGGER audit_navigation_save AFTER UPDATE OF version ON navigation_trees
WHEN NEW.version > OLD.version
BEGIN
  INSERT INTO audit_records(category,subject_id,subject_version,action,language,origin,details_json,created_at)
  VALUES('navigation',NEW.language,NEW.version,'navigation.save',NEW.language,'current',
    json_object('previousMode',OLD.mode,'mode',NEW.mode,'nodeCount',
      (SELECT count(*) FROM navigation_nodes WHERE language=NEW.language)),NEW.updated_at);
END;

CREATE TRIGGER audit_administrator_initialize AFTER INSERT ON administrators
BEGIN
  INSERT INTO audit_records(category,subject_id,subject_version,action,language,origin,details_json,created_at)
  VALUES('administrator',CAST(NEW.id AS TEXT),NEW.auth_version,'administrator.initialize',NULL,'current','null',
    strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at/1000.0,'unixepoch'));
END;

CREATE TRIGGER audit_administrator_credentials AFTER UPDATE OF username,password_hash ON administrators
WHEN NEW.username IS NOT OLD.username OR NEW.password_hash IS NOT OLD.password_hash
BEGIN
  INSERT INTO audit_records(category,subject_id,subject_version,action,language,origin,details_json,created_at)
  VALUES('administrator',CAST(NEW.id AS TEXT),NEW.auth_version,'administrator.credentials',NULL,'current',
    json_object('usernameChanged',json(CASE WHEN NEW.username IS NOT OLD.username THEN 'true' ELSE 'false' END),
      'passwordChanged',json(CASE WHEN NEW.password_hash IS NOT OLD.password_hash THEN 'true' ELSE 'false' END)),
    strftime('%Y-%m-%dT%H:%M:%fZ',NEW.updated_at/1000.0,'unixepoch'));
END;
