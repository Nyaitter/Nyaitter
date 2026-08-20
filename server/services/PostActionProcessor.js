'use strict';

const PostService = require('./PostService');
const {
  serializeNotification,
} = require('../utils/serialize');
const {
  isOwnedAttachmentKey,
  normalizeContentType,
} = require('../adapters/storage/safeStoragePath');
const {
  canViewPost,
} = require('../utils/postVisibility');
const {
  createNotificationIfAllowed,
} = require('./NotificationDeliveryService');
const {
  resolvePostingUser,
  assertPostingUserWritable,
} = require('./auth/PostAsUserService');

function decodeBase64File(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0) {
    throw new Error('Invalid base64 file data');
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error('Invalid base64 file data');
  }
  return Buffer.from(value, 'base64');
}

function isValidAttachmentUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return true;
  if (value.startsWith('/')) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch (_) {
    return false;
  }
}

function validateAttachmentReferences(attachments, userId) {
  if (!Array.isArray(attachments)) {
    throw new Error('attachments must be an array');
  }

  for (const attachment of attachments) {
    if (!attachment || typeof attachment !== 'object') {
      throw new Error('Invalid attachment');
    }
    if (attachment.data !== undefined) {
      normalizeContentType(attachment.contentType);
      decodeBase64File(attachment.data);
      continue;
    }
    if (typeof attachment.id !== 'string' || !isOwnedAttachmentKey(attachment.id, userId)) {
      throw new Error('Attachment does not belong to the current user');
    }
    if (attachment.url !== undefined && !isValidAttachmentUrl(attachment.url)) {
      throw new Error('Invalid attachment URL');
    }
  }
}

function getAttachmentStorageKeys(attachments) {
  let parsed = attachments;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch (_) {
      parsed = null;
    }
  }
  if (!Array.isArray(parsed)) return [];
  return [...new Set(parsed
    .map((attachment) => attachment && (attachment.id || attachment.key || null))
    .filter((key) => typeof key === 'string' && key.length > 0))];
}

async function deleteStoredAttachments(storage, attachments, context) {
  const keys = getAttachmentStorageKeys(attachments);
  if (keys.length === 0 || !storage) return;
  try {
    if (typeof storage.deleteMany === 'function') {
      await storage.deleteMany(keys);
    } else if (typeof storage.delete === 'function') {
      await Promise.all(keys.map((key) => storage.delete(key)));
    }
  } catch (error) {
    console.warn(
      `[post-actions] Failed to delete ${keys.length} attachment(s) during ${context}:`,
      error.message,
    );
  }
}

async function publishNewNotification(context, userId, notification) {
  const structuredNotification = await serializeNotification(
    context.db,
    notification,
    context.publicUrl,
  );
  if (!structuredNotification) return;

  if (context.realtime) {
    try {
      await context.realtime.publishNewNotification(
        userId,
        structuredNotification,
        context.db,
      );
    } catch (error) {
      console.warn('[post-actions] notification realtime delivery failed:', error.message);
    }
  }

  if (context.pushService?.enabled) {
    void context.pushService.sendNotificationToUser(userId, structuredNotification, {
      publicUrl: context.publicUrl,
    }).catch((error) => {
      console.warn('[post-actions] notification push delivery failed:', error.message);
    });
  }
}

async function notifyPostAction(context, { userId, type, fromUserId, postId }) {
  if (Number(userId) === Number(fromUserId)) return;
  const notification = await createNotificationIfAllowed(context.db, {
    userId: Number(userId),
    type,
    fromUserId: Number(fromUserId),
    target: { kind: 'post', id: Number(postId) },
  });
  if (notification) await publishNewNotification(context, Number(userId), notification);
}

async function publishNewTimelinePost(context, post) {
  if (!post || post.replyTo != null || post.reply_to != null) return;
  if (!context.realtime?.publishPostToFollowers) return;
  try {
    await context.realtime.publishPostToFollowers(post.userId, context.db, post);
  } catch (error) {
    console.warn('[post-actions] timeline realtime delivery failed:', error.message);
  }
}

function enqueueGeminiModeration(context, post) {
  const service = context.autoModerationService;
  if (!service?.enabled || !post) return;
  try {
    service.enqueue(post);
  } catch (error) {
    console.warn('[post-actions] Gemini moderation enqueue failed:', error.message);
  }
}

function normalizeTargetPostId(value) {
  const postId = Number(value);
  return Number.isInteger(postId) && postId > 0 ? postId : null;
}

async function processCreatePostAction(context, payload) {
  const postingUser = assertPostingUserWritable(
    await resolvePostingUser(context.authRequest, context.db, payload.postAsUserId),
  );
  const userId = Number(postingUser.id);
  const content = typeof payload.content === 'string' ? payload.content.trim() : '';
  const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
  const replyTo = normalizeTargetPostId(payload.replyTo);
  const repostTo = normalizeTargetPostId(payload.repostTo);
  const isAnnouncement = payload.announcement === true;
  const isSimpleRepost = content.length === 0 && repostTo != null;

  if (!content && attachments.length === 0 && !isSimpleRepost) {
    throw new Error('content, attachments, or repost_to is required');
  }
  if (isAnnouncement && postingUser.admin !== true) {
    throw new Error('Only administrators can create announcements');
  }
  if (isAnnouncement && (replyTo || repostTo)) {
    throw new Error('Announcements cannot be replies or reposts');
  }

  validateAttachmentReferences(attachments, userId);
  const relatedPosts = new Map();
  for (const targetId of [replyTo, repostTo].filter(Boolean)) {
    const target = await context.db.getPostById(targetId);
    if (!target || !(await canViewPost(
      context.db,
      target,
      userId,
      null,
      null,
      postingUser,
    ))) {
      throw new Error('Post not found');
    }
    relatedPosts.set(targetId, target);
  }

  const processedAttachments = attachments.map((attachment) => {
    if (attachment.data !== undefined) {
      return {
        buffer: decodeBase64File(attachment.data),
        fileName: attachment.fileName || 'file',
        contentType: normalizeContentType(attachment.contentType),
      };
    }
    return attachment;
  });

  const postService = new PostService({
    dbAdapter: context.db,
    storageAdapter: context.storage,
  });
  const post = await postService.createPost({
    userId,
    content,
    attachments: processedAttachments,
    mask: Boolean(payload.mask),
    lock: Boolean(payload.lock),
    announcement: isAnnouncement,
    replyTo,
    repostTo,
  });

  const replyTarget = replyTo ? relatedPosts.get(replyTo) : null;
  const repostTarget = repostTo ? relatedPosts.get(repostTo) : null;
  if (replyTarget) {
    await notifyPostAction(context, {
      userId: replyTarget.userId,
      type: 'reply',
      fromUserId: userId,
      postId: post.id,
    });
  }
  if (repostTarget) {
    await notifyPostAction(context, {
      userId: repostTarget.userId,
      type: isSimpleRepost ? 'repost' : 'quote',
      fromUserId: userId,
      postId: post.id,
    });
  }

  const excludedNotificationIds = new Set([
    userId,
    Number(replyTarget?.userId),
    Number(repostTarget?.userId),
  ]);
  for (const match of content.matchAll(/@(\d+)/g)) {
    const mentionedUserId = Number(match[1]);
    if (!Number.isInteger(mentionedUserId) || mentionedUserId <= 0) continue;
    if (excludedNotificationIds.has(mentionedUserId)) continue;
    excludedNotificationIds.add(mentionedUserId);
    await notifyPostAction(context, {
      userId: mentionedUserId,
      type: 'mention',
      fromUserId: userId,
      postId: post.id,
    });
  }

  await publishNewTimelinePost(context, post);
  enqueueGeminiModeration(context, post);
  return post;
}

async function processDeletePostAction(context, { postId, userId, admin = false }) {
  const postToDelete = await context.db.getPostById(postId);
  if (!postToDelete) throw new Error('Post not found');

  const success = admin
    ? await context.db.adminDeletePost(postId)
    : await context.db.deletePost(postId, userId);
  if (!success) {
    throw new Error(admin ? 'Post not found' : 'You do not have permission to delete this post');
  }

  await deleteStoredAttachments(
    context.storage,
    postToDelete.attachments,
    admin ? 'admin post deletion' : 'post deletion',
  );
}

module.exports = {
  processCreatePostAction,
  processDeletePostAction,
};
