'use strict';

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const {
  TABLES,
  INSERT_ORDER,
  TABLE_SPECS,
  EXCLUDED_TABLES,
  EXCLUDED_TABLE_NAMES,
  specFor,
  transferableColumns,
} = require('./DataMigrationSchema');

// バージョン2: スナップショットが「どのテーブルを実際に含むか」を tables_present で明示する。
// バージョン1: 旧形式。テーブルの欠落が「空」なのか「未対応」なのか区別できない。
// 読み取りは両方を受け付けるが、書き出しは常に最新版にする。
const SNAPSHOT_VERSION = 2;
const SUPPORTED_SNAPSHOT_VERSIONS = Object.freeze([1, 2]);

const ADAPTER_NAMES = new Set(['memory', 'postgres', 'd1']);

function normalizeAdapterName(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'inmemory') return 'memory';
  if (normalized === 'pg') return 'postgres';
  if (normalized === 'cloudflare-d1') return 'd1';
  if (!ADAPTER_NAMES.has(normalized)) {
    throw new Error(`Unsupported database adapter: ${value || '(empty)'}`);
  }
  return normalized;
}

function cloneJson(value) {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value));
}

function normalizeDate(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function normalizeBoolean(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return cloneJson(value);
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function normalizeInteger(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function normalizeNumber(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeEpochMilliseconds(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return Math.trunc(numeric);
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeRow(table, input) {
  const row = input && typeof input === 'object' ? input : {};
  const value = { ...row };

  for (const key of Object.keys(value)) {
    if (value[key] instanceof Date) {
      value[key] = isNaN(value[key].getTime()) ? null : value[key].toISOString();
    }
  }

  if (table === 'users') {
    return {
      id: normalizeInteger(value.id),
      scid: value.scid || null,
      name: String(value.name || value.scid || ''),
      handle: value.handle || null,
      nyaitter_address: value.nyaitter_address || null,
      auth_provider: value.auth_provider || 'local',
      provider_domain: value.provider_domain || null,
      external_id: value.external_id || null,
      external_profile: parseJson(value.external_profile, null),
      uuid: value.uuid || null,
      settings: parseJson(value.settings, {}),
      bio: String(value.bio ?? value.me ?? ''),
      header_image: value.header_image || null,
      icon_data: value.icon_data || null,
      verify: normalizeBoolean(value.verify),
      admin: normalizeBoolean(value.admin),
      admin_request_excluded: normalizeBoolean(value.admin_request_excluded),
      freeze: value.freeze || null,
      shadow: normalizeBoolean(value.shadow),
      block: parseJson(value.block, []),
      account_operation: value.account_operation || null,
      created_at: normalizeDate(value.created_at ?? value.createdAt),
      // migration 034。未移行の古い行には無いので既定値へ落とす。
      note_rank: normalizeInteger(value.note_rank ?? value.noteRank, 0),
      note_affirmative_score: normalizeNumber(value.note_affirmative_score ?? value.noteAffirmativeScore, 0),
      note_max_per_day: normalizeInteger(value.note_max_per_day ?? value.noteMaxPerDay, 1),
      note_min_public_threshold: normalizeNumber(value.note_min_public_threshold ?? value.noteMinPublicThreshold, 0),
    };
  }

  if (table === 'posts') {
    return {
      id: normalizeInteger(value.id),
      user_id: normalizeInteger(value.user_id ?? value.userId),
      content: String(value.content ?? ''),
      attachments: parseJson(value.attachments, []),
      mask: normalizeBoolean(value.mask),
      lock: normalizeBoolean(value.lock),
      announcement: normalizeBoolean(value.announcement),
      reply_to: normalizeInteger(value.reply_to ?? value.replyTo),
      repost_to: normalizeInteger(value.repost_to ?? value.repostTo),
      tags: parseJson(value.tags, []).map((tag) => String(tag || '').trim().toLocaleLowerCase('ja-JP')).filter((tag) => tag.length > 0 && tag.length <= 48).slice(0, 5),
      tags_generated_at: normalizeDate(value.tags_generated_at ?? value.tagsGeneratedAt),
      group_id: value.group_id ?? value.groupId ?? null,
      group_announcement: normalizeBoolean(value.group_announcement ?? value.groupAnnouncement),
      created_at: normalizeDate(value.created_at ?? value.createdAt),
      // PostgreSQL にあって D1 に無い列。D1 側は実行時検出で読み飛ばす。
      view_content: value.view_content === undefined ? null : value.view_content,
      reply_control: value.reply_control ?? value.replyControl ?? 'everyone',
      scheduled_at: normalizeDate(value.scheduled_at ?? value.scheduledAt),
      recommendation_penalty: Math.max(0, normalizeNumber(value.recommendation_penalty ?? value.recommendationPenalty, 0)),
      // 派生カウンタは移行先で再計算する（投入値は使わない）。
      like_count: Math.max(0, normalizeInteger(value.like_count ?? value.likeCount, 0)),
      star_count: Math.max(0, normalizeInteger(value.star_count ?? value.starCount, 0)),
      repost_count: Math.max(0, normalizeInteger(value.repost_count ?? value.repostCount, 0)),
      reply_count: Math.max(0, normalizeInteger(value.reply_count ?? value.replyCount, 0)),
    };
  }

  if (table === 'groups') {
    return {
      id: value.id == null ? null : String(value.id),
      owner_id: normalizeInteger(value.owner_id ?? value.ownerId),
      name: String(value.name || ''),
      description: String(value.description || ''),
      icon_data: value.icon_data ?? value.iconData ?? null,
      header_image: value.header_image ?? value.headerImage ?? null,
      visibility: ['open', 'private', 'invite', 'open_invite'].includes(String(value.visibility)) ? String(value.visibility) : 'open',
      deleted_at: normalizeDate(value.deleted_at ?? value.deletedAt),
      created_at: normalizeDate(value.created_at ?? value.createdAt),
      updated_at: normalizeDate(value.updated_at ?? value.updatedAt),
    };
  }

  if (table === 'group_roles') {
    return {
      id: value.id == null ? null : String(value.id),
      group_id: value.group_id ?? value.groupId ?? null,
      name: String(value.name || ''),
      permissions: parseJson(value.permissions, []).map((permission) => String(permission || '').trim()).filter(Boolean),
      is_system: normalizeBoolean(value.is_system ?? value.isSystem),
      sort_order: normalizeInteger(value.sort_order ?? value.sortOrder, 0),
      created_at: normalizeDate(value.created_at ?? value.createdAt),
      updated_at: normalizeDate(value.updated_at ?? value.updatedAt),
    };
  }

  if (table === 'group_memberships') {
    return {
      group_id: value.group_id ?? value.groupId ?? null,
      user_id: normalizeInteger(value.user_id ?? value.userId),
      role_id: value.role_id ?? value.roleId ?? null,
      status: ['active', 'pending', 'invited', 'banned'].includes(String(value.status)) ? String(value.status) : 'active',
      joined_at: normalizeDate(value.joined_at ?? value.joinedAt),
      updated_at: normalizeDate(value.updated_at ?? value.updatedAt),
    };
  }

  if (table === 'group_invites') {
    return {
      id: value.id == null ? null : String(value.id),
      group_id: value.group_id ?? value.groupId ?? null,
      inviter_id: normalizeInteger(value.inviter_id ?? value.inviterId),
      invitee_id: normalizeInteger(value.invitee_id ?? value.inviteeId),
      status: ['pending', 'accepted', 'declined', 'cancelled'].includes(String(value.status)) ? String(value.status) : 'pending',
      created_at: normalizeDate(value.created_at ?? value.createdAt),
      responded_at: normalizeDate(value.responded_at ?? value.respondedAt),
    };
  }

  if (table === 'group_join_requests') {
    return {
      id: value.id == null ? null : String(value.id),
      group_id: value.group_id ?? value.groupId ?? null,
      user_id: normalizeInteger(value.user_id ?? value.userId),
      status: ['pending', 'approved', 'declined', 'cancelled'].includes(String(value.status)) ? String(value.status) : 'pending',
      reviewed_by: normalizeInteger(value.reviewed_by ?? value.reviewedBy),
      created_at: normalizeDate(value.created_at ?? value.createdAt),
      reviewed_at: normalizeDate(value.reviewed_at ?? value.reviewedAt),
    };
  }

  if (table === 'sessions') {
    return {
      session_id: value.session_id || value.id || null,
      token: value.token || null,
      user_id: normalizeInteger(value.user_id ?? value.userId),
      ip_hash: value.ip_hash ?? value.ipHash ?? null,
      ip_masked: value.ip_masked ?? value.ipMasked ?? null,
      user_agent: value.user_agent ?? value.userAgent ?? null,
      // PostgreSQL だけが持つ旧列。D1 には無いので実行時検出で読み飛ばす。
      ip: value.ip ?? null,
      expires_at: normalizeDate(value.expires_at ?? value.expiresAt),
      created_at: normalizeDate(value.created_at ?? value.createdAt),
    };
  }

  if (table === 'trusted_login_ips') {
    return {
      user_id: normalizeInteger(value.user_id ?? value.userId),
      ip_hash: value.ip_hash ?? value.ipHash ?? null,
      ip_masked: value.ip_masked ?? value.ipMasked ?? null,
      created_at: normalizeDate(value.created_at ?? value.createdAt),
      last_used_at: normalizeDate(value.last_used_at ?? value.lastUsedAt),
    };
  }

  if (table === 'login_approvals') {
    return {
      id: value.id || null,
      user_id: normalizeInteger(value.user_id ?? value.userId),
      ip_hash: value.ip_hash ?? value.ipHash ?? null,
      ip_masked: value.ip_masked ?? value.ipMasked ?? null,
      user_agent: value.user_agent ?? value.userAgent ?? null,
      // migration 023: 承認待ちのログイン元プロバイダー。
      auth_provider: value.auth_provider ?? value.authProvider ?? null,
      poll_token_hash: value.poll_token_hash ?? value.pollTokenHash ?? null,
      status: value.status || 'pending',
      created_at: normalizeDate(value.created_at ?? value.createdAt),
      expires_at: normalizeDate(value.expires_at ?? value.expiresAt),
      decided_at: normalizeDate(value.decided_at ?? value.decidedAt),
      consumed_at: normalizeDate(value.consumed_at ?? value.consumedAt),
    };
  }

  // 以降は migration 011/017/023/024 で追加されたテーブル。
  // 個別の正規化は列定義（DataMigrationSchema）から機械的に決まる。
  if (table === 'account_recovery_requests') {
    return {
      id: value.id == null ? null : String(value.id),
      user_id: normalizeInteger(value.user_id ?? value.userId),
      ip_hash: value.ip_hash ?? value.ipHash ?? null,
      ip_masked: value.ip_masked ?? value.ipMasked ?? null,
      user_agent: value.user_agent ?? value.userAgent ?? null,
      auth_provider: value.auth_provider ?? value.authProvider ?? null,
      request_token_hash: value.request_token_hash ?? value.requestTokenHash ?? null,
      status: value.status || 'waiting',
      trust_score: normalizeInteger(value.trust_score ?? value.trustScore, 0),
      wait_until: normalizeDate(value.wait_until ?? value.waitUntil),
      started_at: normalizeDate(value.started_at ?? value.startedAt),
      last_notified_at: normalizeDate(value.last_notified_at ?? value.lastNotifiedAt),
      notified_count: normalizeInteger(value.notified_count ?? value.notifiedCount, 0),
      decided_at: normalizeDate(value.decided_at ?? value.decidedAt),
      decided_by: value.decided_by ?? value.decidedBy ?? null,
      consumed_at: normalizeDate(value.consumed_at ?? value.consumedAt),
    };
  }

  if (table === 'blocked_login_ips') {
    return {
      user_id: normalizeInteger(value.user_id ?? value.userId),
      ip_hash: value.ip_hash ?? value.ipHash ?? null,
      ip_masked: value.ip_masked ?? value.ipMasked ?? null,
      reason: value.reason ?? null,
      source_recovery_id: value.source_recovery_id ?? value.sourceRecoveryId ?? null,
      created_at: normalizeDate(value.created_at ?? value.createdAt),
    };
  }

  if (table === 'polls') {
    return {
      // PostgreSQL は TEXT、D1 は INTEGER 主キー。文字列で往復させる。
      id: value.id == null ? null : String(value.id),
      post_id: normalizeInteger(value.post_id ?? value.postId),
      user_id: normalizeInteger(value.user_id ?? value.userId),
      title: String(value.title ?? ''),
      options: parseJson(value.options, []),
      allow_multiple: normalizeBoolean(value.allow_multiple ?? value.allowMultiple),
      allow_other: normalizeBoolean(value.allow_other ?? value.allowOther),
      show_results_before_voting: normalizeBoolean(value.show_results_before_voting ?? value.showResultsBeforeVoting ?? true),
      expires_at: normalizeDate(value.expires_at ?? value.expiresAt),
      closed: normalizeBoolean(value.closed),
      closed_notified: normalizeBoolean(value.closed_notified ?? value.closedNotified),
      created_at: normalizeDate(value.created_at ?? value.createdAt),
    };
  }

  if (table === 'poll_votes') {
    return {
      id: value.id == null ? null : String(value.id),
      poll_id: value.poll_id == null && value.pollId == null ? null : String(value.poll_id ?? value.pollId),
      user_id: normalizeInteger(value.user_id ?? value.userId),
      option_id: normalizeInteger(value.option_id ?? value.optionId),
      other_text: value.other_text ?? value.otherText ?? null,
      created_at: normalizeDate(value.created_at ?? value.createdAt),
    };
  }

  if (table === 'authorized_apps') {
    return {
      id: normalizeInteger(value.id),
      user_id: normalizeInteger(value.user_id ?? value.userId),
      app_id: value.app_id ?? value.appId ?? null,
      app_token_hash: value.app_token_hash ?? value.appTokenHash ?? null,
      app_name: String(value.app_name ?? value.appName ?? ''),
      app_icon_url: value.app_icon_url ?? value.appIconUrl ?? null,
      scopes: parseJson(value.scopes, []),
      access_token_id: value.access_token_id ?? value.accessTokenId ?? null,
      access_token_hash: value.access_token_hash ?? value.accessTokenHash ?? null,
      created_at: normalizeDate(value.created_at ?? value.createdAt),
      updated_at: normalizeDate(value.updated_at ?? value.updatedAt),
      last_used_at: normalizeDate(value.last_used_at ?? value.lastUsedAt),
    };
  }

  if (table === 'post_feedback') {
    return {
      user_id: normalizeInteger(value.user_id ?? value.userId),
      post_id: normalizeInteger(value.post_id ?? value.postId),
      kind: String(value.kind || 'not_interested'),
      created_at: normalizeDate(value.created_at ?? value.createdAt),
    };
  }

  if (table === 'bot_tokens') {
    return {
      token_id: value.token_id ?? value.tokenId ?? null,
      token_hash: value.token_hash ?? value.tokenHash ?? null,
      user_id: normalizeInteger(value.user_id ?? value.userId),
      name: String(value.name || ''),
      created_at: normalizeDate(value.created_at ?? value.createdAt),
      last_used_at: normalizeDate(value.last_used_at ?? value.lastUsedAt),
    };
  }

  if (table === 'user_keyword_affinities') {
    return {
      user_id: normalizeInteger(value.user_id ?? value.userId),
      keyword: String(value.keyword || '').trim().toLocaleLowerCase('ja-JP').slice(0, 48),
      score: Math.max(0, Number(value.score) || 0),
      updated_at: normalizeDate(value.updated_at ?? value.updatedAt),
    };
  }

  if (['likes', 'stars', 'reposts', 'pinned_posts'].includes(table)) {
    return {
      user_id: normalizeInteger(value.user_id ?? value.userId),
      post_id: normalizeInteger(value.post_id ?? value.postId),
      created_at: normalizeDate(value.created_at ?? value.createdAt),
    };
  }

  if (table === 'follows') {
    return {
      follower_id: normalizeInteger(value.follower_id ?? value.followerId),
      following_id: normalizeInteger(value.following_id ?? value.followingId),
      created_at: normalizeDate(value.created_at ?? value.createdAt),
    };
  }

  if (table === 'dm_channels') {
    return {
      id: value.id || null,
      participants: parseJson(value.participants, []).map(Number).filter(Number.isSafeInteger),
      created_at: normalizeDate(value.created_at ?? value.createdAt),
    };
  }

  if (table === 'dm_messages') {
    return {
      id: normalizeInteger(value.id),
      channel_id: value.channel_id ?? value.channelId ?? null,
      sender_id: normalizeInteger(value.sender_id ?? value.senderId),
      content: String(value.content ?? ''),
      sent_at: normalizeDate(value.sent_at ?? value.sentAt),
      read_at: normalizeDate(value.read_at ?? value.readAt),
    };
  }

  if (table === 'group_dms') {
    return {
      id: value.id == null ? null : String(value.id),
      host_id: normalizeInteger(value.host_id ?? value.hostId),
      title: String(value.title || ''),
      member: parseJson(value.member, []).map(Number).filter(Number.isSafeInteger),
      post: parseJson(value.post, []),
      unread: { ...parseJson(value.unread, {}), ...(Array.isArray(value.accepted) ? { _accepted: value.accepted } : {}) },
      time: normalizeDate(value.time),
      created_at: normalizeDate(value.created_at ?? value.createdAt),
      // migration 032 の集約キャッシュ。移行先で post から再計算する。
      message_count: Math.max(0, normalizeInteger(value.message_count ?? value.messageCount, 0)),
      latest_message: value.latest_message === undefined ? null : parseJson(value.latest_message, null),
      state_version: Math.max(0, normalizeInteger(value.state_version, 0)),
    };
  }

  if (table === 'group_dm_send_requests') {
    return {
      dm_id: String(value.dm_id),
      sender_id: normalizeInteger(value.sender_id),
      request_id: String(value.request_id),
      request_hash: String(value.request_hash),
      response_message: parseJson(value.response_message, null),
    };
  }

  if (table === 'dm_e2e_keys') {
    return {
      user_id: normalizeInteger(value.user_id ?? value.userId),
      public_key: value.public_key ?? value.publicKey ?? null,
      created_at: normalizeDate(value.created_at ?? value.createdAt),
      updated_at: normalizeDate(value.updated_at ?? value.updatedAt),
    };
  }

  if (table === 'notifications') {
    return {
      id: normalizeInteger(value.id),
      user_id: normalizeInteger(value.user_id ?? value.userId),
      type: value.type || null,
      from_user_id: normalizeInteger(value.from_user_id ?? value.fromUserId),
      post_id: normalizeInteger(value.post_id ?? value.postId),
      target: parseJson(value.target, null),
      message: value.message || null,
      // PostgreSQL だけが持つ列。D1 には無いので実行時検出で読み飛ばす。
      open: value.open ?? null,
      read: normalizeBoolean(value.read),
      clicked: normalizeBoolean(value.clicked),
      created_at: normalizeDate(value.created_at ?? value.createdAt),
    };
  }

  if (table === 'push_subscriptions') {
    return {
      user_id: normalizeInteger(value.user_id ?? value.userId),
      endpoint: value.endpoint || null,
      expiration_time: normalizeEpochMilliseconds(value.expiration_time ?? value.expirationTime),
      p256dh: value.p256dh || null,
      auth: value.auth || null,
      session_token: value.session_token ?? value.sessionToken ?? null,
      created_at: normalizeDate(value.created_at ?? value.createdAt),
      updated_at: normalizeDate(value.updated_at ?? value.updatedAt),
    };
  }

  if (table === 'moderation_reports') {
    return {
      id: normalizeInteger(value.id),
      reporter_user_id: normalizeInteger(value.reporter_user_id ?? value.reporterUserId),
      target_kind: value.target_kind ?? value.targetKind ?? null,
      target_id: String(value.target_id ?? value.targetId ?? ''),
      description: String(value.description || ''),
      target_snapshot: parseJson(value.target_snapshot ?? value.targetSnapshot, {}),
      assignment_type: value.assignment_type ?? value.assignmentType ?? 'report',
      status: value.status || 'pending',
      assigned_admin_id: normalizeInteger(value.assigned_admin_id ?? value.assignedAdminId),
      assigned_at: normalizeDate(value.assigned_at ?? value.assignedAt),
      excluded_admin_ids: parseJson(value.excluded_admin_ids ?? value.excludedAdminIds, []),
      resolution: parseJson(value.resolution, null),
      created_at: normalizeDate(value.created_at ?? value.createdAt),
      resolved_at: normalizeDate(value.resolved_at ?? value.resolvedAt),
      claimed_at: normalizeDate(value.claimed_at ?? value.claimedAt),
    };
  }

  if (table === 'user_auth_providers') {
    return {
      id: normalizeInteger(value.id),
      user_id: normalizeInteger(value.user_id ?? value.userId),
      provider: String(value.provider || '').toLowerCase(),
      provider_user_id: String(value.provider_user_id ?? value.providerUserId ?? ''),
      provider_profile: parseJson(value.provider_profile ?? value.providerProfile, {}),
      created_at: normalizeDate(value.created_at ?? value.createdAt),
    };
  }

  if (table === 'spaces') {
    return {
      stage_settings: value.stage_settings || null,
      id: String(value.id || ''),
      owner_id: normalizeInteger(value.owner_id ?? value.ownerId),
      name: String(value.name || ''),
      description: String(value.description || ''),
      icon_data: value.icon_data ?? value.iconData ?? null,
      header_image: value.header_image ?? value.headerImage ?? null,
      visibility: value.visibility || 'public',
      // migration 028: グループ限定スペースの参照先。無いDBでは null のまま。
      group_id: value.group_id ?? value.groupId ?? null,
      created_at: normalizeDate(value.created_at ?? value.createdAt),
      updated_at: normalizeDate(value.updated_at ?? value.updatedAt),
    };
  }

  if (table === 'space_channels') {
    return {
      id: String(value.id || ''),
      space_id: String(value.space_id ?? value.spaceId ?? ''),
      name: String(value.name || ''),
      kind: value.kind || 'text',
      sort_order: normalizeInteger(value.sort_order ?? value.sortOrder, 0),
      created_at: normalizeDate(value.created_at ?? value.createdAt),
    };
  }

  if (table === 'space_members') {
    return {
      space_id: String(value.space_id ?? value.spaceId ?? ''),
      user_id: normalizeInteger(value.user_id ?? value.userId),
      role: value.role || 'member',
      joined_at: normalizeDate(value.joined_at ?? value.joinedAt),
    };
  }

  if (table === 'space_messages') {
    return {
      id: normalizeInteger(value.id),
      space_id: String(value.space_id ?? value.spaceId ?? ''),
      channel_id: String(value.channel_id ?? value.channelId ?? ''),
      user_id: normalizeInteger(value.user_id ?? value.userId),
      content: String(value.content || ''),
      created_at: normalizeDate(value.created_at ?? value.createdAt),
    };
  }

  if (table === 'mod_logs') {
    return {
      id: value.id,
      created_at: value.created_at ?? value.createdAt,
      actor_type: value.actor_type ?? value.actorType,
      actor_id: value.actor_id ?? value.actorId ?? null,
      action: value.action,
      target_type: value.target_type ?? value.targetType,
      target_id: value.target_id ?? value.targetId,
      result: value.result,
    };
  }

  if (table === 'logs') {
    return {
      id: normalizeInteger(value.id),
      scratch_id: value.scratch_id ?? value.scid ?? null,
      nyaitter_id: normalizeInteger(value.nyaitter_id ?? value.user_id),
      masked_ip_uuid: value.masked_ip_uuid ?? null,
      log_time: normalizeDate(value.log_time ?? value.logTime),
    };
  }

  return cloneJson(value);
}

// スナップショットが実際に含むテーブルを判定する。
// - version 2: tables_present が唯一の根拠。無いテーブルは「宛先の既存データを保持」。
// - version 1: 旧形式。キーの有無しか手掛かりが無いため、キーが無いテーブルは
//   「未対応で省略された」とみなして保持する（mod_logs と同じ扱い）。
// - mod_logs_present === false は後方互換のため常に「保持」を意味する。
//
// version 2 で tables にだけ存在するキー（tables_present に無い）は省略として扱う。
// ここで「tables のキーなら含む」と寄せてしまうと、createSnapshot が全テーブルの
// キーを作るため、一度 writeSnapshot → readSnapshot を通した時点で tables_present が
// 全表に膨らみ、省略したはずのテーブルが宛先で空に上書きされる（v2 の契約が崩れる）。
function resolvePresentTables(snapshot, sourceTables) {
  const version = Number(snapshot?.version);
  const declared = Array.isArray(snapshot?.tables_present) ? snapshot.tables_present : null;
  const explicit = version >= 2 && declared !== null;
  const present = new Set();
  if (explicit) {
    for (const table of declared) {
      if (TABLES.includes(table)) present.add(table);
    }
  } else {
    // version 1（および後方互換で tables_present を持たない版）はキーの有無で判定する。
    for (const table of TABLES) {
      if (Object.prototype.hasOwnProperty.call(sourceTables, table)) present.add(table);
    }
  }
  if (explicit) {
    // tables_present に載っていない表の行が混ざっていたら、黙って捨てずに失敗する。
    for (const [table, rows] of Object.entries(sourceTables)) {
      if (!TABLES.includes(table) || present.has(table)) continue;
      if (Array.isArray(rows) && rows.length) {
        throw new Error(`Migration snapshot table ${table} has rows but is not listed in tables_present`);
      }
    }
  }
  if (snapshot?.mod_logs_present === false) present.delete('mod_logs');
  return present;
}

function validateModLogs(rows) {
  const ids = new Set();
  for (const row of rows) {
    if (typeof row.id !== 'string' || !row.id || ids.has(row.id) ||
        ['created_at', 'actor_type', 'action', 'target_type', 'target_id', 'result'].some((key) => typeof row[key] !== 'string' || !row[key]) ||
        (row.actor_id !== null && typeof row.actor_id !== 'string')) {
      throw new TypeError('Invalid or duplicate mod log in migration snapshot');
    }
    ids.add(row.id);
  }
}

function normalizeSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new TypeError('Migration snapshot must be an object');
  }
  const version = Number(snapshot.version);
  if (!SUPPORTED_SNAPSHOT_VERSIONS.includes(version)) {
    throw new Error(`Unsupported migration snapshot version: ${snapshot.version}`);
  }
  const sourceTables = snapshot.tables && typeof snapshot.tables === 'object' ? snapshot.tables : {};
  const present = resolvePresentTables(snapshot, sourceTables);
  const tables = {};
  for (const table of TABLES) {
    const included = present.has(table);
    const rows = included ? (sourceTables[table] ?? []) : [];
    if (!Array.isArray(rows)) throw new TypeError(`Migration snapshot table ${table} must be an array`);
    tables[table] = rows.map((row) => normalizeRow(table, row));
    if (table === 'mod_logs' && included) validateModLogs(tables[table]);
  }
  const excluded = Array.isArray(snapshot.excluded_tables)
    ? snapshot.excluded_tables.filter((entry) => entry && typeof entry.table === 'string')
    : [];
  // 「このDBには無い列」の記録。ファイル往復やD1境界を越えても失わない。
  const skippedColumns = {};
  if (snapshot.skipped_columns && typeof snapshot.skipped_columns === 'object') {
    for (const [table, columns] of Object.entries(snapshot.skipped_columns)) {
      if (!TABLES.includes(table) || !Array.isArray(columns)) continue;
      const names = columns.filter((column) => typeof column === 'string' && column);
      if (names.length) skippedColumns[table] = names;
    }
  }
  return {
    version: SNAPSHOT_VERSION,
    source_version: version,
    created_at: normalizeDate(snapshot.created_at) || new Date().toISOString(),
    source_adapter: snapshot.source_adapter || null,
    // 後方互換フィールド。新しい判定は tables_present を使う。
    mod_logs_present: present.has('mod_logs'),
    // 実際に含むテーブルの一覧。ここに無いテーブルは置換時に保持される。
    tables_present: TABLES.filter((table) => present.has(table)),
    excluded_tables: excluded,
    ...(Object.keys(skippedColumns).length ? { skipped_columns: skippedColumns } : {}),
    tables,
  };
}

function signSnapshot(unsignedSnapshot) {
  return {
    ...unsignedSnapshot,
    checksum: crypto.createHash('sha256').update(JSON.stringify(unsignedSnapshot)).digest('hex'),
  };
}

function createSnapshot(sourceAdapter, rowsByTable) {
  const tables = {};
  const present = [];
  for (const table of TABLES) {
    const included = Object.prototype.hasOwnProperty.call(rowsByTable || {}, table);
    if (included) present.push(table);
    const rows = included ? rowsByTable[table] : [];
    tables[table] = Array.isArray(rows) ? rows.map((row) => normalizeRow(table, row)) : [];
  }
  if (present.includes('mod_logs')) validateModLogs(tables.mod_logs);
  return signSnapshot({
    version: SNAPSHOT_VERSION,
    created_at: new Date().toISOString(),
    source_adapter: normalizeAdapterName(sourceAdapter),
    // 省略（未対応）と明示的な空配列を区別する。省略されたテーブルは宛先で保持される。
    tables_present: present,
    mod_logs_present: present.includes('mod_logs'),
    excluded_tables: EXCLUDED_TABLES.map((entry) => ({ table: entry.table, reason: entry.reason })),
    tables,
  });
}

function verifySnapshotChecksum(snapshot) {
  if (!snapshot?.checksum) return normalizeSnapshot(snapshot);
  const { checksum, ...unsignedSnapshot } = snapshot;
  const expected = crypto.createHash('sha256').update(JSON.stringify(unsignedSnapshot)).digest('hex');
  if (checksum !== expected) throw new Error('Migration snapshot checksum does not match');
  return normalizeSnapshot(unsignedSnapshot);
}

function createAdapter(adapterName, prefix) {
  const type = normalizeAdapterName(adapterName);
  const variable = (name) => process.env[`${prefix}_${name}`] || '';

  if (type === 'memory') {
    const InMemoryAdapter = require('../adapters/database/InMemoryAdapter');
    return new InMemoryAdapter();
  }
  if (type === 'postgres') {
    const PostgresAdapter = require('../adapters/database/postgres/PostgresAdapter');
    return new PostgresAdapter({
      connectionString: variable('DATABASE_URL') || variable('POSTGRES_URL'),
      sslCa: variable('SSL_CA') || undefined,
      poolSize: Number(variable('POOL_SIZE')) || undefined,
      poolMin: Number(variable('POOL_MIN')) || undefined,
      transactionRetries: Number(variable('TRANSACTION_RETRIES')) || undefined,
      retryBaseDelayMs: Number(variable('RETRY_BASE_DELAY_MS')) || undefined,
    });
  }
  const D1Adapter = require('../adapters/database/d1/D1Adapter');
  return new D1Adapter({
    workerUrl: variable('D1_WORKER_URL'),
    authToken: variable('D1_WORKER_TOKEN'),
  });
}

async function writeSnapshot(filePath, snapshot) {
  const target = path.resolve(filePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
  return target;
}

async function readSnapshot(filePath) {
  const content = await fs.readFile(path.resolve(filePath), 'utf8');
  return verifySnapshotChecksum(JSON.parse(content));
}

module.exports = {
  SNAPSHOT_VERSION,
  SUPPORTED_SNAPSHOT_VERSIONS,
  TABLES,
  INSERT_ORDER,
  TABLE_SPECS,
  EXCLUDED_TABLES,
  EXCLUDED_TABLE_NAMES,
  specFor,
  transferableColumns,
  normalizeAdapterName,
  normalizeSnapshot,
  createSnapshot,
  signSnapshot,
  normalizeEpochMilliseconds,
  verifySnapshotChecksum,
  createAdapter,
  writeSnapshot,
  readSnapshot,
};
