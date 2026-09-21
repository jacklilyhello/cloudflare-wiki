-- Cursor order is stable for equal timestamps; filters never read revision bodies.
CREATE INDEX page_translations_admin_updated
ON page_translations(updated_at DESC, id);
CREATE INDEX page_translations_admin_language_updated
ON page_translations(language, updated_at DESC, id);
CREATE INDEX page_translations_admin_deleted_updated
ON page_translations(deleted_at, updated_at DESC, id);
