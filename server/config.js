let rawConfig;
try {
  rawConfig = require('./config.json');
} catch (e) {
  console.error('[config] Failed to load server/config.json. Using minimal defaults.');
  rawConfig = {};
}

function get(path, defaultValue) {
  return path.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : defaultValue), rawConfig);
}

const config = {
  server: {
    port: parseInt(process.env.PORT, 10) || get('server.port', 3000),
    jsonBodyLimit: process.env.JSON_BODY_LIMIT || get('server.jsonBodyLimit', '2mb'),
    trustProxy: process.env.TRUST_PROXY === 'true' || get('server.trustProxy', false),
  },

  static: {
    jsCssCacheMaxAge: get('static.jsCssCacheMaxAge', 3600),
    assetCacheMaxAge: get('static.assetCacheMaxAge', 86400),
  },

  cors: {
    allowedOrigins: (process.env.ALLOWED_ORIGINS
      ? process.env.ALLOWED_ORIGINS.split(',')
      : get('cors.allowedOrigins', ['http://localhost:3000', 'http://127.0.0.1:3000'])
    ).map(o => o.trim()),
    credentials: get('cors.credentials', false),
    preflightMaxAge: get('cors.preflightMaxAge', 600),
  },

  limits: {
    postContentMax: get('limits.postContentMax', 1000),
    dmContentMax: get('limits.dmContentMax', 2000),
    timelineDefaultLimit: get('limits.timelineDefaultLimit', 30),
    userSearchDefaultLimit: get('limits.userSearchDefaultLimit', 20),
    userSearchMaxLimit: get('limits.userSearchMaxLimit', 100),
    dmMessagesDefaultLimit: get('limits.dmMessagesDefaultLimit', 50),
    dmMessagesMaxLimit: get('limits.dmMessagesMaxLimit', 100),
    parentPostPreviewLength: get('limits.parentPostPreviewLength', 100),
    followingDefaultLimit: get('limits.followingDefaultLimit', 100),
    maxFileUploadSizeMB: get('limits.maxFileUploadSizeMB', 10),
  },

	  auth: {
	    sessionExpiryDays: get('auth.sessionExpiryDays', 30),
	    verificationCodeExpiryMinutes: get('auth.verificationCodeExpiryMinutes', 15),
	    botTokenPrefix: get('auth.botTokenPrefix', 'bot_'),
	    sessionTokenBytes: get('auth.sessionTokenBytes', 32),
	    botTokenIdBytes: get('auth.botTokenIdBytes', 16),
	    verificationCodeBytes: get('auth.verificationCodeBytes', 4),
	  },

	  // VAPID private keys must only be supplied through environment variables
	  // in production. The public key is exposed only to authenticated clients.
	  push: {
	    vapidSubject: process.env.VAPID_SUBJECT || get('push.vapidSubject', ''),
	    vapidPublicKey: process.env.VAPID_PUBLIC_KEY || get('push.vapidPublicKey', ''),
	    vapidPrivateKey: process.env.VAPID_PRIVATE_KEY || get('push.vapidPrivateKey', ''),
	  },

	  inMemory: {
    initialUserId: get('inMemory.initialUserId', 0),
  },

  database: {
    adapter: process.env.DB_ADAPTER || get('database.adapter', 'memory'),
    postgres: get('database.postgres', {}),
    d1: {
      ...get('database.d1', {}),
      workerUrl: process.env.D1_WORKER_URL || get('database.d1.workerUrl', ''),
      // 認証トークンは本番では必ず環境変数から注入する。
      authToken: process.env.D1_WORKER_TOKEN || get('database.d1.authToken', ''),
      requestTimeoutMs: Math.min(60000, Math.max(100, Math.floor(Number(process.env.D1_REQUEST_TIMEOUT_MS || get('database.d1.requestTimeoutMs', 10000)) || 10000))),
      retryAttempts: Math.min(4, Math.max(0, Math.floor(Number(process.env.D1_RETRY_ATTEMPTS || get('database.d1.retryAttempts', 1)) || 0))),
      retryBaseDelayMs: Math.min(5000, Math.max(0, Math.floor(Number(process.env.D1_RETRY_BASE_DELAY_MS || get('database.d1.retryBaseDelayMs', 120)) || 0))),
      readCacheSeconds: Math.min(60, Math.max(0, Math.floor(Number(process.env.D1_READ_CACHE_SECONDS || get('database.d1.readCacheSeconds', 0)) || 0))),
      batchMaxItems: Math.min(500, Math.max(1, Math.floor(Number(process.env.D1_BATCH_MAX_ITEMS || get('database.d1.batchMaxItems', 100)) || 100))),
    },
  },

	storage: {
		adapter: process.env.STORAGE_ADAPTER || get('storage.adapter', 'local'),
		local: get('storage.local', { uploadDir: './uploads' }),
		r2: {
			...get('storage.r2', {}),
			cacheControl: process.env.R2_CACHE_CONTROL || get('storage.r2.cacheControl', 'public, max-age=31536000, immutable'),
			signedUrlCacheSeconds: Math.max(0, Number(process.env.R2_SIGNED_URL_CACHE_SECONDS || get('storage.r2.signedUrlCacheSeconds', 300)) || 0),
			retryAttempts: Math.max(0, Number(process.env.R2_RETRY_ATTEMPTS || get('storage.r2.retryAttempts', 2)) || 0),
				retryBaseDelayMs: Math.max(0, Number(process.env.R2_RETRY_BASE_DELAY_MS || get('storage.r2.retryBaseDelayMs', 120)) || 0),
				deleteConcurrency: Math.min(32, Math.max(1, Math.floor(Number(process.env.R2_DELETE_CONCURRENCY || get('storage.r2.deleteConcurrency', 8)) || 8))),
			},
	},

  logging: {
    level: process.env.LOG_LEVEL || get('logging.level', 'info'),
    pretty: get('logging.pretty', true),
    requestIdHeader: get('logging.requestIdHeader', 'x-request-id'),
  },

  rateLimit: {
    enabled: get('rateLimit.enabled', true),
    windowMs: get('rateLimit.windowMs', 60000),
    max: get('rateLimit.max', 1000),
    auth: {
      windowMs: get('rateLimit.auth.windowMs', 60000),
      max: get('rateLimit.auth.max', 100),
    },
  },

  security: {
    hsts: {
      enabled: get('security.hsts.enabled', false),
      maxAge: get('security.hsts.maxAge', 31536000),
      includeSubDomains: get('security.hsts.includeSubDomains', true),
    },
    helmet: {
      enabled: get('security.helmet.enabled', false),
    },
  },

  health: {
    detailed: get('health.detailed', false),
  },

  // Contributor badges are server-managed so the browser does not depend on
  // a separately deployed JSON asset.
  contributors: get('contributors', []).filter(Number.isInteger),

  federation: {
    // PUBLIC_URL is optional. When absent, public URLs are derived from each
    // request's protocol and host (with proxy headers honored only if trustProxy is enabled).
    publicUrl: process.env.PUBLIC_URL || get('federation.publicUrl', ''),
    domain: process.env.SERVER_DOMAIN || get('federation.domain', 'nyaitter.jp'),
    allow_external_login: get('federation.allow_external_login', true),
    trusted_servers: get('federation.trusted_servers', []),
  },

  raw: rawConfig,
};

function validateConfig() {
  const errors = [];
  const isProd = (process.env.NODE_ENV || 'development') === 'production';

  if (isProd) {
    if (!process.env.TURNSTILE_SECRET_KEY && !config.raw?.turnstile?.secret) {
      console.warn('[config] WARNING: TURNSTILE_SECRET_KEY is not set in production');
    }

    if (config.server.trustProxy === false) {
      console.warn('[config] WARNING: server.trustProxy should be true when running behind a reverse proxy in production');
    }

    if (config.database.adapter === 'memory') {
      console.warn('[config] WARNING: Using in-memory database in production is not recommended');
    }
  }

  if (config.server.port < 1 || config.server.port > 65535) {
    errors.push('server.port must be between 1 and 65535');
  }

  if (errors.length > 0) {
    console.error('[config] Configuration validation failed:');
    errors.forEach(e => console.error('  - ' + e));
    if (isProd) {
      process.exit(1);
    }
  }
}

validateConfig();

module.exports = config;
