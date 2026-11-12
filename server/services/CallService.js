'use strict';

const crypto = require('crypto');
const { attachDisplayRanks, publicDisplayRanks } = require('../utils/rankDisplay');
const { hasBlockedDmMember } = require('./DmVisibilityService');
const { hasBlockRelationship } = require('../utils/blockRelationship');
const { normalizeSpaceId, isActiveGroupMember } = require('./SpaceService');
const { createNotificationIfAllowed } = require('./NotificationDeliveryService');

function fail(statusCode, message) {
    throw Object.assign(new Error(message), { statusCode });
}

function stageSettings(space) {
    if (!space?.stage_settings) return null;
    let value;
    try { value = typeof space.stage_settings === 'string' ? JSON.parse(space.stage_settings) : space.stage_settings; }
    catch { return null; }
    return value?.version === 1 ? value : null;
}

function stagePayload(space) {
    const settings = stageSettings(space);
    if (!settings) return null;
    return {
        id: String(space.id), name: space.name, description: space.description,
        owner_id: Number(space.ownerId ?? space.owner_id), visibility: space.visibility,
        group_id: space.groupId ?? space.group_id ?? null,
        ...settings,
    };
}

async function authorizeRoom(db, kind, id, userId, { joining = false, guestStageId = null } = {}) {
    if (!id || String(id).length > 128) fail(400, '通話IDが正しくありません。');
    if (kind === 'stage') {
        if (!normalizeSpaceId(id)) fail(404, 'ステージが見つかりません。');
        const space = await db.getSpaceById(id);
        const stage = stagePayload(space);
        if (!stage) fail(404, 'ステージが見つかりません。');
        const isGuest = typeof userId === 'string' && userId.startsWith('guest:');
        const numericUserId = isGuest ? null : Number(userId);
        if (isGuest) {
            if (!stage.allow_guest_join || guestStageId !== String(id)) fail(403, 'ゲスト参加は許可されていません。');
        } else {
            const member = await db.getSpaceMember(id, numericUserId);
            if (stage.owner_id !== numericUserId && stage.visibility !== 'public') {
                const allowed = stage.visibility === 'group'
                    ? await isActiveGroupMember(db, stage.group_id, numericUserId)
                    : Boolean(member);
                if (!allowed) fail(403, '参加権限がありません。');
            }
            if (stage.owner_id !== numericUserId && await hasBlockRelationship(db, numericUserId, stage.owner_id)) fail(403, '参加できません。');
        }
        if (joining && stage.status === 'ended') fail(409, 'このステージは終了しました。');
        return { kind, id, title: stage.name, owner_id: stage.owner_id,
            role: isGuest ? 'audience' : stage.owner_id === numericUserId ? 'host' : (stage.speaker_ids || []).map(Number).includes(numericUserId) ? 'speaker' : 'audience', guest: isGuest, stage };
    }
    if (kind === 'dm') {
        const dm = await db.getGroupDm(id);
        if (!dm || !dm.member?.map(Number).includes(userId)) fail(403, 'このメッセージの通話には参加できません。');
        const accepted = dm.accepted ?? dm.unread?._accepted ?? dm.member;
        if (!accepted.map(Number).includes(userId)) fail(403, 'メッセージへの招待を承諾してから通話してください。');
        if (await hasBlockedDmMember(db, userId, dm.member)) fail(403, 'ブロック関係のあるメッセージでは通話できません。');
        return { kind, id, title: dm.title || 'メッセージの通話', role: 'member', dm };
    }
    fail(400, '通話の種類が正しくありません。');
}

class CallService {
    constructor(realtime, getDb, { now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, recover = true } = {}) {
        this.realtime = realtime;
        this.getDb = getDb;
        this.rooms = new Map();
        this.rateWindows = new WeakMap();
        this.rosterPublications = new WeakMap();
        this.queues = new WeakMap();
        this.joinQueues = new Map();
        this.stageBans = new Map();
        this.stageQueues = new Map();
        this.stageAbsenceTimers = new Map();
        this.stageHostAbsentSince = new Map();
        this.now = now;
        this.setTimer = setTimer;
        this.clearTimer = clearTimer;
        this.disposed = false;
        if (recover) this.scheduleStageRecovery(0);
        // 直近のチャットメッセージID -> 送信者。削除権限の検証にだけ使う。
        this.chatMessages = new Map();
    }

    withStageLock(id, action) {
        id = String(id);
        const previous = this.stageQueues.get(id) || Promise.resolve();
        const next = previous.catch(() => {}).then(action);
        this.stageQueues.set(id, next);
        void next.finally(() => {
            if (this.stageQueues.get(id) === next) this.stageQueues.delete(id);
        }).catch(() => {});
        return next;
    }

    clearStageAbsence(id) {
        const timer = this.stageAbsenceTimers.get(String(id));
        if (timer) this.clearTimer(timer.handle);
        this.stageAbsenceTimers.delete(String(id));
    }

    hasStageHost(id, ownerId) {
        return [...(this.rooms.get(`stage:${id}`)?.values() || [])].some(entry =>
            (ownerId === undefined || String(entry.user_id) === String(ownerId)) && entry.role === 'host'
            && !entry.watching && entry.socket.readyState === 1);
    }

    scheduleStageAbsence(id, deadline, delay = deadline - this.now()) {
        id = String(id);
        if (this.disposed || this.stageAbsenceTimers.get(id)?.deadline === deadline) return;
        this.clearStageAbsence(id);
        const timer = { deadline, handle: null };
        this.stageAbsenceTimers.set(id, timer);
        const run = async () => {
            try {
                await this.withStageLock(id, async () => {
                    if (this.disposed || this.stageAbsenceTimers.get(id) !== timer) return;
                    const space = await this.getDb().getSpaceById(id);
                    const settings = stageSettings(space);
                    if (!settings || settings.status === 'ended') {
                        await this.refreshStageUnlocked(id, space);
                        return;
                    }
                    if (settings.status !== 'live' || !settings.host_joined_at) {
                        this.clearStageAbsence(id);
                        return;
                    }
                    if (this.hasStageHost(id, space.ownerId ?? space.owner_id)) {
                        await this.syncStagePresence(id, space);
                        return;
                    }
                    const persistedDeadline = Date.parse(settings.host_absence_deadline);
                    if (persistedDeadline !== deadline) {
                        this.clearStageAbsence(id);
                        await this.syncStagePresence(id, space);
                        return;
                    }
                    if (this.now() < deadline) {
                        timer.handle = this.setTimer(run, deadline - this.now());
                        timer.handle?.unref?.();
                        return;
                    }
                    const updated = await this.getDb().updateSpace(id, { stage_settings: JSON.stringify({
                        ...settings, status: 'ended', ended_at: new Date(this.now()).toISOString(),
                        end_reason: 'host_absent', host_absent_since: null, host_absence_deadline: null,
                    }) });
                    await this.refreshStageUnlocked(id, updated);
                });
            } catch (error) {
                console.error('[calls] stage absence check failed:', error);
                if (!this.disposed && this.stageAbsenceTimers.get(id) === timer) {
                    timer.handle = this.setTimer(run, 30000);
                    timer.handle?.unref?.();
                }
            }
        };
        timer.handle = this.setTimer(run, Math.max(0, delay));
        timer.handle?.unref?.();
    }

    async syncStagePresence(id, space, absentAt = this.now()) {
        const settings = stageSettings(space);
        if (!settings || settings.status !== 'live') {
            this.clearStageAbsence(id);
            this.stageHostAbsentSince.delete(String(id));
            return;
        }
        const next = { ...settings };
        if (this.hasStageHost(id, space.ownerId ?? space.owner_id)) {
            this.stageHostAbsentSince.delete(String(id));
            next.host_joined_at ||= new Date(this.now()).toISOString();
            next.host_absent_since = null;
            next.host_absence_deadline = null;
        } else if (settings.host_joined_at) {
            const since = this.stageHostAbsentSince.get(String(id)) ?? absentAt;
            if (!Number.isFinite(Date.parse(settings.host_absence_deadline)) || since < Date.parse(settings.host_absent_since)) {
                next.host_absent_since = new Date(since).toISOString();
                next.host_absence_deadline = new Date(since + 10 * 60 * 1000).toISOString();
            }
        } else {
            this.stageHostAbsentSince.delete(String(id));
        }
        if (JSON.stringify(next) !== JSON.stringify(settings)) {
            await this.getDb().updateSpace(id, { stage_settings: JSON.stringify(next) });
        }
        const deadline = Date.parse(next.host_absence_deadline);
        if (next.host_joined_at && Number.isFinite(deadline)) this.scheduleStageAbsence(id, deadline);
        else this.clearStageAbsence(id);
    }

    stageConnectionRemoved(key) {
        if (!key.startsWith('stage:') || this.disposed) return;
        const id = key.slice(6);
        if (this.hasStageHost(id)) return;
        const absentAt = this.now();
        if (!this.stageHostAbsentSince.has(id)) this.stageHostAbsentSince.set(id, absentAt);
        const reconcile = () => this.withStageLock(id, async () => {
            await this.syncStagePresence(id, await this.getDb().getSpaceById(id), absentAt);
        }).catch(error => {
            console.error('[calls] stage presence update failed:', error);
            if (!this.disposed) {
                this.clearStageAbsence(id);
                const timer = { handle: null };
                timer.handle = this.setTimer(() => {
                    if (this.stageAbsenceTimers.get(id) === timer) return reconcile();
                }, 30000);
                timer.handle?.unref?.();
                this.stageAbsenceTimers.set(id, timer);
            }
        });
        void reconcile();
    }

    scheduleStageRecovery(delay) {
        this.stageRecoveryTimer = this.setTimer(async () => {
            if (this.disposed) return;
            const db = this.getDb();
            if (!db) { this.scheduleStageRecovery(1000); return; }
            try {
                for (let offset = 0; !this.disposed; offset += 100) {
                    const spaces = await db.listSpaces({ includePrivate: true, limit: 100, offset });
                    for (const space of spaces) {
                        if (!stageSettings(space)?.host_joined_at) continue;
                        await this.withStageLock(space.id, async () => {
                            await this.syncStagePresence(space.id, await db.getSpaceById(space.id));
                        });
                    }
                    if (spaces.length < 100) break;
                }
            } catch (error) {
                console.error('[calls] stage presence recovery failed:', error);
                if (!this.disposed) this.scheduleStageRecovery(30000);
            }
        }, delay);
        this.stageRecoveryTimer?.unref?.();
    }

    dispose() {
        this.disposed = true;
        this.clearTimer(this.stageRecoveryTimer);
        for (const id of this.stageAbsenceTimers.keys()) this.clearStageAbsence(id);
        this.stageHostAbsentSince.clear();
    }

    async updateStage(id, update) {
        return this.withStageLock(id, async () => {
            const space = await this.getDb().getSpaceById(id);
            const settings = stageSettings(space);
            if (!settings) fail(404, 'ステージが見つかりません。');
            const next = await update(space, { ...settings });
            const updated = JSON.stringify(next) === JSON.stringify(settings) ? space
                : await this.getDb().updateSpace(id, { stage_settings: JSON.stringify(next) });
            await this.refreshStageUnlocked(id, updated);
            return updated;
        });
    }

    rememberChatMessage(key, id, userId) {
        this.chatMessages.set(id, { key, userId, at: Date.now() });
        if (this.chatMessages.size <= 2000) return;
        const cutoff = Date.now() - 30 * 60 * 1000;
        for (const [messageId, info] of this.chatMessages) {
            if (info.at < cutoff) this.chatMessages.delete(messageId);
        }
        while (this.chatMessages.size > 2000) {
            const oldest = this.chatMessages.keys().next().value;
            if (oldest === undefined) break;
            this.chatMessages.delete(oldest);
        }
    }

    send(socket, event) {
        if (socket.readyState === 1 && socket.bufferedAmount < 1024 * 1024) socket.send(JSON.stringify(event));
    }

    async roster(room = new Map(), users = []) {
        const records = [...room.values()].map(entry => ({ id: entry.guest ? null : entry.user_id, entry }));
        await attachDisplayRanks(this.getDb(), [...records, ...users]);
        return records.filter(record => room.get(record.entry.user_id) === record.entry).map(record => {
            const { user_id, name, handle, nyaitterId, guest, role, muted, camera, screenStreamId, screenTrackId, screenLabel, chatDisabled, forceMuted, forceCameraOff, forcePinned } = record.entry;
            return {
                user_id, name, handle, nyaitter_id: nyaitterId || null, guest: Boolean(guest), role,
                display_ranks: publicDisplayRanks(record),
                muted: Boolean(muted || forceMuted), camera: Boolean(camera && !forceCameraOff),
                chat_disabled: Boolean(chatDisabled), force_muted: Boolean(forceMuted),
                force_camera_off: Boolean(forceCameraOff), force_pinned: Boolean(forcePinned),
                screen_stream_id: screenStreamId || null, screen_track_id: screenTrackId || null, screen_label: screenLabel || null,
            };
        });
    }

    publish(key, event) {
        for (const entry of this.rooms.get(key)?.values() || []) this.send(entry.socket, { ...event, room: key });
    }

    async publishRoster(key) {
        const room = this.rooms.get(key);
        if (!room) return;
        const publication = {};
        this.rosterPublications.set(room, publication);
        const roster = await this.roster(room);
        if (this.rooms.get(key) === room && this.rosterPublications.get(room) === publication) {
            this.publish(key, { type: 'call:roster', roster });
        }
    }

    disconnect(socket) {
        for (const [key, room] of this.rooms) {
            let removed = false;
            let hostRemoved = false;
            for (const [id, entry] of room) if (entry.socket === socket) {
                room.delete(id); removed = true; hostRemoved ||= entry.role === 'host';
            }
            if (!room.size) this.rooms.delete(key);
            else if (removed) void this.publishRoster(key).catch(error => console.error('[calls] roster update failed:', error));
            if (hostRemoved) this.stageConnectionRemoved(key);
        }
    }

    disconnectRoom(key, socket) {
        const room = this.rooms.get(key);
        if (!room) return false;
        let removed = false;
        let hostRemoved = false;
        for (const [id, entry] of room) {
            if (entry.socket === socket) {
                room.delete(id);
                removed = true;
                hostRemoved ||= entry.role === 'host';
            }
        }
        if (!room.size) this.rooms.delete(key);
        else if (removed) void this.publishRoster(key).catch(error => console.error('[calls] roster update failed:', error));
        if (hostRemoved) this.stageConnectionRemoved(key);
        return removed;
    }

    resolveRoomKey(message) {
        if (typeof message?.room === 'string' && message.room) return message.room;
        if (typeof message?.kind !== 'string' || !message.kind) return null;
        if (message.id === undefined || message.id === null || message.id === '') return null;
        return `${message.kind}:${String(message.id)}`;
    }

    refreshStage(id) {
        return this.withStageLock(id, () => this.refreshStageUnlocked(id));
    }

    async refreshStageUnlocked(id, space = undefined) {
        const key = `stage:${id}`;
        if (space === undefined) space = await this.getDb().getSpaceById(id);
        const stage = stagePayload(space);
        if (!stage || stage.status === 'ended') {
            this.clearStageAbsence(id);
            this.stageHostAbsentSince.delete(String(id));
            this.stageBans.delete(String(id));
            this.publish(key, { type: 'call:ended', message: stage ? 'このステージは終了しました。' : 'ステージが削除されました。' });
            this.rooms.delete(key);
            for (const [messageId, info] of this.chatMessages) if (info.key === key) this.chatMessages.delete(messageId);
            return;
        }
        await this.syncStagePresence(id, space);
        const room = this.rooms.get(key);
        if (!room) return;
        let stageStatus = null;
        for (const [uid, entry] of room) {
            try {
                const info = await authorizeRoom(this.getDb(), 'stage', id, uid, { joining: true, guestStageId: entry.guestStageId });
                stageStatus = info.stage.status;
                if (info.role === 'audience' && entry.screenStreamId) {
                    entry.screenStreamId = null;
                    entry.screenTrackId = null;
                    entry.screenLabel = null;
                    this.publish(key, { type: 'call:screen', user_id: uid, active: false });
                }
                if (entry.role !== info.role) {
                    entry.role = info.role;
                    entry.muted = true;
                    entry.camera = false;
                }
            } catch (error) {
                if (!error.statusCode) throw error;
                this.send(entry.socket, { type: 'call:ended', room: key, message: error.message });
                room.delete(uid);
            }
        }
        if (!room.size) this.rooms.delete(key);
        else {
            await this.publishRoster(key);
            if (stageStatus) this.publish(key, { type: 'call:stage', status: stageStatus });
        }
    }

    async refreshDm(id) {
        const key = `dm:${id}`;
        const room = this.rooms.get(key);
        if (!room) return;
        for (const [uid, entry] of room) {
            try { await authorizeRoom(this.getDb(), 'dm', String(id), uid); }
            catch (error) {
                if (!error.statusCode) throw error;
                this.send(entry.socket, { type: 'call:ended', room: key, message: 'メッセージの参加権限が変更されたため通話から退出しました。' });
                room.delete(uid);
            }
        }
        if (!room.size) this.rooms.delete(key);
        else await this.publishRoster(key);
    }

    handle(socket, userId, message, guestStageId = null) {
        if (!message?.type?.startsWith('call:')) return Promise.resolve();
        let rate = this.rateWindows.get(socket);
        if (!rate || Date.now() - rate.at > 10000) this.rateWindows.set(socket, rate = { at: Date.now(), count: 0 });
        if (++rate.count > 1000) { socket.close(1008, 'Too many call messages'); return Promise.resolve(); }
        const previous = this.queues.get(socket) || Promise.resolve();
        const next = previous.then(async () => {
            if (socket.readyState !== 1) return;
            const stageKey = message.type === 'call:leave' ? this.resolveRoomKey(message)
                : message.kind === 'stage' ? `stage:${message.id}` : null;
            if (stageKey?.startsWith('stage:')) {
                if (message.type === 'call:signal') return this.process(socket, userId, message, guestStageId);
                return this.withStageLock(stageKey.slice(6), () => this.process(socket, userId, message, guestStageId));
            }
            if (!['call:join', 'call:watch'].includes(message.type)) return this.process(socket, userId, message, guestStageId);
            const key = `${message.kind}:${message.id}`;
            const earlier = this.joinQueues.get(key) || Promise.resolve();
            const join = earlier.catch(() => {}).then(() => this.process(socket, userId, message, guestStageId));
            this.joinQueues.set(key, join);
            try { await join; }
            finally { if (this.joinQueues.get(key) === join) this.joinQueues.delete(key); }
        }).catch(error => {
            this.send(socket, { type: 'call:error', request_id: message.request_id, message: error.statusCode ? error.message : '通話の処理に失敗しました。' });
            if (!error.statusCode) console.error('[calls]', error);
        });
        this.queues.set(socket, next);
        void next.finally(() => { if (this.queues.get(socket) === next) this.queues.delete(socket); });
        return next;
    }

    async process(socket, userId, message, guestStageId = null) {
        if (message.type === 'call:leave') {
            const leaveKey = this.resolveRoomKey(message);
            if (!leaveKey) this.disconnect(socket);
            else this.disconnectRoom(leaveKey, socket);
            return;
        }
        const kind = message.kind;
        const id = String(message.id || '');
        if (id.length > 100) fail(400, '通話IDが正しくありません。');
        const key = `${kind}:${id}`;
        const db = this.getDb();
        const info = await authorizeRoom(db, kind, id, userId, { joining: true, guestStageId });
        if (kind === 'stage' && this.stageBans.get(String(id))?.has(String(userId))) fail(403, 'このステージのセッションから追放されています。');
        if (socket.readyState !== 1) return;
        if (message.type === 'call:watch' && info.stage?.status === 'live') message.type = 'call:join';
        if (message.type === 'call:watch') {
            if (kind !== 'stage' || info.role !== 'audience' || info.stage.status !== 'scheduled') fail(409, 'このステージは待機できません。');
            const room = this.rooms.get(key) || new Map();
            const existing = room.get(userId);
            if (existing && existing.socket !== socket) fail(409, '別のタブでこのステージを開いています。');
            if (!existing) {
                const user = info.guest ? null : await db.getUserById(userId);
                if (socket.readyState !== 1) return;
                room.set(userId, { socket, user_id: userId, name: info.guest ? 'ゲスト' : user?.name || `ユーザー ${userId}`, guest: info.guest, guestStageId, role: 'audience', muted: true, camera: false, watching: true });
            }
            this.rooms.set(key, room);
            this.send(socket, { type: 'call:watching', room: key });
            await this.publishRoster(key);
            return;
        }
        if (message.type === 'call:join') {
            const currentRoom = this.rooms.get(key);
            const existing = currentRoom?.get(userId);
            if (existing?.socket === socket) {
                const user = info.guest ? null : await db.getUserById(userId);
                existing.role = info.role;
                existing.muted = info.role === 'audience' || existing.forceMuted || message.muted !== false;
                existing.camera = info.role !== 'audience' && !existing.forceCameraOff && Boolean(message.camera);
                existing.watching = false;
                existing.name = user?.name || existing.name || (info.guest ? 'ゲスト' : `ユーザー ${userId}`);
                existing.handle = user?.scid || user?.username || existing.handle || (info.guest ? 'ゲスト' : `ユーザー ${userId}`);
                existing.nyaitterId = user?.nyaitter_id || user?.nyaitterId || existing.nyaitterId || user?.id || null;
                if (kind === 'stage') await this.syncStagePresence(id, await db.getSpaceById(id));
                if (socket.readyState !== 1) return;
                const roster = await this.roster(currentRoom);
                if (this.rooms.get(key) !== currentRoom || currentRoom.get(userId) !== existing) return;
                this.send(socket, { type: 'call:joined', room: key, role: existing.role, owner_id: info.owner_id, roster, request_id: message.request_id });
                await this.publishRoster(key);
                return;
            }
            if (existing) fail(409, '別のタブでこの通話に参加しています。');
            this.disconnectRoom(key, socket);
            const user = info.guest ? null : await db.getUserById(userId);
            if (socket.readyState !== 1) return;
            const first = !this.rooms.get(key)?.size;
            if (first && kind === 'dm') {
                const msg = { id: crypto.randomUUID(), type: 'system', userid: userId,
                    content: '通話を開始しました。メッセージ右上の通話ボタンから参加できます。', created_at: new Date().toISOString() };
                await db.appendToGroupDm(id, msg, userId);
                const accepted = info.dm.accepted ?? info.dm.unread?._accepted ?? info.dm.member;
                const callType = info.dm.member.length > 2 ? 'group_call' : 'dm_call';
                await attachDisplayRanks(db, [user]);
                const sender = { id: userId, name: user?.name || '', display_ranks: publicDisplayRanks(user) };
                for (const uid of accepted.map(Number)) {
                    this.realtime.publishDmMessage(uid, id, msg, sender);
                    await this.realtime.publishDmUnreadCount(uid, db);
                    if (uid === userId) continue;
                    try {
                        await createNotificationIfAllowed(db, { userId: uid, type: callType, fromUserId: userId, target: { kind: 'dm', id } });
                    } catch (error) {
                        console.warn('[calls] call notification delivery failed:', error.message);
                    }
                }
            }
            const confirmed = await authorizeRoom(db, kind, id, userId, { joining: true, guestStageId });
            info.role = confirmed.role;
            if (socket.readyState !== 1) return;
            if (!this.rooms.has(key)) this.rooms.set(key, new Map());
            const room = this.rooms.get(key);
            room.set(userId, { socket, user_id: userId, name: user?.name || (info.guest ? 'ゲスト' : `ユーザー ${userId}`), guest: info.guest, guestStageId,
                handle: user?.scid || user?.username || user?.name || (info.guest ? 'ゲスト' : `ユーザー ${userId}`), nyaitterId: user?.nyaitter_id || user?.nyaitterId || user?.id || null, role: info.role,
                muted: info.role === 'audience' || message.muted !== false,
                camera: info.role !== 'audience' && Boolean(message.camera), transcriptionEnabled: false, chatDisabled: false, forceMuted: false, forceCameraOff: false });
            if (kind === 'stage') {
                try { await this.syncStagePresence(id, await db.getSpaceById(id)); }
                catch (error) { this.disconnectRoom(key, socket); throw error; }
            }
            if (socket.readyState !== 1) return;
            const roster = await this.roster(room);
            if (this.rooms.get(key) !== room || room.get(userId)?.socket !== socket) return;
            this.send(socket, { type: 'call:joined', room: key, role: info.role, owner_id: info.owner_id, roster, request_id: message.request_id });
            await this.publishRoster(key);
            return;
        }
        const room = this.rooms.get(key);
        const entry = room?.get(userId);
        if (!entry || entry.socket !== socket) fail(403, '通話に参加してください。');
        if (entry.role !== info.role) { await this.refreshStageUnlocked(id); fail(409, '発言権が変更されました。'); }
        if (message.type === 'call:signal') {
            const target = room.get(message.to) || room.get(Number(message.to));
            if (!target || target.user_id === userId) return;
            if (kind === 'stage' && userId !== info.owner_id && target.user_id !== info.owner_id) fail(403, 'ステージの接続先が正しくありません。');
            const data = message.data;
            if (!data || typeof data !== 'object') fail(400, 'シグナルが正しくありません。');
            if (data.description) {
                const { type, sdp } = data.description;
                if (!['offer', 'answer'].includes(type) || typeof sdp !== 'string' || sdp.length > 50000) fail(400, 'SDPが正しくありません。');
                if (info.role === 'audience') {
                    const sections = sdp.split(/\r?\nm=/).slice(1);
                    if (sections.some(section => /^(audio|video) /.test(section) && !/\r?\na=(recvonly|inactive)(?:\r?\n|$)/.test(section))) fail(403, '視聴者は音声・映像を送信できません。');
                }
            } else if (!data.candidate || typeof data.candidate.candidate !== 'string' || data.candidate.candidate.length > 4000) fail(400, 'ICEが正しくありません。');
            this.send(target.socket, { type: 'call:signal', room: key, from: userId, data });
        } else if (message.type === 'call:state') {
            entry.muted = info.role === 'audience' || entry.forceMuted || Boolean(message.muted);
            entry.camera = info.role !== 'audience' && !entry.forceCameraOff && Boolean(message.camera);
            if (message.transcription_enabled !== undefined) entry.transcriptionEnabled = Boolean(message.transcription_enabled);
            await this.publishRoster(key);
        } else if (message.type === 'call:moderate') {
            if (kind !== 'stage' || info.role !== 'host') fail(403, 'ホストのみ操作できます。');
            const targetId = String(message.target || '');
            const action = String(message.action || '');
            if (!['mute', 'camera', 'chat', 'kick', 'pin', 'promote', 'demote'].includes(action)) fail(400, '操作が正しくありません。');
            const target = [...room.values()].find(candidate => String(candidate.user_id) === targetId);
            if (!target) fail(404, '対象ユーザーが見つかりません。');
            if (target === entry && action !== 'pin') fail(404, '対象ユーザーが見つかりません。');
            if (target.role === 'host' && action !== 'pin') fail(404, '対象ユーザーが見つかりません。');
            if (action === 'kick') {
                let banned = this.stageBans.get(id);
                if (!banned) this.stageBans.set(id, banned = new Set());
                banned.add(targetId);
                this.send(target.socket, { type: 'call:kicked', room: key, message: 'ホストによりこのステージのセッションから退出させられました。ステージ終了まで再参加できません。' });
                room.delete(target.user_id);
                if (room.size) await this.publishRoster(key);
                else this.rooms.delete(key);
                return;
            }
            if (action === 'mute') {
                target.forceMuted = !target.forceMuted;
                if (target.forceMuted) target.muted = true;
            }
            if (action === 'camera') {
                target.forceCameraOff = !target.forceCameraOff;
                if (target.forceCameraOff) target.camera = false;
            }
            if (action === 'chat') target.chatDisabled = !target.chatDisabled;
            if (action === 'pin') { target.forcePinned = !target.forcePinned; }
            if (action === 'promote') {
                if (target.role !== 'audience') fail(400, 'リスナーのみ昇格できます。');
                const speakerIds = await stageSpeakerIds(this.getDb(), id);
                await updateStageSpeakers(this.getDb(), id, [...new Set([...speakerIds, target.user_id])]);
                target.role = 'speaker'; target.muted = true; target.camera = false;
                target.forceMuted = false; target.forceCameraOff = false;
            }
            if (action === 'demote') {
                if (target.role !== 'speaker') fail(400, 'スピーカーのみ降格できます。');
                const speakerIds = await stageSpeakerIds(this.getDb(), id);
                await updateStageSpeakers(this.getDb(), id, speakerIds.filter(uid => String(uid) !== String(target.user_id)));
                target.role = 'audience'; target.muted = true; target.camera = false;
                target.screenStreamId = null; target.screenTrackId = null; target.screenLabel = null;
                this.publish(key, { type: 'call:screen', user_id: target.user_id, active: false });
            }
            this.send(target.socket, {
                type: 'call:moderated',
                room: key,
                action,
                value: action === 'mute' ? target.forceMuted
                    : action === 'camera' ? target.forceCameraOff
                        : action === 'chat' ? target.chatDisabled
                            : action === 'pin' ? target.forcePinned : undefined,
            });
            await this.publishRoster(key);
        } else if (message.type === 'call:screen') {
            if (info.role === 'audience') fail(403, '画面共有には発言権が必要です。');
            if (message.active) {
                const streamId = String(message.stream_id || '');
                const trackId = String(message.track_id || '');
                if (!streamId || streamId.length > 200 || !trackId || trackId.length > 200) fail(400, '画面共有を確認できません。');
                entry.screenStreamId = streamId;
                entry.screenTrackId = trackId;
                entry.screenLabel = `@${String(entry.handle).replace(/^@/, '')}のスクリーン`;
            } else {
                entry.screenStreamId = null;
                entry.screenTrackId = null;
                entry.screenLabel = null;
            }
            this.publish(key, { type: 'call:screen', user_id: userId, active: Boolean(message.active), stream_id: entry.screenStreamId, track_id: entry.screenTrackId, label: entry.screenLabel });
        } else if (message.type === 'call:chat' || message.type === 'call:transcript') {
            if (entry.guest) fail(403, 'ゲストはコメントできません。');
            if (message.type === 'call:chat' && entry.chatDisabled) fail(403, 'ホストによりチャットが無効になっています。');
            if (message.type === 'call:transcript' && info.role === 'audience') fail(403, '発言権がありません。');
            if (message.type === 'call:transcript' && entry.muted) fail(403, 'マイクが無効なため文字起こしを受け付けません。');
            const text = String(message.text || '').trim();
            if (!text || text.length > 2000) fail(400, '2000文字以内で入力してください。');
            const messageId = crypto.randomUUID();
            const sender = { id: entry.guest ? null : userId };
            await attachDisplayRanks(db, [sender]);
            if (room.get(userId) !== entry || socket.readyState !== 1) return;
            const event = { type: message.type, id: messageId, user_id: userId, name: entry.name, handle: entry.handle, nyaitter_id: entry.nyaitterId, guest: Boolean(entry.guest), display_ranks: publicDisplayRanks(sender), text, at: new Date().toISOString() };
            if (message.type === 'call:transcript') {
                for (const recipient of room.values()) if (recipient.transcriptionEnabled) this.send(recipient.socket, { ...event, room: key });
            } else {
                this.rememberChatMessage(key, messageId, userId);
                this.publish(key, event);
            }
        } else if (message.type === 'call:chat-delete') {
            const messageId = String(message.message_id || '');
            if (!messageId || messageId.length > 128) fail(400, 'メッセージIDが正しくありません。');
            const stored = this.chatMessages.get(messageId);
            if (!stored || stored.key !== key) fail(404, 'メッセージが見つかりません。');
            if (entry.role !== 'host' && String(stored.userId) !== String(userId)) fail(403, 'このメッセージは削除できません。');
            this.chatMessages.delete(messageId);
            this.publish(key, { type: 'call:chat-delete', id: messageId });
        } else if (message.type === 'call:chat-clear') {
            if (entry.role !== 'host') fail(403, 'チャットを消去できるのはホストだけです。');
            for (const [messageId, info] of this.chatMessages) {
                if (info.key === key) this.chatMessages.delete(messageId);
            }
            this.publish(key, { type: 'call:chat-clear' });
        }
    }
}


async function stageSpeakerIds(db, id) {
    const space = await db.getSpaceById(id);
    const settings = stageSettings(space);
    return Array.isArray(settings?.speaker_ids) ? settings.speaker_ids.map(Number) : [];
}
async function updateStageSpeakers(db, id, speakerIds) {
    const space = await db.getSpaceById(id);
    const settings = stageSettings(space);
    if (!settings) return;
    settings.speaker_ids = [...new Set(speakerIds.map(Number))];
    await db.updateSpace(id, { stage_settings: JSON.stringify(settings) });
}

module.exports = { CallService, authorizeRoom, stagePayload, stageSettings, fail };
