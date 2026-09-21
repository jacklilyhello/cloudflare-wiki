CREATE TABLE navigation_trees (
  language TEXT PRIMARY KEY CHECK (language IN ('zh', 'en')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  mode TEXT NOT NULL DEFAULT 'automatic' CHECK (mode IN ('automatic', 'custom')),
  updated_at TEXT NOT NULL
);
INSERT INTO navigation_trees(language, updated_at) VALUES
  ('zh', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('en', strftime('%Y-%m-%dT%H:%M:%fZ','now'));

CREATE TABLE navigation_nodes (
  language TEXT NOT NULL REFERENCES navigation_trees(language),
  id TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 128),
  parent_id TEXT,
  position INTEGER NOT NULL CHECK (position >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('group', 'page', 'link')),
  label TEXT CHECK (label IS NULL OR length(label) BETWEEN 1 AND 200),
  translation_id TEXT,
  external_url TEXT CHECK (external_url IS NULL OR length(external_url) BETWEEN 1 AND 2048),
  PRIMARY KEY (language, id),
  UNIQUE (language, translation_id),
  FOREIGN KEY (language, parent_id) REFERENCES navigation_nodes(language, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (translation_id, language) REFERENCES page_translations(id, language),
  CHECK (parent_id IS NULL OR parent_id != id),
  CHECK (
    (kind='group' AND label IS NOT NULL AND translation_id IS NULL AND external_url IS NULL) OR
    (kind='page' AND translation_id IS NOT NULL AND external_url IS NULL) OR
    (kind='link' AND label IS NOT NULL AND translation_id IS NULL AND external_url IS NOT NULL)
  )
);
CREATE UNIQUE INDEX navigation_nodes_siblings
ON navigation_nodes(language, coalesce(parent_id,''), position);
