-- Files use immutable object descriptors and deferred ownership references so
-- preparing an entry without all of its descriptors cannot commit.
CREATE TABLE file_library (
  id INTEGER PRIMARY KEY CHECK(id=1),
  version INTEGER NOT NULL CHECK(typeof(version)='integer' AND version BETWEEN 1 AND 9007199254740991),
  updated_at TEXT NOT NULL CHECK(coalesce(length(updated_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at)=updated_at,0))
);
INSERT INTO file_library VALUES(1,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
CREATE TABLE file_entries (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=36 AND length(replace(id,'-',''))=32 AND id GLOB '????????-????-4???-[89ab]???-????????????' AND id NOT GLOB '*[^0-9a-f-]*'),
  parent_id TEXT REFERENCES file_entries(id),
  kind TEXT NOT NULL CHECK(kind IN ('file','folder')),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200 AND length(trim(name))>0 AND name NOT IN ('.','..') AND instr(name,'/')=0 AND instr(name,char(92))=0),
  name_key TEXT NOT NULL CHECK(length(name_key) BETWEEN 1 AND 1000),
  version INTEGER NOT NULL CHECK(typeof(version)='integer' AND version BETWEEN 1 AND 9007199254740991),
  state TEXT NOT NULL CHECK(state IN ('pending','ready','abandoned')),
  thumbnail_state TEXT NOT NULL CHECK(thumbnail_state IN ('none','pending','ready','abandoned')),
  alt_zh TEXT NOT NULL DEFAULT '' CHECK(length(alt_zh)<=500),
  alt_en TEXT NOT NULL DEFAULT '' CHECK(length(alt_en)<=500),
  source_object_id TEXT,
  thumbnail_object_id TEXT,
  upload_auth_version INTEGER,
  upload_expires_at TEXT,
  published_at TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL CHECK(coalesce(length(created_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at,0)),
  updated_at TEXT NOT NULL CHECK(coalesce(length(updated_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at)=updated_at,0)),
  CHECK(parent_id IS NULL OR parent_id<>id),
  CHECK((kind='folder' AND state='ready' AND source_object_id IS NULL AND thumbnail_object_id IS NULL AND thumbnail_state='none' AND upload_auth_version IS NULL AND upload_expires_at IS NULL AND published_at IS NULL AND alt_zh='' AND alt_en='') OR
    (kind='file' AND source_object_id IS NOT NULL AND typeof(upload_auth_version)='integer' AND upload_auth_version BETWEEN 1 AND 9007199254740991 AND coalesce(length(upload_expires_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',upload_expires_at)=upload_expires_at,0))),
  CHECK((thumbnail_state='none' AND thumbnail_object_id IS NULL) OR (thumbnail_state<>'none' AND thumbnail_object_id IS NOT NULL)),
  CHECK(published_at IS NULL OR (kind='file' AND state='ready' AND deleted_at IS NULL AND thumbnail_state<>'pending' AND coalesce(length(published_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',published_at)=published_at,0))),
  CHECK(deleted_at IS NULL OR (state='ready' AND published_at IS NULL AND thumbnail_state<>'pending' AND coalesce(length(deleted_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',deleted_at)=deleted_at,0))),
  CHECK(state<>'abandoned' OR thumbnail_state IN ('none','abandoned')),
  FOREIGN KEY(id,source_object_id) REFERENCES file_objects(file_id,id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(id,thumbnail_object_id) REFERENCES file_objects(file_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX file_entries_siblings ON file_entries(coalesce(parent_id,''),name_key) WHERE deleted_at IS NULL AND state<>'abandoned';
CREATE INDEX file_entries_parent ON file_entries(parent_id);
CREATE INDEX file_entries_list ON file_entries(name_key,id);
CREATE TABLE file_objects (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=36 AND length(replace(id,'-',''))=32 AND id GLOB '????????-????-4???-[89ab]???-????????????' AND id NOT GLOB '*[^0-9a-f-]*'),
  file_id TEXT NOT NULL REFERENCES file_entries(id),
  role TEXT NOT NULL CHECK(role IN ('source','thumbnail')),
  object_key TEXT NOT NULL UNIQUE CHECK(object_key='files/'||id),
  receipt_token TEXT NOT NULL CHECK(length(receipt_token)=64 AND receipt_token NOT GLOB '*[^0-9a-f]*'),
  expected_bytes INTEGER NOT NULL CHECK(typeof(expected_bytes)='integer' AND expected_bytes BETWEEN 1 AND 20971520),
  expected_sha256 TEXT NOT NULL CHECK(length(expected_sha256)=64 AND expected_sha256 NOT GLOB '*[^0-9a-f]*'),
  mime_hint TEXT NOT NULL CHECK(mime_hint IN ('image/png','image/jpeg','image/webp','application/octet-stream')),
  verified_at TEXT,
  r2_version TEXT,
  mime TEXT,
  width INTEGER,
  height INTEGER,
  UNIQUE(file_id,id), UNIQUE(file_id,role),
  CHECK(mime_hint='application/octet-stream' OR expected_bytes<=10485760),
  CHECK(role='source' OR (mime_hint<>'application/octet-stream' AND expected_bytes<=262144)),
  CHECK((verified_at IS NULL AND r2_version IS NULL AND mime IS NULL AND width IS NULL AND height IS NULL) OR
    (coalesce(length(verified_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',verified_at)=verified_at,0) AND r2_version IS NOT NULL AND mime IS NOT NULL AND mime=mime_hint AND length(r2_version) BETWEEN 1 AND 256 AND
      ((role='source' AND mime='application/octet-stream' AND width IS NULL AND height IS NULL) OR
       (mime IN ('image/png','image/jpeg','image/webp') AND mime_hint<>'application/octet-stream' AND typeof(width)='integer' AND typeof(height)='integer' AND width BETWEEN 1 AND 25000000 AND height BETWEEN 1 AND 25000000 AND width*height<=25000000 AND (role='source' OR (width<=320 AND height<=320))))))
);

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
    WHEN 'file' THEN
      NEW.action IN ('file.create_folder','file.prepare','file.finalize','file.thumbnail','file.rename','file.move','file.alt','file.publish','file.unpublish','file.delete','file.restore','file.abandon')
      AND NEW.language IS NULL AND NEW.origin='current' AND NEW.source_page_event_id IS NULL
      AND length(NEW.subject_id)=36 AND length(replace(NEW.subject_id,'-',''))=32 AND NEW.subject_id GLOB '????????-????-4???-[89ab]???-????????????' AND NEW.subject_id NOT GLOB '*[^0-9a-f-]*'
      AND typeof(NEW.subject_version)='integer' AND NEW.subject_version BETWEEN 1 AND 9007199254740991
      AND json_type(NEW.details_json)='object'
      AND json_type(NEW.details_json,'$.changedFields')='array'
      AND json_remove(NEW.details_json,'$.changedFields')='{}'
      AND json_array_length(NEW.details_json,'$.changedFields') BETWEEN 1 AND 8
      AND NOT EXISTS(SELECT 1 FROM json_each(NEW.details_json,'$.changedFields')
        WHERE type<>'text' OR value NOT IN ('name','parentId','alt.zh','alt.en','state','thumbnailState','visibility','deletedAt'))
      AND (SELECT count(DISTINCT value) FROM json_each(NEW.details_json,'$.changedFields'))=json_array_length(NEW.details_json,'$.changedFields')
    ELSE 0
  END,0);
END;

CREATE TRIGGER file_library_no_insert BEFORE INSERT ON file_library BEGIN SELECT RAISE(ABORT,'files_library'); END;
CREATE TRIGGER file_library_no_delete BEFORE DELETE ON file_library BEGIN SELECT RAISE(ABORT,'files_library'); END;
CREATE TRIGGER file_library_version BEFORE UPDATE ON file_library
BEGIN SELECT RAISE(ABORT,'files_library') WHERE NEW.id IS NOT OLD.id OR NEW.version IS NOT OLD.version+1; END;
CREATE TRIGGER file_entries_no_delete BEFORE DELETE ON file_entries BEGIN SELECT RAISE(ABORT,'files_immutable'); END;
CREATE TRIGGER file_entries_insert_guard BEFORE INSERT ON file_entries
BEGIN
  SELECT RAISE(ABORT,'files_initial') WHERE NEW.version<>1 OR NEW.published_at IS NOT NULL OR NEW.deleted_at IS NOT NULL OR (NEW.kind='file' AND (NEW.state<>'pending' OR NEW.thumbnail_state NOT IN ('none','pending'))) OR EXISTS(SELECT 1 FROM file_entries WHERE id=NEW.id);
  SELECT RAISE(ABORT,'files_parent') WHERE NEW.parent_id IS NOT NULL AND NEW.deleted_at IS NULL AND NEW.state<>'abandoned' AND NOT EXISTS(SELECT 1 FROM file_entries p WHERE p.id=NEW.parent_id AND p.kind='folder' AND p.state='ready' AND p.deleted_at IS NULL);
  SELECT RAISE(ABORT,'files_depth') WHERE EXISTS(
    WITH RECURSIVE ancestors(id,parent_id,depth) AS (
      SELECT id,parent_id,1 FROM file_entries WHERE id=NEW.parent_id
      UNION ALL SELECT p.id,p.parent_id,a.depth+1 FROM file_entries p JOIN ancestors a ON p.id=a.parent_id WHERE a.depth<=8
    ) SELECT 1 FROM ancestors WHERE id=NEW.id OR depth>8 OR (NEW.kind='folder' AND depth>=8)
  );
  SELECT RAISE(ABORT,'files_name') WHERE NEW.deleted_at IS NULL AND NEW.state<>'abandoned' AND EXISTS(SELECT 1 FROM file_entries e WHERE e.id<>NEW.id AND e.parent_id IS NEW.parent_id AND e.name_key=NEW.name_key AND e.deleted_at IS NULL AND e.state<>'abandoned');
END;
CREATE TRIGGER file_entries_update_guard BEFORE UPDATE ON file_entries
BEGIN
  SELECT RAISE(ABORT,'files_immutable') WHERE NEW.id IS NOT OLD.id OR NEW.kind IS NOT OLD.kind OR NEW.created_at IS NOT OLD.created_at OR NEW.source_object_id IS NOT OLD.source_object_id OR NEW.thumbnail_object_id IS NOT OLD.thumbnail_object_id OR NEW.upload_auth_version IS NOT OLD.upload_auth_version OR NEW.upload_expires_at IS NOT OLD.upload_expires_at OR (NEW.name IS OLD.name AND NEW.name_key IS NOT OLD.name_key);
  SELECT RAISE(ABORT,'files_version') WHERE (CASE WHEN (NEW.name IS NOT OLD.name OR NEW.parent_id IS NOT OLD.parent_id OR NEW.alt_zh IS NOT OLD.alt_zh OR NEW.alt_en IS NOT OLD.alt_en OR NEW.state IS NOT OLD.state OR NEW.thumbnail_state IS NOT OLD.thumbnail_state OR NEW.published_at IS NOT OLD.published_at OR NEW.deleted_at IS NOT OLD.deleted_at) THEN NEW.version IS NOT OLD.version+1 ELSE NEW.version IS NOT OLD.version OR NEW.updated_at IS NOT OLD.updated_at END);
  SELECT RAISE(ABORT,'files_state') WHERE (OLD.state='abandoned' AND NEW.version<>OLD.version) OR (OLD.state='ready' AND NEW.state<>'ready') OR (OLD.state='pending' AND (NEW.state NOT IN ('pending','ready','abandoned') OR NEW.name IS NOT OLD.name OR NEW.parent_id IS NOT OLD.parent_id OR NEW.alt_zh IS NOT OLD.alt_zh OR NEW.alt_en IS NOT OLD.alt_en)) OR (OLD.thumbnail_state IN ('none','ready','abandoned') AND NEW.thumbnail_state IS NOT OLD.thumbnail_state) OR (OLD.thumbnail_state='pending' AND NEW.thumbnail_state NOT IN ('pending','ready','abandoned'));
  SELECT RAISE(ABORT,'files_private_restore') WHERE OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL AND NEW.published_at IS NOT NULL;
  SELECT RAISE(ABORT,'files_source') WHERE NEW.kind='file' AND NEW.state='ready' AND NOT EXISTS(SELECT 1 FROM file_objects o WHERE o.id=NEW.source_object_id AND o.file_id=NEW.id AND o.role='source' AND o.verified_at IS NOT NULL);
  SELECT RAISE(ABORT,'files_thumbnail') WHERE NEW.thumbnail_state='ready' AND NOT EXISTS(SELECT 1 FROM file_objects o WHERE o.id=NEW.thumbnail_object_id AND o.file_id=NEW.id AND o.role='thumbnail' AND o.verified_at IS NOT NULL);
  SELECT RAISE(ABORT,'files_not_empty') WHERE NEW.kind='folder' AND OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL AND EXISTS(SELECT 1 FROM file_entries e WHERE e.parent_id=NEW.id AND e.deleted_at IS NULL AND e.state<>'abandoned');
  SELECT RAISE(ABORT,'files_parent') WHERE NEW.parent_id IS NOT NULL AND NEW.deleted_at IS NULL AND NEW.state<>'abandoned' AND NOT EXISTS(SELECT 1 FROM file_entries p WHERE p.id=NEW.parent_id AND p.kind='folder' AND p.state='ready' AND p.deleted_at IS NULL);
  SELECT RAISE(ABORT,'files_depth') WHERE EXISTS(
    WITH RECURSIVE ancestors(id,parent_id,depth) AS (
      SELECT id,parent_id,1 FROM file_entries WHERE id=NEW.parent_id
      UNION ALL SELECT p.id,p.parent_id,a.depth+1 FROM file_entries p JOIN ancestors a ON p.id=a.parent_id WHERE a.depth<=8
    ) SELECT 1 FROM ancestors WHERE id=NEW.id OR depth>8 OR (NEW.kind='folder' AND depth>=8)
  );
  SELECT RAISE(ABORT,'files_name') WHERE NEW.deleted_at IS NULL AND NEW.state<>'abandoned' AND EXISTS(SELECT 1 FROM file_entries e WHERE e.id<>NEW.id AND e.parent_id IS NEW.parent_id AND e.name_key=NEW.name_key AND e.deleted_at IS NULL AND e.state<>'abandoned');
  SELECT RAISE(ABORT,'files_depth') WHERE NEW.kind='folder' AND NEW.parent_id IS NOT OLD.parent_id AND EXISTS(
    WITH RECURSIVE ancestors(id,parent_id,depth) AS (
      SELECT id,parent_id,1 FROM file_entries WHERE id=NEW.parent_id
      UNION ALL SELECT p.id,p.parent_id,a.depth+1 FROM file_entries p JOIN ancestors a ON p.id=a.parent_id WHERE a.depth<=8
    ), descendants(id,depth) AS (
      SELECT OLD.id,1 UNION ALL SELECT e.id,d.depth+1 FROM file_entries e JOIN descendants d ON e.parent_id=d.id WHERE e.kind='folder' AND d.depth<=8
    ) SELECT 1 FROM descendants WHERE depth+coalesce((SELECT max(depth) FROM ancestors),0)>8
  );
END;
CREATE TRIGGER file_objects_insert_guard BEFORE INSERT ON file_objects
BEGIN
  SELECT RAISE(ABORT,'files_object') WHERE EXISTS(SELECT 1 FROM file_objects WHERE id=NEW.id OR object_key=NEW.object_key OR (file_id=NEW.file_id AND role=NEW.role)) OR NEW.verified_at IS NOT NULL OR NOT EXISTS(SELECT 1 FROM file_entries e WHERE e.id=NEW.file_id AND e.kind='file' AND e.state='pending' AND e.version=1 AND ((NEW.role='source' AND e.source_object_id=NEW.id) OR (NEW.role='thumbnail' AND e.thumbnail_object_id=NEW.id AND e.thumbnail_state='pending')));
  SELECT RAISE(ABORT,'files_thumbnail') WHERE NEW.role='thumbnail' AND NOT EXISTS(SELECT 1 FROM file_objects o WHERE o.file_id=NEW.file_id AND o.role='source' AND o.mime_hint<>'application/octet-stream');
END;
CREATE TRIGGER file_objects_update_guard BEFORE UPDATE ON file_objects
BEGIN
  SELECT RAISE(ABORT,'files_immutable') WHERE NEW.id IS NOT OLD.id OR NEW.file_id IS NOT OLD.file_id OR NEW.role IS NOT OLD.role OR NEW.object_key IS NOT OLD.object_key OR NEW.receipt_token IS NOT OLD.receipt_token OR NEW.expected_bytes IS NOT OLD.expected_bytes OR NEW.expected_sha256 IS NOT OLD.expected_sha256 OR NEW.mime_hint IS NOT OLD.mime_hint OR OLD.verified_at IS NOT NULL OR NEW.verified_at IS NULL;
  SELECT RAISE(ABORT,'files_state') WHERE NOT EXISTS(SELECT 1 FROM file_entries e WHERE e.id=NEW.file_id AND e.deleted_at IS NULL AND e.published_at IS NULL AND ((NEW.role='source' AND e.state='pending') OR (NEW.role='thumbnail' AND e.state='ready' AND e.thumbnail_state='pending' AND EXISTS(SELECT 1 FROM file_objects s WHERE s.id=e.source_object_id AND s.verified_at IS NOT NULL AND s.mime<>'application/octet-stream'))));
END;
CREATE TRIGGER file_objects_no_delete BEFORE DELETE ON file_objects BEGIN SELECT RAISE(ABORT,'files_immutable'); END;
CREATE TRIGGER file_entries_after_insert AFTER INSERT ON file_entries
BEGIN
  SELECT RAISE(ABORT,'files_library') WHERE NOT EXISTS(SELECT 1 FROM file_library WHERE id=1);
  UPDATE file_library SET version=version+1,updated_at=NEW.updated_at WHERE id=1;
  INSERT INTO audit_records(category,subject_id,subject_version,action,language,origin,details_json,created_at)
  VALUES('file',NEW.id,NEW.version,(CASE WHEN NEW.kind='folder' THEN 'file.create_folder' ELSE 'file.prepare' END),NULL,'current',
    json_object('changedFields',json((CASE WHEN NEW.kind='folder' THEN '["name","parentId"]' WHEN NEW.thumbnail_state='pending' THEN '["name","parentId","state","thumbnailState"]' ELSE '["name","parentId","state"]' END))),NEW.updated_at);
END;
CREATE TRIGGER file_entries_after_update AFTER UPDATE ON file_entries
WHEN NEW.name IS NOT OLD.name OR NEW.parent_id IS NOT OLD.parent_id OR NEW.alt_zh IS NOT OLD.alt_zh OR NEW.alt_en IS NOT OLD.alt_en OR NEW.state IS NOT OLD.state OR NEW.thumbnail_state IS NOT OLD.thumbnail_state OR NEW.published_at IS NOT OLD.published_at OR NEW.deleted_at IS NOT OLD.deleted_at
BEGIN
  SELECT RAISE(ABORT,'files_library') WHERE NOT EXISTS(SELECT 1 FROM file_library WHERE id=1);
  UPDATE file_library SET version=version+1,updated_at=NEW.updated_at WHERE id=1;
  INSERT INTO audit_records(category,subject_id,subject_version,action,language,origin,details_json,created_at)
  VALUES('file',NEW.id,NEW.version,(CASE
    WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN 'file.delete'
    WHEN OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN 'file.restore'
    WHEN (OLD.state<>'abandoned' AND NEW.state='abandoned') OR (OLD.thumbnail_state<>'abandoned' AND NEW.thumbnail_state='abandoned' AND NEW.published_at IS OLD.published_at) THEN 'file.abandon'
    WHEN NEW.published_at IS NOT NULL AND OLD.published_at IS NULL THEN 'file.publish'
    WHEN NEW.published_at IS NULL AND OLD.published_at IS NOT NULL THEN 'file.unpublish'
    WHEN OLD.state='pending' AND NEW.state='ready' THEN 'file.finalize'
    WHEN OLD.thumbnail_state='pending' AND NEW.thumbnail_state='ready' THEN 'file.thumbnail'
    WHEN NEW.name IS NOT OLD.name THEN 'file.rename'
    WHEN NEW.parent_id IS NOT OLD.parent_id THEN 'file.move'
    ELSE 'file.alt' END),NULL,'current',
    json_object('changedFields',json((SELECT json_group_array(value) FROM json_each(json_array(
      (CASE WHEN NEW.name IS NOT OLD.name THEN 'name' END),
      (CASE WHEN NEW.parent_id IS NOT OLD.parent_id THEN 'parentId' END),
      (CASE WHEN NEW.alt_zh IS NOT OLD.alt_zh THEN 'alt.zh' END),
      (CASE WHEN NEW.alt_en IS NOT OLD.alt_en THEN 'alt.en' END),
      (CASE WHEN NEW.state IS NOT OLD.state THEN 'state' END),
      (CASE WHEN NEW.thumbnail_state IS NOT OLD.thumbnail_state THEN 'thumbnailState' END),
      (CASE WHEN NEW.published_at IS NOT OLD.published_at THEN 'visibility' END),
      (CASE WHEN NEW.deleted_at IS NOT OLD.deleted_at THEN 'deletedAt' END)
    )) WHERE value IS NOT NULL))),NEW.updated_at);
END;
