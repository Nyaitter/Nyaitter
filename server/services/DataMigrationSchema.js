'use strict';

// データ移行スナップショットが扱うテーブル定義の唯一の情報源。
//
// 以前は次の3か所が別々に手書きされていて、実際にずれていた。
//   - services/DataMigrationService.js の TABLES と normalizeRow
//   - services/DataMigrationSql.js の TABLE_COLUMNS と INSERT_ORDER
//   - workers/d1-proxy/src/index.js の MIGRATION_TABLES と MIGRATION_COLUMNS
// ずれると「移行先で静かに消える」ため、列と順序はここだけに書く。
//
// columns は PostgreSQL スキーマを基準にした論理列名。各アダプタは
// 実際に存在する列だけを使う（列の有無は実行時に検出する）。
// 派生列（derived）はコピーせず、投入後に移行先で再計算する。
// 理由: D1 はトリガーでカウンタを維持しており、値を入れたうえで
//       トリガーが加算すると二重計上になる。再計算なら冪等で自己修復的。
//
// 除外テーブル（EXCLUDED_TABLES）は「移行しない」と決めたもの。
// 黙って落とさないよう、スナップショットとCLIに必ず記録する。

const TABLE_SPECS = Object.freeze([
  {
    table: 'users',
    columns: ['id', 'scid', 'name', 'handle', 'nyaitter_address', 'auth_provider', 'provider_domain', 'external_id',
      'external_profile', 'uuid', 'settings', 'bio', 'header_image', 'icon_data', 'verify', 'freeze', 'admin',
      'admin_request_excluded', 'shadow', 'block', 'account_operation', 'created_at'],
    json: ['external_profile', 'settings', 'block'],
    booleans: ['verify', 'admin', 'admin_request_excluded', 'shadow'],
    integers: ['id'],
    dates: ['created_at'],
  },
  {
    table: 'user_auth_providers',
    columns: ['id', 'user_id', 'provider', 'provider_user_id', 'provider_profile', 'created_at'],
    json: ['provider_profile'],
    integers: ['id', 'user_id'],
    dates: ['created_at'],
    sequence: 'user_auth_providers_id_seq',
  },
  {
    table: 'spaces',
    columns: ['id', 'owner_id', 'name', 'description', 'icon_data', 'header_image', 'visibility', 'stage_settings',
      'group_id', 'created_at', 'updated_at'],
    json: ['stage_settings'],
    integers: ['owner_id'],
    dates: ['created_at', 'updated_at'],
  },
  {
    table: 'space_channels',
    columns: ['id', 'space_id', 'name', 'kind', 'sort_order', 'created_at'],
    integers: ['sort_order'],
    dates: ['created_at'],
  },
  {
    table: 'space_members',
    columns: ['space_id', 'user_id', 'role', 'joined_at'],
    integers: ['user_id'],
    dates: ['joined_at'],
  },
  {
    table: 'space_messages',
    columns: ['id', 'space_id', 'channel_id', 'user_id', 'content', 'created_at'],
    integers: ['id', 'user_id'],
    dates: ['created_at'],
    sequence: 'space_messages_id_seq',
  },
  {
    table: 'sessions',
    columns: ['session_id', 'token', 'user_id', 'ip_hash', 'ip_masked', 'user_agent', 'ip', 'expires_at', 'created_at'],
    integers: ['user_id'],
    dates: ['expires_at', 'created_at'],
    // PostgreSQL だけが持つ旧列。D1 には無い（実行時検出で読み飛ばす）。
    optionalColumns: ['ip'],
    postgresOnlyColumns: ['ip'],
  },
  {
    table: 'trusted_login_ips',
    columns: ['user_id', 'ip_hash', 'ip_masked', 'created_at', 'last_used_at'],
    integers: ['user_id'],
    dates: ['created_at', 'last_used_at'],
  },
  {
    table: 'login_approvals',
    columns: ['id', 'user_id', 'ip_hash', 'ip_masked', 'user_agent', 'auth_provider', 'poll_token_hash', 'status',
      'created_at', 'expires_at', 'decided_at', 'consumed_at'],
    integers: ['user_id'],
    dates: ['created_at', 'expires_at', 'decided_at', 'consumed_at'],
  },
  {
    table: 'account_recovery_requests',
    columns: ['id', 'user_id', 'ip_hash', 'ip_masked', 'user_agent', 'auth_provider', 'request_token_hash', 'status',
      'trust_score', 'wait_until', 'started_at', 'last_notified_at', 'notified_count', 'decided_at', 'decided_by',
      'consumed_at'],
    integers: ['user_id', 'trust_score', 'notified_count'],
    dates: ['wait_until', 'started_at', 'last_notified_at', 'decided_at', 'consumed_at'],
    fk: [{ table: 'users', column: 'user_id' }],
  },
  {
    table: 'blocked_login_ips',
    columns: ['user_id', 'ip_hash', 'ip_masked', 'reason', 'source_recovery_id', 'created_at'],
    integers: ['user_id'],
    dates: ['created_at'],
    fk: [{ table: 'users', column: 'user_id' }],
  },
  {
    table: 'bot_tokens',
    columns: ['token_id', 'token_hash', 'user_id', 'name', 'created_at', 'last_used_at'],
    integers: ['user_id'],
    dates: ['created_at', 'last_used_at'],
  },
  {
    table: 'posts',
    columns: ['id', 'user_id', 'content', 'attachments', 'mask', 'lock', 'announcement', 'reply_to', 'repost_to',
      'tags', 'tags_generated_at', 'group_id', 'group_announcement', 'view_content', 'reply_control', 'scheduled_at',
      'recommendation_penalty', 'created_at',
      // 派生カウンタ。投入後に移行先で再計算する。
      'like_count', 'star_count', 'repost_count', 'reply_count'],
    json: ['attachments', 'tags'],
    booleans: ['mask', 'lock', 'announcement', 'group_announcement'],
    integers: ['id', 'user_id', 'reply_to', 'repost_to'],
    numbers: ['recommendation_penalty'],
    dates: ['tags_generated_at', 'scheduled_at', 'created_at'],
    // コピーせず移行先で再計算する列。
    derived: ['like_count', 'star_count', 'repost_count', 'reply_count'],
    optionalColumns: ['view_content', 'reply_control', 'scheduled_at', 'recommendation_penalty'],
    // D1 にはまだ列が無い。あるDBではコピーし、無いDBでは読み飛ばして報告する。
    postgresOnlyColumns: ['view_content', 'reply_control'],
    selfReference: { column: 'reply_to', target: 'posts' },
    fk: [{ table: 'users', column: 'user_id' }],
    sequence: 'nyaitter_posts_id_seq',
  },
  {
    table: 'likes',
    columns: ['user_id', 'post_id', 'created_at'],
    integers: ['user_id', 'post_id'],
    dates: ['created_at'],
    fk: [{ table: 'users', column: 'user_id' }, { table: 'posts', column: 'post_id' }],
  },
  {
    table: 'stars',
    columns: ['user_id', 'post_id', 'created_at'],
    integers: ['user_id', 'post_id'],
    dates: ['created_at'],
    fk: [{ table: 'users', column: 'user_id' }, { table: 'posts', column: 'post_id' }],
  },
  {
    table: 'reposts',
    columns: ['user_id', 'post_id', 'created_at'],
    integers: ['user_id', 'post_id'],
    dates: ['created_at'],
    fk: [{ table: 'users', column: 'user_id' }, { table: 'posts', column: 'post_id' }],
  },
  {
    table: 'pinned_posts',
    columns: ['user_id', 'post_id', 'created_at'],
    integers: ['user_id', 'post_id'],
    dates: ['created_at'],
    fk: [{ table: 'users', column: 'user_id' }, { table: 'posts', column: 'post_id' }],
  },
  {
    table: 'follows',
    columns: ['follower_id', 'following_id', 'created_at'],
    integers: ['follower_id', 'following_id'],
    dates: ['created_at'],
    fk: [{ table: 'users', column: 'follower_id' }, { table: 'users', column: 'following_id' }],
  },
  {
    table: 'dm_channels',
    columns: ['id', 'participants', 'created_at'],
    arrays: ['participants'],
    dates: ['created_at'],
  },
  {
    table: 'dm_messages',
    columns: ['id', 'channel_id', 'sender_id', 'content', 'sent_at', 'read_at'],
    integers: ['id', 'sender_id'],
    dates: ['sent_at', 'read_at'],
    fk: [{ table: 'dm_channels', column: 'channel_id' }, { table: 'users', column: 'sender_id' }],
    sequence: 'nyaitter_dm_messages_id_seq',
  },
  {
    table: 'group_dms',
    columns: ['id', 'host_id', 'title', 'member', 'post', 'unread', 'time', 'created_at',
      // migration 032 の集約キャッシュ。投入後に再計算する。
      'message_count', 'latest_message', 'state_version'],
    json: ['post', 'unread'],
    arrays: ['member'],
    integers: ['host_id', 'state_version'],
    dates: ['time', 'created_at'],
    derived: ['message_count', 'latest_message'],
    optionalColumns: ['message_count', 'latest_message', 'state_version'],
    postgresOnlyColumns: ['message_count', 'latest_message'],
    fk: [{ table: 'users', column: 'host_id' }],
  },
  {
    table: 'group_dm_send_requests',
    columns: ['dm_id', 'sender_id', 'request_id', 'request_hash', 'response_message'],
    json: ['response_message'],
    integers: ['sender_id'],
    fk: [{ table: 'group_dms', column: 'dm_id' }, { table: 'users', column: 'sender_id' }],
  },
  {
    table: 'dm_e2e_keys',
    columns: ['user_id', 'public_key', 'created_at', 'updated_at'],
    integers: ['user_id'],
    dates: ['created_at', 'updated_at'],
    fk: [{ table: 'users', column: 'user_id' }],
  },
  {
    table: 'notifications',
    columns: ['id', 'user_id', 'type', 'from_user_id', 'post_id', 'target', 'message', 'open', 'read', 'clicked',
      'created_at'],
    json: ['target'],
    booleans: ['read', 'clicked'],
    integers: ['id', 'user_id', 'from_user_id', 'post_id'],
    dates: ['created_at'],
    optionalColumns: ['open'],
    postgresOnlyColumns: ['open'],
    sequence: 'nyaitter_notifications_id_seq',
  },
  {
    table: 'push_subscriptions',
    columns: ['user_id', 'endpoint', 'expiration_time', 'p256dh', 'auth', 'session_token', 'created_at', 'updated_at'],
    integers: ['user_id'],
    dates: ['expiration_time', 'created_at', 'updated_at'],
    fk: [{ table: 'users', column: 'user_id' }],
  },
  {
    table: 'moderation_reports',
    columns: ['id', 'reporter_user_id', 'target_kind', 'target_id', 'description', 'target_snapshot',
      'assignment_type', 'status', 'assigned_admin_id', 'assigned_at', 'excluded_admin_ids', 'resolution',
      'created_at', 'resolved_at', 'claimed_at'],
    json: ['target_snapshot', 'excluded_admin_ids', 'resolution'],
    integers: ['id', 'reporter_user_id', 'assigned_admin_id'],
    dates: ['assigned_at', 'created_at', 'resolved_at', 'claimed_at'],
    sequence: 'nyaitter_moderation_reports_id_seq',
  },
  {
    table: 'mod_logs',
    columns: ['id', 'created_at', 'actor_type', 'actor_id', 'action', 'target_type', 'target_id', 'result'],
    dates: [],
    // 監査ログは文字列ID・文字列日時で厳密に検証する（normalizeSnapshot を参照）。
    strictStrings: true,
  },
  {
    table: 'logs',
    columns: ['id', 'scratch_id', 'nyaitter_id', 'masked_ip_uuid', 'log_time'],
    integers: ['id', 'nyaitter_id'],
    dates: ['log_time'],
    sequence: 'nyaitter_logs_id_seq',
  },
  {
    table: 'groups',
    columns: ['id', 'owner_id', 'name', 'description', 'icon_data', 'header_image', 'visibility', 'deleted_at',
      'created_at', 'updated_at'],
    integers: ['owner_id'],
    dates: ['deleted_at', 'created_at', 'updated_at'],
    fk: [{ table: 'users', column: 'owner_id' }],
  },
  {
    table: 'group_roles',
    columns: ['id', 'group_id', 'name', 'permissions', 'is_system', 'sort_order', 'created_at', 'updated_at'],
    json: ['permissions'],
    booleans: ['is_system'],
    integers: ['sort_order'],
    dates: ['created_at', 'updated_at'],
    fk: [{ table: 'groups', column: 'group_id' }],
  },
  {
    table: 'group_memberships',
    columns: ['group_id', 'user_id', 'role_id', 'status', 'joined_at', 'updated_at'],
    integers: ['user_id'],
    dates: ['joined_at', 'updated_at'],
    fk: [{ table: 'groups', column: 'group_id' }, { table: 'users', column: 'user_id' },
      { table: 'group_roles', column: 'role_id' }],
  },
  {
    table: 'group_invites',
    columns: ['id', 'group_id', 'inviter_id', 'invitee_id', 'status', 'created_at', 'responded_at'],
    integers: ['inviter_id', 'invitee_id'],
    dates: ['created_at', 'responded_at'],
    fk: [{ table: 'groups', column: 'group_id' }, { table: 'users', column: 'inviter_id' },
      { table: 'users', column: 'invitee_id' }],
  },
  {
    table: 'group_join_requests',
    columns: ['id', 'group_id', 'user_id', 'status', 'reviewed_by', 'created_at', 'reviewed_at'],
    integers: ['user_id', 'reviewed_by'],
    dates: ['created_at', 'reviewed_at'],
    fk: [{ table: 'groups', column: 'group_id' }, { table: 'users', column: 'user_id' }],
  },
  {
    table: 'user_keyword_affinities',
    columns: ['user_id', 'keyword', 'score', 'updated_at'],
    integers: ['user_id'],
    numbers: ['score'],
    dates: ['updated_at'],
    fk: [{ table: 'users', column: 'user_id' }],
  },
  {
    table: 'polls',
    columns: ['id', 'post_id', 'user_id', 'title', 'options', 'allow_multiple', 'allow_other',
      'show_results_before_voting', 'expires_at', 'closed', 'closed_notified', 'created_at'],
    json: ['options'],
    booleans: ['allow_multiple', 'allow_other', 'show_results_before_voting', 'closed', 'closed_notified'],
    integers: ['post_id', 'user_id'],
    dates: ['expires_at', 'created_at'],
    fk: [{ table: 'posts', column: 'post_id' }, { table: 'users', column: 'user_id' }],
    // PostgreSQL は TEXT、D1 は INTEGER 主キー。文字列のまま往復させ、型差は報告する。
    idTypeMismatch: 'polls.id: postgres=TEXT / d1=INTEGER',
  },
  {
    table: 'poll_votes',
    columns: ['id', 'poll_id', 'user_id', 'option_id', 'other_text', 'created_at'],
    integers: ['user_id', 'option_id'],
    dates: ['created_at'],
    fk: [{ table: 'polls', column: 'poll_id' }, { table: 'users', column: 'user_id' }],
    idTypeMismatch: 'poll_votes.id: postgres=TEXT / d1=INTEGER',
  },
  {
    table: 'authorized_apps',
    columns: ['id', 'user_id', 'app_id', 'app_token_hash', 'app_name', 'app_icon_url', 'scopes', 'access_token_id',
      'access_token_hash', 'created_at', 'updated_at', 'last_used_at'],
    json: ['scopes'],
    integers: ['id', 'user_id'],
    dates: ['created_at', 'updated_at', 'last_used_at'],
    fk: [{ table: 'users', column: 'user_id' }],
    sequence: 'authorized_apps_id_seq',
  },
  {
    table: 'post_feedback',
    columns: ['user_id', 'post_id', 'kind', 'created_at'],
    integers: ['user_id', 'post_id'],
    dates: ['created_at'],
    fk: [{ table: 'users', column: 'user_id' }, { table: 'posts', column: 'post_id' }],
  },
]);

// 挿入順は外部キーの依存順。RESET は逆順。
const INSERT_ORDER = Object.freeze([
  'users',
  'user_auth_providers',
  'spaces',
  'space_channels',
  'space_members',
  'space_messages',
  'groups',
  'group_roles',
  'group_memberships',
  'group_invites',
  'group_join_requests',
  'posts',
  'polls',
  'poll_votes',
  'dm_channels',
  'group_dms',
  'group_dm_send_requests',
  'dm_e2e_keys',
  'sessions',
  'trusted_login_ips',
  'login_approvals',
  'account_recovery_requests',
  'blocked_login_ips',
  'bot_tokens',
  'authorized_apps',
  'follows',
  'likes',
  'stars',
  'reposts',
  'pinned_posts',
  'user_keyword_affinities',
  'post_feedback',
  'dm_messages',
  'notifications',
  'push_subscriptions',
  'moderation_reports',
  'mod_logs',
  'logs',
]);

// 移行対象外。理由を必ず持つ（「黙って落ちる」を防ぐためスナップショットに記録する）。
const EXCLUDED_TABLES = Object.freeze([
  {
    table: 'post_events',
    reason: '非同期処理の一時キュー。移行先で再生成されるため運搬しない（D1 ではトリガーが投入時に作るので、移行後に空にする）',
  },
  {
    table: 'community_notes',
    reason: '未対応: ノート本文・評価・配布・reputation の整合（トリガー連鎖）を再現する正規化が未実装',
  },
  { table: 'note_ratings', reason: '未対応: community_notes と同時に移す必要がある' },
  { table: 'note_reason_tag_defs', reason: '未対応: migration のシードで再生成できる定義表' },
  { table: 'note_reason_tags', reason: '未対応: community_notes に従属' },
  { table: 'note_distribution', reason: '未対応: community_notes に従属' },
  { table: 'note_rating_reasons', reason: '未対応: community_notes に従属' },
  { table: 'note_vote_admissions', reason: '未対応: community_notes に従属' },
  { table: 'note_creation_claims', reason: '未対応: community_notes から再構築できる' },
  { table: 'note_selection_identities', reason: '未対応: reputation 系' },
  { table: 'reputation_events', reason: '未対応: トリガーで reputation_daily を再計算するため単純コピー不可' },
  { table: 'reputation_daily', reason: '未対応: トリガーで reputation_profiles を再計算するため単純コピー不可' },
  { table: 'reputation_profiles', reason: '未対応: 上記の導出結果' },
  { table: 'reputation_scopes', reason: '未対応: reputation 系' },
  { table: 'reputation_notice_claims', reason: '未対応: reputation 系' },
  { table: 'reviewer_outcome_claims', reason: '未対応: reputation 系' },
  { table: 'reviewer_outcome_candidates', reason: '未対応: reputation 系' },
]);

const TABLE_COLUMNS = Object.freeze(Object.fromEntries(TABLE_SPECS.map((spec) => [spec.table, spec.columns])));
const TABLES = Object.freeze(INSERT_ORDER.slice());
const RESET_ORDER = Object.freeze(INSERT_ORDER.slice().reverse());
const SPEC_BY_TABLE = Object.freeze(Object.fromEntries(TABLE_SPECS.map((spec) => [spec.table, spec])));
const EXCLUDED_TABLE_NAMES = Object.freeze(EXCLUDED_TABLES.map((entry) => entry.table));

const ID_SEQUENCES = Object.freeze(Object.fromEntries(
  TABLE_SPECS.filter((spec) => spec.sequence).map((spec) => [spec.table, spec.sequence]),
));

function specFor(table) {
  return SPEC_BY_TABLE[table] || null;
}

// コピー対象の列（派生列を除く）。アダプタ側の実列と交差させて使う。
function transferableColumns(table) {
  const spec = specFor(table);
  if (!spec) return [];
  const derived = new Set(spec.derived || []);
  return spec.columns.filter((column) => !derived.has(column));
}

module.exports = {
  TABLE_SPECS,
  TABLES,
  TABLE_COLUMNS,
  INSERT_ORDER,
  RESET_ORDER,
  ID_SEQUENCES,
  EXCLUDED_TABLES,
  EXCLUDED_TABLE_NAMES,
  specFor,
  transferableColumns,
};
