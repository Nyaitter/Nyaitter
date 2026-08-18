-- Use portable text identifiers for group DMs across every database adapter.
ALTER TABLE group_dms ALTER COLUMN id DROP DEFAULT;
ALTER TABLE group_dms ALTER COLUMN id TYPE TEXT USING id::TEXT;
