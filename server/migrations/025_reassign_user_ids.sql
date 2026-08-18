ALTER TABLE users
    DROP COLUMN IF EXISTS local_nyaitter_id;

UPDATE users
SET handle = '#' || LPAD(id::text, 4, '0')
WHERE auth_provider <> 'nyaitter';

ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_user_id_fkey;
ALTER TABLE posts
    ADD CONSTRAINT posts_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE likes DROP CONSTRAINT IF EXISTS likes_user_id_fkey;
ALTER TABLE likes
    ADD CONSTRAINT likes_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE stars DROP CONSTRAINT IF EXISTS stars_user_id_fkey;
ALTER TABLE stars
    ADD CONSTRAINT stars_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE reposts DROP CONSTRAINT IF EXISTS reposts_user_id_fkey;
ALTER TABLE reposts
    ADD CONSTRAINT reposts_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE pinned_posts DROP CONSTRAINT IF EXISTS pinned_posts_user_id_fkey;
ALTER TABLE pinned_posts
    ADD CONSTRAINT pinned_posts_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE dm_messages DROP CONSTRAINT IF EXISTS dm_messages_sender_id_fkey;
ALTER TABLE dm_messages
    ADD CONSTRAINT dm_messages_sender_id_fkey
    FOREIGN KEY (sender_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE follows DROP CONSTRAINT IF EXISTS follows_follower_id_fkey;
ALTER TABLE follows
    ADD CONSTRAINT follows_follower_id_fkey
    FOREIGN KEY (follower_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE follows DROP CONSTRAINT IF EXISTS follows_following_id_fkey;
ALTER TABLE follows
    ADD CONSTRAINT follows_following_id_fkey
    FOREIGN KEY (following_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_user_id_fkey;
ALTER TABLE notifications
    ADD CONSTRAINT notifications_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_from_user_id_fkey;
ALTER TABLE notifications
    ADD CONSTRAINT notifications_from_user_id_fkey
    FOREIGN KEY (from_user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_user_id_fkey;
ALTER TABLE sessions
    ADD CONSTRAINT sessions_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE bot_tokens DROP CONSTRAINT IF EXISTS bot_tokens_user_id_fkey;
ALTER TABLE bot_tokens
    ADD CONSTRAINT bot_tokens_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE push_subscriptions DROP CONSTRAINT IF EXISTS push_subscriptions_user_id_fkey;
ALTER TABLE push_subscriptions
    ADD CONSTRAINT push_subscriptions_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE trusted_login_ips DROP CONSTRAINT IF EXISTS trusted_login_ips_user_id_fkey;
ALTER TABLE trusted_login_ips
    ADD CONSTRAINT trusted_login_ips_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE login_approvals DROP CONSTRAINT IF EXISTS login_approvals_user_id_fkey;
ALTER TABLE login_approvals
    ADD CONSTRAINT login_approvals_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE group_dms DROP CONSTRAINT IF EXISTS group_dms_host_id_fkey;
ALTER TABLE group_dms
    ADD CONSTRAINT group_dms_host_id_fkey
    FOREIGN KEY (host_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE dm_e2e_keys DROP CONSTRAINT IF EXISTS dm_e2e_keys_user_id_fkey;
ALTER TABLE dm_e2e_keys
    ADD CONSTRAINT dm_e2e_keys_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE moderation_reports DROP CONSTRAINT IF EXISTS moderation_reports_reporter_user_id_fkey;
ALTER TABLE moderation_reports
    ADD CONSTRAINT moderation_reports_reporter_user_id_fkey
    FOREIGN KEY (reporter_user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE moderation_reports DROP CONSTRAINT IF EXISTS moderation_reports_assigned_admin_id_fkey;
ALTER TABLE moderation_reports
    ADD CONSTRAINT moderation_reports_assigned_admin_id_fkey
    FOREIGN KEY (assigned_admin_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE SET NULL;
