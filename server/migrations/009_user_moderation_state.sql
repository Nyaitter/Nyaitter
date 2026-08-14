-- Current Nyaitter user moderation state.
-- Development migration for the current standalone moderation schema.

ALTER TABLE users ADD COLUMN IF NOT EXISTS verify BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS "freeze" TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS admin BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS shadow BOOLEAN NOT NULL DEFAULT FALSE;
