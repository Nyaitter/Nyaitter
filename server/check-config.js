#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const SERVER_DIR = __dirname;
const ENV_PATH = path.join(SERVER_DIR, '.env');
const CONFIG_PATH = path.join(SERVER_DIR, 'config.json');

dotenv.config({ path: ENV_PATH });

const issues = [];

function addIssue(level, code, message, resolution) {
    issues.push({ level, code, message, resolution });
}

function get(object, dottedPath, fallback) {
    return dottedPath
        .split('.')
        .reduce(
            (value, key) =>
                value && value[key] !== undefined ? value[key] : fallback,
            object,
        );
}

function setting(envName, config, configPath, fallback = '') {
    const envValue = process.env[envName];
    if (envValue !== undefined && envValue !== '') return envValue;
    return get(config, configPath, fallback);
}

function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim() !== '';
}

function isHttpUrl(value) {
    try {
        const url = new URL(String(value));
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch (_) {
        return false;
    }
}

function hasPlaceholder(value) {
    return /(?:^|[/:])(?:user|pass|password|example|changeme)(?:$|[/:@?])/i.test(
        String(value || ''),
    );
}

function inspect() {
    let config;
    try {
        config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (error) {
        addIssue(
            'error',
            'CONFIG_JSON_INVALID',
            `server/config.json を読み込めません: ${error.message}`,
            'server/config.json のJSON構文を修正してください。',
        );
        return;
    }

    const nodeEnv = String(process.env.NODE_ENV || 'development').toLowerCase();
    const isProduction = nodeEnv === 'production';

    const port = Number(setting('PORT', config, 'server.port', 3000));
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        addIssue(
            'error',
            'PORT_INVALID',
            `PORT が有効なTCPポートではありません: ${setting('PORT', config, 'server.port')}`,
            'PORT または server.port を1から65535までの整数に設定してください。',
        );
    }

    const apiEndpoint = String(
        setting('NYAITTER_API_ENDPOINT', config, 'server.apiEndpoint', '/server'),
    ).trim();
    if (!apiEndpoint.startsWith('/') || /[?#]/.test(apiEndpoint)) {
        addIssue(
            'error',
            'API_ENDPOINT_INVALID',
            `APIエンドポイントがパスとして無効です: ${apiEndpoint || '(空)'}`,
            'NYAITTER_API_ENDPOINT または server.apiEndpoint に /server、/、/v1 のような先頭が / のパスを設定してください。',
        );
    }

    const userFilesEndpoint = String(
        setting('NYAITTER_USER_FILES_ENDPOINT', config, 'userFiles.endpoint', ''),
    ).trim();
    const userFilesPortValue = setting(
        'NYAITTER_USER_FILES_PORT',
        config,
        'userFiles.port',
        '',
    );
    const userFilesPort = userFilesPortValue === '' || userFilesPortValue === null
        ? null
        : Number(userFilesPortValue);
    if (userFilesEndpoint && (!userFilesEndpoint.startsWith('/') || /[?#]/.test(userFilesEndpoint))) {
        addIssue(
            'error',
            'USER_FILES_ENDPOINT_INVALID',
            `ユーザーファイルの公開パスが無効です: ${userFilesEndpoint}`,
            'NYAITTER_USER_FILES_ENDPOINT または userFiles.endpoint に /uploads のような先頭が / のパスを設定してください。',
        );
    }
    if (userFilesPort !== null && (!Number.isInteger(userFilesPort) || userFilesPort < 1 || userFilesPort > 65535)) {
        addIssue(
            'error',
            'USER_FILES_PORT_INVALID',
            `ユーザーファイルの専用ポートが無効です: ${userFilesPortValue}`,
            'NYAITTER_USER_FILES_PORT または userFiles.port を1から65535までの整数に設定してください。',
        );
    }
    if (userFilesPort !== null && userFilesPort === port) {
        addIssue(
            'error',
            'USER_FILES_PORT_CONFLICT',
            'ユーザーファイルの専用ポートがServerポートと同じです。',
            'NYAITTER_USER_FILES_PORT と PORT には異なるポート番号を設定してください。',
        );
    }

    const databaseAdapter = String(
        setting('DB_ADAPTER', config, 'database.adapter', 'memory'),
    ).toLowerCase();
    if (!['memory', 'inmemory', 'postgres', 'pg', 'd1', 'cloudflare-d1'].includes(databaseAdapter)) {
        addIssue(
            'error',
            'DATABASE_ADAPTER_UNSUPPORTED',
            `未対応のDB_ADAPTERです: ${databaseAdapter || '(空)'}`,
            'DB_ADAPTER を memory、postgres、または d1 のいずれかに設定してください。',
        );
    }

    if (databaseAdapter === 'postgres' || databaseAdapter === 'pg') {
        const databaseUrl = setting(
            'DATABASE_URL',
            config,
            'database.postgres.connectionString',
        );
        if (!isHttpUrl(String(databaseUrl).replace(/^postgres(?:ql)?:/i, 'http:'))) {
            addIssue(
                'error',
                'DATABASE_URL_MISSING_OR_INVALID',
                'PostgreSQLを選択していますが、有効なDATABASE_URLがありません。',
                'DATABASE_URL に postgres://ユーザー:パスワード@ホスト:5432/データベース名 を設定してください。',
            );
        } else if (hasPlaceholder(databaseUrl)) {
            addIssue(
                'warning',
                'DATABASE_URL_PLACEHOLDER',
                'PostgreSQLの接続文字列に例示用の値が含まれている可能性があります。',
                'DATABASE_URL または database.postgres.connectionString を実際の接続情報に置き換えてください。',
            );
        }
    }

    if (databaseAdapter === 'd1' || databaseAdapter === 'cloudflare-d1') {
        const workerUrl = setting('D1_WORKER_URL', config, 'database.d1.workerUrl');
        const token = setting('D1_WORKER_TOKEN', config, 'database.d1.authToken');
        if (!isHttpUrl(workerUrl)) {
            addIssue(
                'error',
                'D1_WORKER_URL_MISSING_OR_INVALID',
                'D1を選択していますが、有効なD1_WORKER_URLがありません。',
                'D1_WORKER_URL にD1プロキシWorkerのHTTPS URLを設定してください。',
            );
        }
        if (!isNonEmptyString(token)) {
            addIssue(
                'error',
                'D1_WORKER_TOKEN_MISSING',
                'D1を選択していますが、D1_WORKER_TOKENがありません。',
                'D1_WORKER_TOKEN にD1プロキシWorkerと共有する認証トークンを設定してください。',
            );
        }
    }

    const storageAdapter = String(
        setting('STORAGE_ADAPTER', config, 'storage.adapter', 'local'),
    ).toLowerCase();
    if (!['local', 'filesystem', 'r2', 'cloudflare-r2'].includes(storageAdapter)) {
        addIssue(
            'error',
            'STORAGE_ADAPTER_UNSUPPORTED',
            `未対応のSTORAGE_ADAPTERです: ${storageAdapter || '(空)'}`,
            'STORAGE_ADAPTER を local または r2 に設定してください。',
        );
    }

    if (storageAdapter === 'r2' || storageAdapter === 'cloudflare-r2') {
        const requiredR2Settings = [
            ['R2_ACCOUNT_ID', 'storage.r2.accountId'],
            ['R2_BUCKET', 'storage.r2.bucket'],
            ['R2_ACCESS_KEY_ID', 'storage.r2.accessKeyId'],
            ['R2_SECRET_ACCESS_KEY', 'storage.r2.secretAccessKey'],
        ];
        const missing = requiredR2Settings
            .filter(([envName, configPath]) => !isNonEmptyString(setting(envName, config, configPath)))
            .map(([envName]) => envName);
        if (missing.length > 0) {
            addIssue(
                'error',
                'R2_SETTINGS_MISSING',
                `R2を選択していますが、必要な設定がありません: ${missing.join(', ')}`,
                '不足している値を server/.env または server/config.json の storage.r2 に設定してください。',
            );
        }
    }

    const clientRepository = String(
        setting('NYAITTER_CLIENT_REPOSITORY', config, 'client.repository', 'Nyaitter/Client'),
    ).trim();
    if (
        !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(clientRepository) &&
        !/^(https?|ssh):\/\//.test(clientRepository) &&
        !/^git@[^:]+:.+/.test(clientRepository)
    ) {
        addIssue(
            'error',
            'CLIENT_REPOSITORY_INVALID',
            `client.repository がGitリポジトリとして無効です: ${clientRepository || '(空)'}`,
            'NYAITTER_CLIENT_REPOSITORY または client.repository に owner/repository 形式かGit URLを設定してください。',
        );
    }

    const vapidSettings = [
        process.env.VAPID_SUBJECT || get(config, 'push.vapidSubject', ''),
        process.env.VAPID_PUBLIC_KEY || get(config, 'push.vapidPublicKey', ''),
        process.env.VAPID_PRIVATE_KEY || get(config, 'push.vapidPrivateKey', ''),
    ];
    const vapidCount = vapidSettings.filter(isNonEmptyString).length;
    if (vapidCount > 0 && vapidCount < 3) {
        addIssue(
            'error',
            'VAPID_SETTINGS_INCOMPLETE',
            'Push通知のVAPID設定が一部だけ指定されています。',
            'VAPID_SUBJECT、VAPID_PUBLIC_KEY、VAPID_PRIVATE_KEY をすべて設定するか、すべて未設定にしてください。',
        );
    }

    if (isProduction) {
        const publicUrl = setting('PUBLIC_URL', config, 'federation.publicUrl');
        if (!isHttpUrl(publicUrl)) {
            addIssue(
                'error',
                'PUBLIC_URL_MISSING_OR_INVALID',
                '本番環境ですが、有効なPUBLIC_URLがありません。',
                'PUBLIC_URL または federation.publicUrl に公開HTTPS URLを設定してください。',
            );
        }

        if (databaseAdapter === 'memory' || databaseAdapter === 'inmemory') {
            addIssue(
                'warning',
                'MEMORY_DATABASE_IN_PRODUCTION',
                '本番環境でインメモリDBを使用しています。再起動するとデータが消えます。',
                'DB_ADAPTER を postgres または d1 に変更し、対応する接続設定を追加してください。',
            );
        }

        const trustProxy = String(
            setting('TRUST_PROXY', config, 'server.trustProxy', 'false'),
        ).toLowerCase();
        if (!['true', '1', 'yes', 'on'].includes(trustProxy)) {
            addIssue(
                'warning',
                'TRUST_PROXY_DISABLED',
                '本番環境でTRUST_PROXYが無効です。リバースプロキシ配下ではIP・HTTPS判定が正しくない場合があります。',
                '信頼できるリバースプロキシの背後で運用する場合だけ TRUST_PROXY=true を設定してください。',
            );
        }
    }
}

inspect();

if (issues.length === 0) {
    console.log('[config-check] 設定上の不備は検出されませんでした。');
} else {
    for (const issue of issues) {
        const label = issue.level === 'error' ? 'ERROR' : 'WARNING';
        console.log(`\n[config-check] ${label} ${issue.code}`);
        console.log(`  内容: ${issue.message}`);
        console.log(`  対応: ${issue.resolution}`);
    }
}

const errorCount = issues.filter((issue) => issue.level === 'error').length;
const warningCount = issues.filter((issue) => issue.level === 'warning').length;
console.log(`\n[config-check] 結果: エラー ${errorCount}件、警告 ${warningCount}件`);

if (errorCount > 0) process.exitCode = 1;
