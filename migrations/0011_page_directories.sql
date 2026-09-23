-- A private, transaction-local claim lets a multi-page move survive its own
-- route-version triggers. Older Workers neither read nor assign this column.
ALTER TABLE route_registries ADD COLUMN move_token TEXT
  CHECK (move_token IS NULL OR (length(move_token)=36 AND typeof(move_token)='text'));

-- Active virtual-directory membership changes when a page enters/leaves Trash,
-- even though its reserved canonical route remains in place.
CREATE TRIGGER page_translations_directory_visibility AFTER UPDATE OF deleted_at ON page_translations
WHEN NEW.deleted_at IS NOT OLD.deleted_at
BEGIN
  UPDATE route_registries SET version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE language=NEW.language;
END;
