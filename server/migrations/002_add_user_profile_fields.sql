-- Evolution script example: Add profile fields to users if not present
-- Run after 001 if needed for upgrades

ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS header_image TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS icon_data TEXT;

-- Add index if useful
CREATE INDEX IF NOT EXISTS idx_users_handle ON users(handle);