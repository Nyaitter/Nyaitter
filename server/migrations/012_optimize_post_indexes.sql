-- PostgreSQL and CockroachDB query performance optimization indexes for posts and interactions.
-- Speeds up public timeline, following timeline, user profile feeds, media feeds, and trending aggregations.

-- 1. Public root posts (For You feed, discovery candidate scan, trending scan)
CREATE INDEX IF NOT EXISTS idx_posts_public_root_created
    ON posts (created_at DESC, id DESC)
    WHERE group_id IS NULL AND reply_to IS NULL;

-- 2. Public announcement posts
CREATE INDEX IF NOT EXISTS idx_posts_public_announce_created
    ON posts (created_at DESC, id DESC)
    WHERE group_id IS NULL AND announcement = true AND reply_to IS NULL;

-- 3. User root posts (Following feed with ANY(user_ids), user root posts)
CREATE INDEX IF NOT EXISTS idx_posts_user_root_created
    ON posts (user_id, created_at DESC, id DESC)
    WHERE group_id IS NULL AND reply_to IS NULL;

-- 4. User all public posts (Profile timeline)
CREATE INDEX IF NOT EXISTS idx_posts_user_public_created
    ON posts (user_id, created_at DESC, id DESC)
    WHERE group_id IS NULL;

-- 5. User public replies (Profile replies tab)
CREATE INDEX IF NOT EXISTS idx_posts_user_public_replies_created
    ON posts (user_id, created_at DESC, id DESC)
    WHERE group_id IS NULL AND reply_to IS NOT NULL;

-- 6. User media posts (Profile media tab)
CREATE INDEX IF NOT EXISTS idx_posts_user_media_created
    ON posts (user_id, created_at DESC, id DESC)
    WHERE attachments IS NOT NULL;

-- 7. Post reactions ordered by date (Fast reaction listing and trending calculation)
CREATE INDEX IF NOT EXISTS idx_likes_post_created_desc
    ON likes (post_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_stars_post_created_desc
    ON stars (post_id, created_at DESC);

-- 8. Notifications list and unread queries
CREATE INDEX IF NOT EXISTS idx_notifications_user_created
    ON notifications (user_id, created_at DESC, id DESC);

-- 9. Group memberships for user group badges
CREATE INDEX IF NOT EXISTS idx_group_memberships_user_active_joined
    ON group_memberships (user_id, status, joined_at DESC);

-- 10. Keyword affinities for recommendation scoring
CREATE INDEX IF NOT EXISTS idx_user_keyword_affinities_user_score
    ON user_keyword_affinities (user_id, score DESC, keyword ASC);

