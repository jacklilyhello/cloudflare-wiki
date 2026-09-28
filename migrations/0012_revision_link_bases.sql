-- Content is immutable. Keep its URL resolution context separately and immutable
-- too. Existing content starts from its current semantics at this migration.
CREATE TABLE revision_link_bases (
  revision_id TEXT PRIMARY KEY NOT NULL REFERENCES page_revisions(id),
  path TEXT NOT NULL CHECK (length(path) BETWEEN 1 AND 240)
);
INSERT INTO revision_link_bases(revision_id,path)
SELECT r.id,t.slug FROM page_revisions r JOIN page_translations t ON t.id=r.translation_id;

CREATE TRIGGER revision_link_base_insert AFTER INSERT ON page_revisions
BEGIN
  INSERT INTO revision_link_bases(revision_id,path)
  SELECT NEW.id,coalesce(
    (SELECT path FROM revision_link_bases WHERE revision_id=NEW.restored_from_revision_id),
    (SELECT path FROM revision_link_bases WHERE revision_id=t.draft_revision_id),
    t.slug) FROM page_translations t WHERE t.id=NEW.translation_id;
END;
CREATE TRIGGER revision_link_bases_no_update BEFORE UPDATE ON revision_link_bases
BEGIN
  SELECT RAISE(ABORT,'link_base_immutable');
END;
CREATE TRIGGER revision_link_bases_no_delete BEFORE DELETE ON revision_link_bases
BEGIN
  SELECT RAISE(ABORT,'link_base_immutable');
END;
