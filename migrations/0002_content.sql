CREATE TABLE pages (
  id TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE page_translations (
  id TEXT PRIMARY KEY NOT NULL,
  page_id TEXT NOT NULL REFERENCES pages(id),
  language TEXT NOT NULL CHECK (language IN ('zh', 'en')),
  slug TEXT NOT NULL CHECK (length(slug) BETWEEN 1 AND 240),
  write_version INTEGER NOT NULL DEFAULT 0 CHECK (write_version >= 0),
  revision_seq INTEGER NOT NULL DEFAULT 0 CHECK (revision_seq >= 0),
  draft_revision_id TEXT,
  published_revision_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT,
  deleted_at TEXT,
  UNIQUE (page_id, language),
  UNIQUE (language, slug),
  UNIQUE (id, language),
  FOREIGN KEY (id, draft_revision_id) REFERENCES page_revisions(translation_id, id),
  FOREIGN KEY (id, published_revision_id) REFERENCES page_revisions(translation_id, id),
  CHECK ((published_revision_id IS NULL) = (published_at IS NULL)),
  CHECK (deleted_at IS NULL OR published_revision_id IS NULL)
);

CREATE TABLE page_revisions (
  id TEXT PRIMARY KEY NOT NULL,
  translation_id TEXT NOT NULL REFERENCES page_translations(id),
  revision_no INTEGER NOT NULL CHECK (revision_no > 0),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description TEXT NOT NULL CHECK (length(description) <= 500),
  markdown TEXT NOT NULL CHECK (length(CAST(markdown AS BLOB)) <= 128000),
  tags_json TEXT NOT NULL CHECK (json_valid(tags_json) AND json_type(tags_json) = 'array'),
  change_note TEXT NOT NULL CHECK (length(change_note) <= 500),
  restored_from_revision_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (translation_id, id),
  UNIQUE (translation_id, revision_no),
  FOREIGN KEY (translation_id, restored_from_revision_id) REFERENCES page_revisions(translation_id, id)
);

CREATE TRIGGER page_revisions_no_update BEFORE UPDATE ON page_revisions
BEGIN
  SELECT RAISE(ABORT, 'revision_immutable');
END;
CREATE TRIGGER page_revisions_no_delete BEFORE DELETE ON page_revisions
BEGIN
  SELECT RAISE(ABORT, 'revision_immutable');
END;

CREATE TABLE page_routes (
  language TEXT NOT NULL CHECK (language IN ('zh', 'en')),
  path TEXT NOT NULL CHECK (length(path) BETWEEN 1 AND 240),
  translation_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (language, path),
  FOREIGN KEY (translation_id, language) REFERENCES page_translations(id, language)
);
CREATE INDEX page_routes_translation ON page_routes(translation_id);

CREATE TABLE published_search (
  translation_id TEXT NOT NULL UNIQUE,
  language TEXT NOT NULL CHECK (language IN ('zh', 'en')),
  revision_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  path TEXT NOT NULL,
  tags_json TEXT NOT NULL CHECK (json_valid(tags_json) AND json_type(tags_json) = 'array'),
  body_text TEXT NOT NULL,
  FOREIGN KEY (translation_id, language) REFERENCES page_translations(id, language),
  FOREIGN KEY (translation_id, revision_id) REFERENCES page_revisions(translation_id, id)
);
CREATE INDEX published_search_language ON published_search(language, path);
CREATE VIRTUAL TABLE published_search_fts USING fts5(
  translation_id UNINDEXED,
  language UNINDEXED,
  title,
  tags,
  description,
  path,
  body,
  tokenize='unicode61'
);

CREATE TABLE page_events (
  id TEXT PRIMARY KEY NOT NULL,
  translation_id TEXT NOT NULL REFERENCES page_translations(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('create', 'save_draft', 'publish', 'unpublish', 'move', 'delete', 'restore_revision', 'restore_deleted')),
  version INTEGER NOT NULL CHECK (version > 0),
  revision_id TEXT,
  from_path TEXT,
  to_path TEXT,
  change_note TEXT NOT NULL CHECK (length(change_note) <= 500),
  created_at TEXT NOT NULL,
  UNIQUE (translation_id, version),
  FOREIGN KEY (translation_id, revision_id) REFERENCES page_revisions(translation_id, id)
);
CREATE INDEX page_events_translation_time ON page_events(translation_id, created_at);
CREATE TRIGGER page_events_no_update BEFORE UPDATE ON page_events
BEGIN
  SELECT RAISE(ABORT, 'event_immutable');
END;
CREATE TRIGGER page_events_no_delete BEFORE DELETE ON page_events
BEGIN
  SELECT RAISE(ABORT, 'event_immutable');
END;
