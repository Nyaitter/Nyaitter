#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { spawn } = require('child_process');
const {
    getOperatorSocketPath,
    parseUserId,
    requestOperatorCommand,
} = require('./utils/operatorControl');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const ENV_FILE = path.join(__dirname, '.env');
const STARTUP_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 100;

function printUsage() {
    console.log(`
nscli — Nyaitter ローカル管理CLI

使用方法:
  nscli  admin grant <#ユーザーID>
  nscli  admin revoke <#ユーザーID>
  nscli  admin list
  nscli  admin requests-exclude <#ユーザーID>
  nscli  admin requests-include <#ユーザーID>
  nscli  mod-logs [--actor-type 値] [--actor-id ID] [--action 値] [--target-type 値] [--target-id ID] [--result 値] [--from ISO時刻] [--to ISO時刻] [--limit 件数] [--before-time ISO時刻 --before-id ID]
  nscli  verify grant <#ユーザーID>
  nscli  verify revoke <#ユーザーID>
  nscli  verify list
  nscli  server start
  nscli  server stop
  nscli  server restart
  nscli  server status
    nscli  maintenance enable
    nscli  maintenance disable
    nscli  maintenance status
  nscli extension-key create --name <拡張名> --scope nyaitter-auth --redirect-origin <URL> [--output <保存先>]
  nscli extension-key list
  nscli extension-key revoke <キーID>

環境変数:
  NYAITTER_OPERATOR_SOCKET  ローカル制御ソケットのパス
`);
}

function formatStatus(status) {
    const adapter = status?.databaseAdapter || 'unknown';
    const port = status?.port || 'unknown';
    const pid = status?.pid || 'unknown';
    return `稼働中: PID ${pid}, port ${port}, DB ${adapter}`;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function readMaintenanceMode() {
    if (process.env.NYAITTER_MAINTENANCE_MODE !== undefined) {
        return /^(true|1|yes|on)$/i.test(process.env.NYAITTER_MAINTENANCE_MODE);
    }
    try {
        const content = fs.readFileSync(ENV_FILE, 'utf8');
        const match = content.match(/^NYAITTER_MAINTENANCE_MODE\s*=\s*(.*?)\s*$/m);
        return match ? /^(true|1|yes|on)$/i.test(match[1]) : false;
    } catch (_) {
        return false;
    }
}

function writeMaintenanceMode(enabled) {
    let content = '';
    try {
        content = fs.readFileSync(ENV_FILE, 'utf8');
    } catch (_) {}
    const line = `NYAITTER_MAINTENANCE_MODE=${enabled ? 'true' : 'false'}`;
    if (/^NYAITTER_MAINTENANCE_MODE\s*=.*$/m.test(content)) {
        content = content.replace(/^NYAITTER_MAINTENANCE_MODE\s*=.*$/m, line);
    } else {
        content = `${content.replace(/\s*$/, '')}\n${line}\n`;
    }
    fs.writeFileSync(ENV_FILE, content, 'utf8');
}

async function enableMaintenanceMode() {
    writeMaintenanceMode(true);
    const status = await getRunningStatus();
    if (status) {
        await stopServer();
    }
    console.warn('メンテナンスモードを有効にしました。解除するまでサーバーの起動を拒否します。');
}

async function getRunningStatus() {
    try {
        const response = await requestOperatorCommand(
            { action: 'status' },
            { timeoutMs: 500 },
        );
        return response?.ok ? response.status : null;
    } catch (_) {
        return null;
    }
}

async function waitForServer(expectedRunning) {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
        const status = await getRunningStatus();
        if (expectedRunning && status) return { matched: true, status };
        if (!expectedRunning && !status) return { matched: true, status: null };
        await sleep(POLL_INTERVAL_MS);
    }
    return { matched: false, status: null };
}

async function startServer() {
    const status = await getRunningStatus();
    if (status) {
        console.log(formatStatus(status));
        return;
    }

    const logPath = path.join(os.tmpdir(), 'nyaitter-server.log');
    const logFd = fs.openSync(logPath, 'a', 0o600);
    const child = spawn(process.execPath, ['server/index.js'], {
        cwd: PROJECT_ROOT,
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: process.env,
    });
    child.unref();
    fs.closeSync(logFd);

    if (readMaintenanceMode()) {
        console.warn('メンテナンスモードが有効なため、サーバーは起動しませんでした。');
        return;
    }

    const started = await waitForServer(true);
    if (!started.matched || !started.status) {
        throw new Error(`サーバーを起動できませんでした。ログ: ${logPath}`);
    }
    console.log(formatStatus(started.status));
}

async function stopServer() {
    const response = await requestOperatorCommand({ action: 'shutdown' });
    if (!response?.ok)
        throw new Error(response?.error || 'サーバー停止要求に失敗しました');

    const stopped = await waitForServer(false);
    if (!stopped.matched) throw new Error('サーバー停止がタイムアウトしました');
    console.log('サーバーを停止しました。');
}

async function restartServer() {
    const status = await getRunningStatus();
    if (status) await stopServer();
    await startServer();
}

async function setAdministrator(userIdArgument, admin) {
    const userId = parseUserId(userIdArgument);
    if (userId == null)
        throw new Error(
            'ユーザーIDは #3480 または 3480 形式の非負整数で指定してください',
        );

    const response = await requestOperatorCommand({
        action: 'set-admin',
        userId,
        admin,
    });
    if (!response?.ok)
        throw new Error(response?.error || '管理者権限の更新に失敗しました');
    console.log(
        `#${response.user.id} の管理者権限を${response.user.admin ? '付与' : '解除'}しました。`,
    );
}

async function setVerification(userIdArgument, verify) {
    const userId = parseUserId(userIdArgument);
    if (userId == null) throw new Error('ユーザーIDは #3480 または 3480 形式の非負整数で指定してください');
    const response = await requestOperatorCommand({ action: 'set-verify', userId, verify });
    if (!response?.ok) throw new Error(response?.error || '認証状態の更新に失敗しました');
    console.log(`#${response.user.id} の認証を${response.user.verify ? '付与' : '解除'}しました。`);
}

async function listOperatorUsers(field) {
    const response = await requestOperatorCommand({ action: 'list-operator-users', field });
    if (!response?.ok) throw new Error(response?.error || '一覧の取得に失敗しました');
    console.table(response.users);
}

async function main(argv) {
    const [group, command, argument] = argv;
    if (!group || group === '--help' || group === '-h' || group === 'help') {
        printUsage();
        return;
    }

    if (group === 'mod-logs') {
        const flags = { '--actor-type': 'actorType', '--actor-id': 'actorId', '--action': 'action', '--target-type': 'targetType', '--target-id': 'targetId', '--result': 'result', '--from': 'from', '--to': 'to', '--limit': 'limit', '--before-time': 'beforeTime', '--before-id': 'beforeId' };
        const filters = {};
        for (let i = 1; i < argv.length; i += 2) {
            const key = flags[argv[i]], value = argv[i + 1];
            if (!key || value === undefined || value.startsWith('--') || Object.hasOwn(filters, key)) throw new Error('無効なオプションです。');
            filters[key] = value;
        }
        require('./adapters/database/modLogs').normalizeFilters(filters);
        const response = await requestOperatorCommand({ action: 'search-mod-logs', filters });
        if (!response?.ok) throw new Error(response?.error || 'ModLogs の取得に失敗しました。');
        console.log(JSON.stringify({ logs: response.logs, nextCursor: response.nextCursor }, null, 2));
        return;
    }

    if (group === 'extension-key') {
        const service = require('./services/ExtensionKeyService');
        if (command === 'create') {
            const options = { redirectOrigins: [] };
            for (let index = 2; index < argv.length; index++) {
                const flag = argv[index];
                const value = argv[++index];
                if (!value || value.startsWith('--')) throw new Error(`${flag} の値を指定してください。`);
                if (flag === '--name') options.name = value;
                else if (flag === '--scope' || flag === '--scopes') options.scopes = value.split(',').map(scope => scope.trim()).filter(Boolean);
                else if (flag === '--redirect-origin') options.redirectOrigins.push(value);
                else if (flag === '--output') options.outputPath = path.resolve(value);
                else throw new Error(`未対応のオプション: ${flag}`);
            }
            const created = await service.createKey(options);
            console.log(`拡張キーを生成しました: ${created.id} (${created.name})`);
            if (options.outputPath) console.log(`保存先: ${options.outputPath}`);
            else console.log(`APIキー（再表示できません）: ${created.key}`);
            return;
        }
        if (command === 'list') {
            console.table((await service.listKeys()).map(key => ({
                id: key.id, name: key.name, scopes: key.scopes.join(','),
                status: key.revokedAt ? 'revoked' : 'active', redirectOrigins: key.redirectOrigins.join(','),
            })));
            return;
        }
        if (command === 'revoke') {
            if (!/^[a-f0-9]{32}$/.test(argument || '')) throw new Error('一覧に表示されるキーIDを指定してください。');
            await service.revokeKey(argument);
            console.log(`拡張キーを失効しました: ${argument}`);
            return;
        }
    }

    if (group === 'admin') {
        if (command === 'requests-exclude' || command === 'requests-include') {
            const userId = parseUserId(argument);
            if (userId == null) throw new Error('ユーザーIDは #3480 または 3480 形式の非負整数で指定してください');
            const response = await requestOperatorCommand({ action: 'set-admin-request-exclusion', userId, excluded: command === 'requests-exclude' });
            if (!response?.ok) throw new Error(response?.error || '設定に失敗しました');
            console.log(`#${response.user.id} をリクエスト${response.user.excluded ? '対象外' : '対象'}に設定しました。`);
            return;
        }
        if (command === 'list') {
            await listOperatorUsers('admin');
            return;
        }
        if (command === 'grant' || command === 'add') {
            await setAdministrator(argument, true);
            return;
        }
        if (command === 'revoke' || command === 'remove') {
            await setAdministrator(argument, false);
            return;
        }
    }

    if (group === 'verify') {
        if (command === 'list') {
            await listOperatorUsers('verify');
            return;
        }
        if (command === 'grant' || command === 'revoke') {
            await setVerification(argument, command === 'grant');
            return;
        }
    }

    if (group === 'maintenance') {
        if (command === 'enable' || command === 'on') {
            await enableMaintenanceMode();
            return;
        }
        if (command === 'disable' || command === 'off') {
            writeMaintenanceMode(false);
            console.log('メンテナンスモードを解除しました。');
            return;
        }
        if (command === 'status') {
            console.log(`メンテナンスモード: ${readMaintenanceMode() ? '有効' : '無効'}`);
            return;
        }
    }

    if (group === 'server') {
        if (command === 'start') {
            await startServer();
            return;
        }
        if (command === 'stop') {
            await stopServer();
            return;
        }
        if (command === 'restart') {
            await restartServer();
            return;
        }
        if (command === 'status') {
            const status = await getRunningStatus();
            if (!status) {
                console.log(
                    `停止中`,
                );
                process.exitCode = 1;
                return;
            }
            console.log(formatStatus(status));
            return;
        }
    }

    printUsage();
    process.exitCode = 1;
}

main(process.argv.slice(2)).catch((error) => {
    console.error(`エラー: ${error.message}`);
    process.exitCode = 1;
});
