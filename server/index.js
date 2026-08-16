require('dotenv').config({ path: __dirname + '/.env' });

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const swaggerUi = require('swagger-ui-express');
const swaggerDocument = require('./swagger-output.json');

const config = require('./config');

if (process.env.DEV_BYPASS_AUTH === 'true') {
    const isProd = (process.env.NODE_ENV || 'development') === 'production';
    console.warn(
        '\n⚠️  ⚠️  ⚠️  WARNING: DEV_BYPASS_AUTH is ENABLED  ⚠️  ⚠️  ⚠️',
    );
    console.warn(
        '     This completely disables Scratch authentication verification.',
    );
    console.warn(
        '     NEVER enable this in production or on publicly accessible servers.\n',
    );
    if (isProd) {
        console.error(
            '❌ FATAL: DEV_BYPASS_AUTH=true is not allowed when NODE_ENV=production. Refusing to start.',
        );
        process.exit(1);
    }
}

const { createDatabaseAdapter, createStorageAdapter } = require('./adapters');
const {
    csrfProtection,
    flexibleCors,
    securityHeaders,
    getAuthenticatedPrincipal,
} = require('./middleware/auth');
const {
    requestId,
    applyTrustProxy,
    requestLogger,
} = require('./middleware/system');
const { generalLimiter, authLimiter } = require('./middleware/rateLimit');
const ConnectionManager = require('./services/realtime/ConnectionManager');
const PushNotificationService = require('./services/PushNotificationService');
const {
    ModerationReportService,
} = require('./services/ModerationReportService');
const {
    startModerationAssignmentScheduler,
} = require('./services/ModerationAssignmentScheduler');
const { serializeNotification } = require('./utils/serialize');
const { getPublicUrl } = require('./utils/nyaitterAddress');
const { startOperatorControlServer } = require('./utils/operatorControl');

const app = express();
app.disable('x-powered-by'); // セキュリティ: Express バージョンを隠す

const PORT = config.server.port;
const httpServer = http.createServer(app);
const realtimeConnections = new ConnectionManager();
const realtimeServer = new WebSocketServer({
    noServer: true,
    maxPayload: 8 * 1024,
    perMessageDeflate: false,
});
app.locals.realtime = realtimeConnections;

applyTrustProxy(app);

// API以外の静的アセットには本文解析・ID生成・CORS/CSRF処理を行わない。
// 高頻度のCSS・JS・画像配信で不要なCPU消費と短命オブジェクトの生成を抑える。
app.use('/server', express.json({ limit: config.server.jsonBodyLimit }));
app.use(
    '/server',
    express.urlencoded({
        extended: true,
        limit: config.server.jsonBodyLimit,
        parameterLimit: 100,
    }),
);
app.use('/server', requestId);

app.use(securityHeaders);

app.use('/server', flexibleCors);
app.use('/server', csrfProtection);

app.use('/server', generalLimiter);
app.use('/server/auth', authLimiter);
app.use('/server', requestLogger);

app.use(
	'/server/apidocs',
	swaggerUi.serve,
	swaggerUi.setup(swaggerDocument)
);

function isAllowedRealtimeOrigin(request) {
    const origin = request.headers.origin;
    if (!origin) return true;

    const allowedOrigins = new Set(config.cors.allowedOrigins || []);
    allowedOrigins.add(`http://localhost:${PORT}`);
    allowedOrigins.add(`http://127.0.0.1:${PORT}`);
    if (config.federation?.publicUrl) {
        try {
            allowedOrigins.add(new URL(config.federation.publicUrl).origin);
        } catch (_) {
            // Invalid public URL is ignored here; normal CORS configuration remains authoritative.
        }
    }

    const forwardedProto = String(request.headers['x-forwarded-proto'] || '')
        .split(',')[0]
        .trim();
    // x-forwarded-proto を無条件に信頼しない。
    const protocol =
        config.server.trustProxy && forwardedProto
            ? forwardedProto === 'https'
                ? 'https'
                : 'http'
            : request.socket.encrypted
              ? 'https'
              : 'http';
    const sameOrigin =
        request.headers.host &&
        origin === `${protocol}://${request.headers.host}`;
    return sameOrigin || allowedOrigins.has(origin);
}

function rejectRealtimeUpgrade(socket, status, message) {
    try {
        socket.write(
            `HTTP/1.1 ${status} ${message}\r\n` +
                'Connection: close\r\n' +
                'Content-Length: 0\r\n\r\n',
        );
    } finally {
        socket.destroy();
    }
}

async function handleRealtimeUpgrade(request, socket, head) {
    let parsedUrl;
    try {
        parsedUrl = new URL(
            request.url,
            `http://${request.headers.host || 'localhost'}`,
        );
    } catch (_) {
        return rejectRealtimeUpgrade(socket, 400, 'Bad Request');
    }
    if (parsedUrl.pathname !== '/server/realtime') {
        return socket.destroy();
    }
    if (!isAllowedRealtimeOrigin(request)) {
        return rejectRealtimeUpgrade(socket, 403, 'Forbidden');
    }

    // ブラウザの同一オリジンWebSocketハンドシェイクではHttpOnly Cookieが自動送信される。
    // URLクエリのBearerトークンはアクセスログ等に残るため受け付けない。
    const authRequest = {
        headers: { ...request.headers },
        app,
    };

    let principal;
    try {
        principal = await getAuthenticatedPrincipal(authRequest);
    } catch (error) {
        console.warn(
            '[realtime] WebSocket authentication failed:',
            error.message,
        );
        return rejectRealtimeUpgrade(socket, 500, 'Internal Server Error');
    }
    if (!principal) {
        return rejectRealtimeUpgrade(socket, 401, 'Unauthorized');
    }

    realtimeServer.handleUpgrade(request, socket, head, (webSocket) => {
        realtimeServer.emit('connection', webSocket, request, principal);
    });
}

httpServer.on('upgrade', (request, socket, head) => {
    void handleRealtimeUpgrade(request, socket, head);
});

realtimeServer.on('connection', (webSocket, _request, principal) => {
    const userId = principal.id;
    webSocket.isAlive = true;
    realtimeConnections.register(userId, webSocket);

    webSocket.on('pong', () => {
        webSocket.isAlive = true;
    });
    webSocket.on('message', (rawMessage, isBinary) => {
        if (isBinary) {
            webSocket.close(1003, 'Binary messages are not supported');
            return;
        }
        try {
            const message = JSON.parse(rawMessage.toString());
            if (message?.type === 'ping') {
                webSocket.send(JSON.stringify({ type: 'pong' }));
            }
        } catch (_) {}
    });
    webSocket.on('close', () =>
        realtimeConnections.unregister(userId, webSocket),
    );
    webSocket.on('error', () =>
        realtimeConnections.unregister(userId, webSocket),
    );

    Promise.all([
        realtimeConnections.publishNotificationUnreadCount(
            userId,
            app.locals.dbAdapter,
        ),
        realtimeConnections.publishDmUnreadCount(userId, app.locals.dbAdapter),
    ]).catch((error) => {
        console.warn(
            '[realtime] Failed to publish initial unread counts:',
            error.message,
        );
    });
});

const realtimeHeartbeat = setInterval(() => {
    for (const sockets of realtimeConnections.connectionsByUser.values()) {
        for (const webSocket of sockets) {
            if (webSocket.isAlive === false) {
                webSocket.terminate();
                continue;
            }
            webSocket.isAlive = false;
            webSocket.ping();
        }
    }
}, 30000);
realtimeHeartbeat.unref();

app.get('/server/health', async (req, res) => {
    const base = {
        status: 'ok',
        timestamp: new Date().toISOString(),
        version: '0.1.0',
        uptime: process.uptime(),
        env: process.env.NODE_ENV || 'development',
    };

    if (config.health.detailed) {
        try {
            const db = app.locals.dbAdapter;
            const dbStatus =
                db && typeof db.connect === 'function'
                    ? 'connected'
                    : 'unknown';

            base.details = {
                database: dbStatus,
                adapter: config.database.adapter,
                storage: config.storage.adapter,
            };
        } catch (e) {
            base.details = { error: 'Failed to collect detailed health info' };
        }
    }

    res.json(base);
});

app.get('/server/ready', async (req, res) => {
    try {
        const db = app.locals.dbAdapter;
        if (db && typeof db.getUserById === 'function') {
            await db.getUserById?.(-1); // should just return null, not throw
        }
        res.json({ status: 'ready', timestamp: new Date().toISOString() });
    } catch (err) {
        res.status(503).json({ status: 'not ready', error: err.message });
    }
});

app.use('/server/api', require('./routes/status'));
app.use('/server/api/posts', require('./routes/posts'));
app.use('/server/api/ranking', require('./routes/ranking'));
app.use('/server/api/ui', require('./routes/ui'));
app.use('/server/api/dm', require('./routes/dm'));
app.use('/server/api/users', require('./routes/users'));

app.use('/server/api/notifications', require('./routes/notifications'));
app.use('/server/api/reports', require('./routes/reports'));
app.use('/server/api/appeals', require('./routes/appeals'));
app.use(
    '/server/api/verification-applications',
    require('./routes/verificationApplications'),
);
app.use('/server/api/push', require('./routes/push'));

app.use('/server/auth', require('./routes/auth'));



// Must come AFTER API routes so /server/* takes precedence

const pageDir = path.join(__dirname, '../page');

app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        return next();
    }

    const urlPath = req.path;

    if (
        urlPath === '/index' ||
        urlPath === '/index.html' ||
        urlPath === '/page/index' ||
        urlPath === '/page/index.html' ||
        urlPath === '/page' ||
        urlPath === '/page/'
    ) {
        const query = req.url.includes('?')
            ? req.url.slice(req.url.indexOf('?'))
            : '';
        return res.redirect(301, '/' + query);
    }

    let cleanPath = urlPath;
    if (cleanPath.startsWith('/page/')) {
        cleanPath = '/' + cleanPath.slice(6);
    }

    // `/login` は専用ページを表示せず、クライアントのログインモーダルへ集約する。
    // 外部Nyaitter認証のstate/proofなどのコールバックパラメーターはそのままSPAへ渡す。
    if (cleanPath === '/login') {
        const rawQuery = req.url.includes('?')
            ? req.url.slice(req.url.indexOf('?') + 1)
            : '';
        const query = new URLSearchParams(rawQuery);
        if (query.get('external_login') !== '1') query.set('login', '1');
        const target = query.toString() ? `/?${query.toString()}` : '/?login=1';
        return res.redirect(302, target);
    }

    // 外部ログイン確認画面。クエリを保ったまま SPA に寄せる。
    if (cleanPath === '/auth/external') {
        const rawQuery = req.url.includes('?')
            ? req.url.slice(req.url.indexOf('?') + 1)
            : '';
        const query = new URLSearchParams(rawQuery);
        query.set('external_confirm', '1');
        const target = `/?${query.toString()}`;
        return res.redirect(302, target);
    }

    if (cleanPath.endsWith('.html')) {
        const targetPath = cleanPath.slice(0, -5); // strip .html
        const query = req.url.includes('?')
            ? req.url.slice(req.url.indexOf('?'))
            : '';
        return res.redirect(301, (targetPath || '/') + query);
    }

    if (!path.extname(cleanPath) && cleanPath !== '/') {
        const htmlFilePath = path.join(pageDir, cleanPath + '.html');
        if (fs.existsSync(htmlFilePath) && fs.statSync(htmlFilePath).isFile()) {
            return res.sendFile(htmlFilePath);
        }
    }

    next();
});

app.use(
    express.static(pageDir, {
        index: 'index.html',
        extensions: ['html'],
        setHeaders: (res, filePath) => {
            if (filePath.endsWith('/sw.js') || filePath.endsWith('\\sw.js')) {
                // A service worker must never remain stale after deployment.
                res.setHeader(
                    'Cache-Control',
                    'no-cache, no-store, must-revalidate',
                );
                return;
            }

            if (filePath.endsWith('.webmanifest')) {
                res.setHeader(
                    'Content-Type',
                    'application/manifest+json; charset=utf-8',
                );
            }

            // Page assets retain validators (ETag / Last-Modified), but must be
            // revalidated on every load. Changed files are therefore refreshed
            // automatically without manually changing query-string versions.
            res.setHeader(
                'Cache-Control',
                'public, max-age=0, must-revalidate',
            );
        },
    }),
);

// Serve uploaded files (for local storage adapter). Resolve relative paths from
// the process working directory, matching LocalStorageAdapter's resolution rule.
const configuredUploadDir = config.storage?.local?.uploadDir || './uploads';
const uploadsDir = path.isAbsolute(configuredUploadDir)
    ? configuredUploadDir
    : path.resolve(process.cwd(), configuredUploadDir);
app.use(
    '/uploads',
    express.static(uploadsDir, {
        maxAge: '7d',
        setHeaders: (res) => {
            res.setHeader('X-Content-Type-Options', 'nosniff');
        },
    }),
);

// The app uses hash routing (#/post/123 etc.), so we do NOT need a catch-all
// rewrite to index.html. If someone hits a non-existent deep path without
// hash, Express will naturally 404 — which is acceptable for now.

app.use((err, req, res, next) => {
    console.error('[server] Unhandled error:', err);

    const status = err.status || 500;
    const isDev = process.env.NODE_ENV === 'development';

    res.status(status).json({
        error: err.name || 'Internal Server Error',
        message: isDev ? err.message : 'An unexpected error occurred',
        ...(isDev && { stack: err.stack }),
        requestId: req.id || undefined,
    });
});

app.use('/server', (req, res) => {
    res.status(404).json({
        error: 'Not Found',
        path: req.originalUrl,
    });
});

const dbAdapter = createDatabaseAdapter();
const storageAdapter = createStorageAdapter();
let operatorControl = null;
let moderationScheduler = null;
const pushNotificationService = new PushNotificationService({
    dbAdapter,
    pushConfig: config.push,
});

async function publishModerationNotification(userId, notification) {
    const structured = await serializeNotification(
        dbAdapter,
        notification,
        getPublicUrl(),
    );
    if (!structured) return;
    try {
        await realtimeConnections.publishNewNotification(
            userId,
            structured,
            dbAdapter,
        );
    } catch (error) {
        console.warn(
            '[moderation] realtime notification delivery failed:',
            error.message,
        );
    }
    if (pushNotificationService.enabled) {
        void pushNotificationService
            .sendNotificationToUser(userId, structured)
            .catch((error) => {
                console.warn(
                    '[moderation] push notification delivery failed:',
                    error.message,
                );
            });
    }
}

const moderationReportService = new ModerationReportService({
    dbAdapter,
    storageAdapter,
    publishNotification: publishModerationNotification,
});
app.locals.pushNotificationService = pushNotificationService;
app.locals.moderationReportService = moderationReportService;

async function startServer() {
    await dbAdapter.connect();
    app.locals.dbAdapter = dbAdapter;
    app.locals.storageAdapter = storageAdapter;
    app.locals.pushNotificationService = pushNotificationService;
    app.locals.moderationReportService = moderationReportService;
    moderationScheduler = startModerationAssignmentScheduler(
        moderationReportService,
    );
    operatorControl = await startOperatorControlServer({
        dbAdapter,
        shutdown,
        getStatus: () => ({
            pid: process.pid,
            port: PORT,
            databaseAdapter: config.database.adapter,
            startedAt: new Date().toISOString(),
        }),
    });
    console.log(
        `[operator-control] Listening on ${operatorControl.socketPath}`,
    );

    httpServer.listen(PORT, () => {
        console.log(`
╔══════════════════════════════════════════════════════════════
║  Nyaitter Server                                           
╠══════════════════════════════════════════════════════════════
║  Server running at:   http://localhost:${PORT}
║
║  Health check:        http://localhost:${PORT}/server/health
║  Frontend (SPA):      http://localhost:${PORT}/
║
║  DB Adapter:      ${process.env.DB_ADAPTER || 'memory'}
║  Storage Adapter: ${process.env.STORAGE_ADAPTER || 'local'}
╚══════════════════════════════════════════════════════════════
`);
        console.log('[server] Ready. DB Adapter initialized.');
    });
}

startServer().catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
});

let isShuttingDown = false;

async function shutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log(`\n[server] ${signal} received. Starting graceful shutdown...`);

    try {
        clearInterval(realtimeHeartbeat);
        moderationScheduler?.stop();
        moderationScheduler = null;
        realtimeConnections.closeAll();
        if (operatorControl) {
            await operatorControl.close();
            operatorControl = null;
        }
        await new Promise((resolve) => {
            if (!httpServer.listening) return resolve();
            httpServer.close(() => resolve());
        });

        if (dbAdapter && typeof dbAdapter.disconnect === 'function') {
            await dbAdapter.disconnect();
            console.log('[server] Database adapter disconnected.');
        }

        if (storageAdapter && typeof storageAdapter.disconnect === 'function') {
            await storageAdapter.disconnect?.();
        }

        console.log('[server] Graceful shutdown complete. Exiting.');
        process.exit(0);
    } catch (err) {
        console.error('[server] Error during shutdown:', err);
        process.exit(1);
    }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (err) => {
    console.error('[server] Uncaught Exception:', err);
    shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
    console.error('[server] Unhandled Rejection:', reason);
});
