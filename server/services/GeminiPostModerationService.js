const MODERATION_LEVELS = Object.freeze({
  safe: 1,
  low: 2,
  middle: 3,
  high: 4,
});

const MODERATION_MESSAGES = Object.freeze({
  low: '自動システムが不適切な可能性があるとして報告したため、ポストにワンクッションを付与しました。',
  middle: '自動システムが不適切な可能性があるとして報告したため、ポストを限定公開にしました。',
  high: '自動システムが不適切な可能性があるとして報告したため、ポストを限定公開にしました。',
});

const RATE_LIMIT_BACKOFF_MS = 90 * 1000;
const ERROR_BACKOFF_MS = 10 * 1000;
const REQUEST_TIMEOUT_MS = 30 * 1000;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function normalizeAttachments(attachments) {
  if (typeof attachments === 'string') {
    try {
      attachments = JSON.parse(attachments);
    } catch (_) {
      return [];
    }
  }
  return Array.isArray(attachments) ? attachments.filter(Boolean) : [];
}

function attachmentSignature(attachments) {
  return JSON.stringify(normalizeAttachments(attachments));
}

function getPrivateLevel(post) {
  const hasMask = Boolean(post?.mask);
  const hasLock = Boolean(post?.lock);
  if (hasLock && hasMask) return 4;
  if (hasLock) return 3;
  if (hasMask) return 2;
  return 1;
}

function parseModerationLevel(response) {
  const parts = response?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return MODERATION_LEVELS.safe;

  const responseText = parts
    .filter((part) => part && part.thought !== true)
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join('');
  const match = /<(safe|low|middle|high)>/i.exec(responseText);
  return match ? MODERATION_LEVELS[match[1].toLowerCase()] : MODERATION_LEVELS.safe;
}

function levelName(level) {
  return Object.entries(MODERATION_LEVELS)
    .find(([, value]) => value === level)?.[0] || 'safe';
}

function getImageMimeType(attachment, sourceContentType) {
  const candidates = [
    sourceContentType,
    attachment?.contentType,
    attachment?.type,
  ];
  for (const candidate of candidates) {
    const normalized = String(candidate || '').split(';', 1)[0].trim().toLowerCase();
    if (normalized.startsWith('image/')) return normalized;
  }
  return null;
}

class GeminiPostModerationService {
  constructor({ dbAdapter, storageAdapter, publishNotification, moderationConfig = {} }) {
    this.db = dbAdapter;
    this.storage = storageAdapter;
    this.publishNotification = publishNotification;
    this.config = moderationConfig;
    this.queue = [];
    this.processing = false;
    this.stopped = false;
  }

  get enabled() {
    return Boolean(
      this.config?.enabled
      && this.config?.apiKey
      && this.config?.model
      && this.config?.prompt,
    );
  }

  enqueue(post) {
    if (!this.enabled || !post?.id) return false;

    this.queue.push({
      postId: Number(post.id),
      content: String(post.content || ''),
      attachmentsSignature: attachmentSignature(post.attachments),
    });
    this._startProcessing();
    return true;
  }

  stop() {
    this.stopped = true;
    this.queue.length = 0;
  }

  _startProcessing() {
    if (this.processing || this.stopped) return;
    this.processing = true;
    void this._processQueue().catch((error) => {
      console.error('[gemini-moderation] queue stopped unexpectedly:', error.message);
    }).finally(() => {
      this.processing = false;
      if (!this.stopped && this.queue.length > 0) this._startProcessing();
    });
  }

  async _processQueue() {
    while (!this.stopped && this.queue.length > 0) {
      const job = this.queue.shift();
      try {
        await this._moderate(job);
      } catch (error) {
        const waitMs = Number(error?.statusCode) === 429
          ? RATE_LIMIT_BACKOFF_MS
          : ERROR_BACKOFF_MS;
        console.warn(
          `[gemini-moderation] post=${job.postId} failed; retrying after ${waitMs}ms:`,
          error.message,
        );
        this.queue.unshift(job);
        await delay(waitMs);
      }
    }
  }

  async _moderate(job) {
    const post = await this.db.getPostById(job.postId);
    if (!post) return;
    if (
      String(post.content || '') !== job.content
      || attachmentSignature(post.attachments) !== job.attachmentsSignature
    ) {
      // 編集済み投稿は作成済みの新しいキュー項目だけを判定する。
      return;
    }

    const level = await this._classify(post);
    if (level <= getPrivateLevel(post)) return;

    const name = levelName(level);
    const fields = {};
    if (level >= MODERATION_LEVELS.low) fields.mask = true;
    if (level >= MODERATION_LEVELS.middle) fields.lock = true;
    const updated = await this.db.updatePost(post.id, fields);
    if (!updated) return;

    const notification = await this.db.createNotification({
      userId: Number(post.userId),
      type: 'auto_moderation',
      fromUserId: null,
      target: { kind: 'post', id: Number(post.id) },
      message: MODERATION_MESSAGES[name],
    });
    if (notification && typeof this.publishNotification === 'function') {
      await this.publishNotification(Number(post.userId), notification);
    }
  }

  async _classify(post) {
    const model = String(this.config.model || '').trim().replace(/^models\//, '');
    if (!/^[A-Za-z0-9._-]+$/.test(model)) {
      throw new Error('GEMINI_MODEL has an invalid format');
    }

    const parts = [
      {
        text: `以下の投稿を判定してください。通常の応答本文の最初のラベルとして、<safe>、<low>、<middle>、<high> のいずれかを必ず1つだけ出力してください。\n\n投稿本文:\n${String(post.content || '(本文なし)')}`,
      },
      ...(await this._getImageParts(post.attachments)),
    ];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(this.config.apiKey)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            systemInstruction: {
              parts: [{ text: String(this.config.prompt) }],
            },
            contents: [{ parts }],
            generationConfig: {
              candidateCount: 1,
              maxOutputTokens: 64,
            },
          }),
        },
      );
      if (!response.ok) {
        const error = new Error(`Gemini API request failed (${response.status})`);
        error.statusCode = response.status;
        throw error;
      }
      return parseModerationLevel(await response.json());
    } finally {
      clearTimeout(timeout);
    }
  }

  async _getImageParts(attachments) {
    const maxImages = Math.max(0, Number(this.config.maxImages) || 0);
    if (maxImages === 0 || !this.storage || typeof this.storage.read !== 'function') return [];

    const parts = [];
    for (const attachment of normalizeAttachments(attachments)) {
      if (parts.length >= maxImages) break;
      const fileId = typeof attachment?.id === 'string' ? attachment.id : attachment?.key;
      if (typeof fileId !== 'string' || !fileId) continue;
      try {
        const file = await this.storage.read(fileId);
        const mimeType = getImageMimeType(attachment, file?.contentType);
        const buffer = Buffer.isBuffer(file?.buffer) ? file.buffer : Buffer.from(file?.buffer || '');
        if (!mimeType || buffer.length === 0) continue;
        parts.push({
          inlineData: {
            mimeType,
            data: buffer.toString('base64'),
          },
        });
      } catch (error) {
        console.warn(`[gemini-moderation] image read skipped for post attachment: ${error.message}`);
      }
    }
    return parts;
  }
}

module.exports = {
  GeminiPostModerationService,
  MODERATION_LEVELS,
  getPrivateLevel,
  parseModerationLevel,
};
