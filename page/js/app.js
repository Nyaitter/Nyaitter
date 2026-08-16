import * as state from './state.js';
import { api, apiRequest } from './api.js';
import { renderLimitedMarkdown } from './safeMarkdown.js';
import { ICONS } from './icons.js';
import { DOM, showMainJsError } from './dom.js';
import { RESOURCE_LINKS, WIDGET_LINKS } from './linkSettings.js';

const {
    getSelectedFiles,
    setSelectedFiles,
    getCurrentUser,
    setCurrentUser,
    getRealtimeChannel,
    setRealtimeChannel,
    getRealtimeReconnectTimer,
    setRealtimeReconnectTimer,
    getRealtimePingTimer,
    setRealtimePingTimer,
    getRealtimeReconnectAttempts,
    setRealtimeReconnectAttempts,
    getRealtimeShouldReconnect,
    setRealtimeShouldReconnect,
    getRealtimeAuthKey,
    setRealtimeAuthKey,
    getRealtimeSummaryFreshTimer,
    setRealtimeSummaryFreshTimer,
    getCurrentTimelineTab,
    setCurrentTimelineTab,
    getReplyingTo,
    setReplyingTo,
    getQuotingPost,
    setQuotingPost,
    getNewIconDataUrl,
    setNewIconDataUrl,
    getResetIconToDefault,
    setResetIconToDefault,
    getNewHeaderDataUrl,
    setNewHeaderDataUrl,
    getResetHeaderToDefault,
    setResetHeaderToDefault,
    getSettingsSaveInFlight,
    setSettingsSaveInFlight,
    getSettingsSaveQueued,
    setSettingsSaveQueued,
    getActiveDmId,
    setActiveDmId,
    getLastRenderedMessageId,
    setLastRenderedMessageId,
    getPendingRealtimeDmMessages,
    setPendingRealtimeDmMessages,
    getActiveDmMemberIds,
    setActiveDmMemberIds,
    getRecommendedUsersCache,
    setRecommendedUsersCache,
    getPublicProfileCache,
    setPublicProfileCache,
    getAllUsersCache,
    setAllUsersCache,
    getPwaRegistrationPromise,
    setPwaRegistrationPromise,
    getIsLoadingMore,
    setIsLoadingMore,
    getPostLoadObserver,
    setPostLoadObserver,
    getCurrentSearchTab,
    setCurrentSearchTab,
    getCurrentPagination,
    setCurrentPagination,
    getIsDarkmode,
    setIsDarkmode,
    getEmoji_picker_theme,
    setEmoji_picker_theme,
    getDmE2EPublicKeyCache,
    setDmE2EPublicKeyCache,
    getDmE2ERegisteredUsers,
    setDmE2ERegisteredUsers,
    getDmUnreadCounts,
    setDmUnreadCounts,
} = state;

export function initApp() {
    const METRICS_FALLBACK = '?';
    let recommendedUsersRequest = null;
    let sidebarOverflowAbortController = null;
    let sidebarOverflowResizeTimer = null;
    let activeProfilePullRefreshUser = null;
    let activeSearchRequestVersion = 0;

    const appDialog = {
        modal: document.getElementById('app-dialog-modal'),
        title: document.getElementById('app-dialog-title'),
        message: document.getElementById('app-dialog-message'),
        inputGroup: document.getElementById('app-dialog-input-group'),
        input: document.getElementById('app-dialog-input'),
        closeButton: document.getElementById('app-dialog-close-btn'),
        cancelButton: document.getElementById('app-dialog-cancel-btn'),
        submitButton: document.getElementById('app-dialog-submit-btn'),
    };
    const appDialogQueue = [];
    let isAppDialogActive = false;

    function showNextAppDialog() {
        const current = appDialogQueue.shift();
        if (!current) {
            isAppDialogActive = false;
            return;
        }

        const { type, message, defaultValue = '', resolve } = current;
        const isPrompt = type === 'prompt';
        const isConfirm = type === 'confirm';
        const previousFocus = document.activeElement;
        let settled = false;

        appDialog.title.textContent = isPrompt
            ? '入力'
            : isConfirm
              ? '確認'
              : '通知';
        appDialog.message.textContent = String(message ?? '');
        appDialog.inputGroup.classList.toggle('hidden', !isPrompt);
        appDialog.cancelButton.classList.toggle(
            'hidden',
            !(isPrompt || isConfirm),
        );
        appDialog.submitButton.textContent = isPrompt
            ? '入力を確定'
            : isConfirm
              ? '実行する'
              : '閉じる';
        appDialog.closeButton.setAttribute(
            'aria-label',
            isPrompt || isConfirm ? 'キャンセル' : '閉じる',
        );
        appDialog.input.value = isPrompt ? String(defaultValue ?? '') : '';

        const close = (result) => {
            if (settled) return;
            settled = true;
            appDialog.modal.classList.add('hidden');
            appDialog.closeButton.removeEventListener('click', onCancel);
            appDialog.cancelButton.removeEventListener('click', onCancel);
            appDialog.submitButton.removeEventListener('click', onSubmit);
            appDialog.modal.removeEventListener('click', onBackdropClick);
            appDialog.input.removeEventListener('keydown', onInputKeyDown);
            document.removeEventListener('keydown', onKeyDown);
            if (previousFocus instanceof HTMLElement) previousFocus.focus();
            resolve(result);
            setTimeout(showNextAppDialog, 0);
        };

        const onCancel = () =>
            close(isPrompt ? null : isConfirm ? false : undefined);
        const onSubmit = () =>
            close(
                isPrompt ? appDialog.input.value : isConfirm ? true : undefined,
            );
        const onBackdropClick = (event) => {
            if (event.target === appDialog.modal) onCancel();
        };
        const onInputKeyDown = (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                onSubmit();
            }
        };
        const onKeyDown = (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                onCancel();
            }
        };

        appDialog.closeButton.addEventListener('click', onCancel);
        appDialog.cancelButton.addEventListener('click', onCancel);
        appDialog.submitButton.addEventListener('click', onSubmit);
        appDialog.modal.addEventListener('click', onBackdropClick);
        appDialog.input.addEventListener('keydown', onInputKeyDown);
        document.addEventListener('keydown', onKeyDown);
        appDialog.modal.classList.remove('hidden');
        requestAnimationFrame(() => {
            (isPrompt ? appDialog.input : appDialog.submitButton).focus();
        });
    }

    function openAppDialog(type, message, defaultValue) {
        return new Promise((resolve) => {
            appDialogQueue.push({ type, message, defaultValue, resolve });
            if (!isAppDialogActive) {
                isAppDialogActive = true;
                showNextAppDialog();
            }
        });
    }

    function showAppAlert(message) {
        return openAppDialog('alert', message);
    }

    function showAppPrompt(message, defaultValue = '') {
        return openAppDialog('prompt', message, defaultValue);
    }

    function showAppConfirm(message) {
        return openAppDialog('confirm', message);
    }

    const SETTINGS_GROUPS = new Set([
        'profile',
        'privacy',
        'ui',
        'notifications',
        'storage',
        'api',
        'resources',
    ]);

    function getSettingsGroupFromHash(hash = window.location.hash) {
        const match = /^#settings(?:\/([^/?#]+))?$/.exec(hash);
        const group = match?.[1];
        return group && SETTINGS_GROUPS.has(group) ? group : 'profile';
    }

    const PAGE_CACHE_STORAGE_KEY = 'nyaitter_page_caches';
    const timelinePageCaches = new Map();
    const profilePostPageCaches = new Map();
    const auxiliaryPostPageCaches = new Map();
    const userPageCaches = new Map();
    const screenDataCaches = new Map();
    const MAX_TIMELINE_PAGE_CACHES = 30;
    const MAX_PROFILE_POST_PAGE_CACHES = 30;
    const MAX_AUXILIARY_PAGE_CACHES = 50;
    const MAX_SCREEN_DATA_CACHES = 50;

    function trimPageCacheMap(cacheMap, limit) {
        while (cacheMap.size > limit) {
            const oldestKey = cacheMap.keys().next().value;
            if (oldestKey === undefined) break;
            cacheMap.delete(oldestKey);
        }
    }

    function serializePostPageCache(pageCache) {
        return { pages: Array.from(pageCache?.pages?.entries?.() || []) };
    }

    function restorePostPageCache(serializedCache) {
        const pages = new Map();
        if (Array.isArray(serializedCache?.pages)) {
            serializedCache.pages.forEach(([pageNumber, payload]) => {
                const normalizedPageNumber = Number(pageNumber);
                if (
                    Number.isInteger(normalizedPageNumber) &&
                    normalizedPageNumber >= 0 &&
                    payload &&
                    typeof payload === 'object'
                )
                    pages.set(normalizedPageNumber, payload);
            });
        }
        return { pages };
    }

    function persistPageCaches() {
        try {
            const timelineCaches = Array.from(timelinePageCaches.entries()).map(
                ([pageKey, pageCache]) => [
                    pageKey,
                    {
                        timelines: Array.from(
                            pageCache.timelines.entries(),
                        ).map(([tab, tabCache]) => [
                            tab,
                            serializePostPageCache(tabCache),
                        ]),
                    },
                ],
            );
            const profileCaches = Array.from(
                profilePostPageCaches.entries(),
            ).map(([pageKey, pageCache]) => [
                pageKey,
                serializePostPageCache(pageCache),
            ]);
            const auxiliaryPostCaches = Array.from(
                auxiliaryPostPageCaches.entries(),
            ).map(([pageKey, pageCache]) => [
                pageKey,
                serializePostPageCache(pageCache),
            ]);
            const userCaches = Array.from(userPageCaches.entries()).map(
                ([pageKey, pageCache]) => [
                    pageKey,
                    serializePostPageCache(pageCache),
                ],
            );
            const screenData = Array.from(screenDataCaches.entries());
            sessionStorage.setItem(
                PAGE_CACHE_STORAGE_KEY,
                JSON.stringify({
                    timelineCaches,
                    profileCaches,
                    auxiliaryPostCaches,
                    userCaches,
                    screenData,
                }),
            );
        } catch (_) {
            // sessionStorageが無効・満杯の場合も、メモリ上のキャッシュは継続利用する。
        }
    }

    function restorePageCaches() {
        try {
            const stored = JSON.parse(
                sessionStorage.getItem(PAGE_CACHE_STORAGE_KEY) || '{}',
            );
            const timelineEntries = Array.isArray(stored?.timelineCaches)
                ? stored.timelineCaches.slice(-MAX_TIMELINE_PAGE_CACHES)
                : [];
            timelineEntries.forEach(([pageKey, serializedCache]) => {
                if (typeof pageKey !== 'string' || !serializedCache) return;
                const timelines = new Map();
                if (Array.isArray(serializedCache.timelines)) {
                    serializedCache.timelines.forEach(([tab, tabCache]) => {
                        if (typeof tab === 'string')
                            timelines.set(tab, restorePostPageCache(tabCache));
                    });
                }
                timelinePageCaches.set(pageKey, { timelines });
            });
            const profileEntries = Array.isArray(stored?.profileCaches)
                ? stored.profileCaches.slice(-MAX_PROFILE_POST_PAGE_CACHES)
                : [];
            profileEntries.forEach(([pageKey, serializedCache]) => {
                if (typeof pageKey !== 'string' || !serializedCache) return;
                profilePostPageCaches.set(
                    pageKey,
                    restorePostPageCache(serializedCache),
                );
            });
            const restoreSimplePageCaches = (serializedEntries, targetMap) => {
                if (!Array.isArray(serializedEntries)) return;
                serializedEntries
                    .slice(-MAX_AUXILIARY_PAGE_CACHES)
                    .forEach(([pageKey, serializedCache]) => {
                        if (typeof pageKey !== 'string' || !serializedCache)
                            return;
                        targetMap.set(
                            pageKey,
                            restorePostPageCache(serializedCache),
                        );
                    });
            };
            restoreSimplePageCaches(
                stored?.auxiliaryPostCaches,
                auxiliaryPostPageCaches,
            );
            restoreSimplePageCaches(stored?.userCaches, userPageCaches);
            if (Array.isArray(stored?.screenData)) {
                stored.screenData
                    .slice(-MAX_SCREEN_DATA_CACHES)
                    .forEach(([cacheKey, payload]) => {
                        if (
                            typeof cacheKey === 'string' &&
                            payload !== undefined
                        )
                            screenDataCaches.set(cacheKey, payload);
                    });
            }
            trimPageCacheMap(timelinePageCaches, MAX_TIMELINE_PAGE_CACHES);
            trimPageCacheMap(
                profilePostPageCaches,
                MAX_PROFILE_POST_PAGE_CACHES,
            );
            trimPageCacheMap(
                auxiliaryPostPageCaches,
                MAX_AUXILIARY_PAGE_CACHES,
            );
            trimPageCacheMap(userPageCaches, MAX_AUXILIARY_PAGE_CACHES);
            trimPageCacheMap(screenDataCaches, MAX_SCREEN_DATA_CACHES);
        } catch (_) {
            // 破損した保存値は使わず、空のキャッシュとして続行する。
            timelinePageCaches.clear();
            profilePostPageCaches.clear();
            auxiliaryPostPageCaches.clear();
            userPageCaches.clear();
            screenDataCaches.clear();
        }
    }

    function getTimelinePageCacheKey(hash = window.location.hash) {
        const userScope = getCurrentUser()?.id ?? 'guest';
        return `${userScope}:${hash || '#'}`;
    }

    function getTimelinePageCache(tab, { forceRefresh = false } = {}) {
        const pageKey = getTimelinePageCacheKey();
        if (!timelinePageCaches.has(pageKey)) {
            timelinePageCaches.set(pageKey, { timelines: new Map() });
            trimPageCacheMap(timelinePageCaches, MAX_TIMELINE_PAGE_CACHES);
        }
        const pageCache = timelinePageCaches.get(pageKey);
        if (forceRefresh) {
            pageCache.timelines.delete(tab);
            persistPageCaches();
        }
        if (!pageCache.timelines.has(tab))
            pageCache.timelines.set(tab, { pages: new Map() });
        return pageCache.timelines.get(tab);
    }

    function savePostPageCache(pageCache, pageNumber, payload) {
        pageCache.pages.set(pageNumber, payload);
        persistPageCaches();
    }

    function getProfilePostPageCache(userId, subType, pinId = '') {
        const userScope = getCurrentUser()?.id ?? 'guest';
        const pageKey = `${userScope}:${window.location.hash || '#'}:${userId}:${subType}:${pinId || ''}`;
        if (!profilePostPageCaches.has(pageKey)) {
            profilePostPageCaches.set(pageKey, { pages: new Map() });
            trimPageCacheMap(
                profilePostPageCaches,
                MAX_PROFILE_POST_PAGE_CACHES,
            );
        }
        return profilePostPageCaches.get(pageKey);
    }

    function getAuxiliaryPostPageCache(cacheKey) {
        if (!auxiliaryPostPageCaches.has(cacheKey)) {
            auxiliaryPostPageCaches.set(cacheKey, { pages: new Map() });
            trimPageCacheMap(
                auxiliaryPostPageCaches,
                MAX_AUXILIARY_PAGE_CACHES,
            );
        }
        return auxiliaryPostPageCaches.get(cacheKey);
    }

    function getUserPageCache(cacheKey) {
        if (!userPageCaches.has(cacheKey)) {
            userPageCaches.set(cacheKey, { pages: new Map() });
            trimPageCacheMap(userPageCaches, MAX_AUXILIARY_PAGE_CACHES);
        }
        return userPageCaches.get(cacheKey);
    }

    function getScreenDataCache(cacheKey) {
        return screenDataCaches.get(cacheKey) ?? null;
    }

    function setScreenDataCache(cacheKey, payload) {
        screenDataCaches.set(cacheKey, payload);
        trimPageCacheMap(screenDataCaches, MAX_SCREEN_DATA_CACHES);
        persistPageCaches();
    }

    function deleteScreenDataCache(cacheKey) {
        if (screenDataCaches.delete(cacheKey)) persistPageCaches();
    }

    function getDmCacheKey(kind, dmId = '') {
        const userScope = getCurrentUser()?.id ?? 'guest';
        return `${userScope}:dm:${kind}:${dmId}`;
    }

    function invalidateDmCaches(dmId = null) {
        const userScope = getCurrentUser()?.id ?? 'guest';
        const prefix = `${userScope}:dm:`;
        let changed = false;
        screenDataCaches.forEach((_, cacheKey) => {
            const matchesConversation =
                dmId !== null &&
                cacheKey === getDmCacheKey('conversation', String(dmId));
            if (
                cacheKey === getDmCacheKey('list') ||
                (dmId === null && cacheKey.startsWith(prefix)) ||
                matchesConversation
            ) {
                screenDataCaches.delete(cacheKey);
                changed = true;
            }
        });
        if (changed) persistPageCaches();
    }

    function invalidateTimelinePageCache() {
        timelinePageCaches.clear();
        profilePostPageCaches.clear();
        auxiliaryPostPageCaches.clear();
        userPageCaches.clear();
        // DM・ユーザー検索の画面データは投稿の変更とは独立して保持する。
        persistPageCaches();
    }

    restorePageCaches();

    let pendingRealtimeTimelineUpdateUserId = null;

    function hasPendingRealtimeTimelineUpdate() {
        return (
            Number.isInteger(Number(getCurrentUser()?.id)) &&
            Number(pendingRealtimeTimelineUpdateUserId) ===
                Number(getCurrentUser()?.id)
        );
    }

    function updateRealtimeTimelineIndicator() {
        const indicator = document.getElementById('new-posts-indicator');
        const mainScreen = document.getElementById('main-screen');
        if (!indicator || !mainScreen) return;
        const shouldShow =
            hasPendingRealtimeTimelineUpdate() &&
            !mainScreen.classList.contains('hidden');
        indicator.classList.toggle('hidden', !shouldShow);
    }

    function queueRealtimeTimelineUpdate() {
        const userId = Number(getCurrentUser()?.id);
        if (!Number.isInteger(userId)) return;
        pendingRealtimeTimelineUpdateUserId = userId;
        updateRealtimeTimelineIndicator();
    }

    function clearRealtimeTimelineUpdate() {
        pendingRealtimeTimelineUpdateUserId = null;
        updateRealtimeTimelineIndicator();
    }

    const SCROLL_POSITIONS_STORAGE_KEY = 'nyaitter_scroll_positions';
    const MAX_SAVED_SCROLL_POSITIONS = 100;
    let activeScrollRouteKey = null;
    let scrollSaveTimer = null;
    let scrollRestoreVersion = 0;
    let routerGeneration = 0;

    function getScrollRouteKey(hash = window.location.hash) {
        const userScope = getCurrentUser()?.id ?? 'guest';
        return `${userScope}:${hash || '#'}`;
    }

    function getSavedScrollPositions() {
        try {
            const parsed = JSON.parse(
                sessionStorage.getItem(SCROLL_POSITIONS_STORAGE_KEY) || '{}',
            );
            return parsed &&
                typeof parsed === 'object' &&
                !Array.isArray(parsed)
                ? parsed
                : {};
        } catch (_) {
            return {};
        }
    }

    function clearSavedScrollPosition(routeKey) {
        if (!routeKey) return;
        try {
            const positions = getSavedScrollPositions();
            if (!Object.prototype.hasOwnProperty.call(positions, routeKey))
                return;
            delete positions[routeKey];
            sessionStorage.setItem(
                SCROLL_POSITIONS_STORAGE_KEY,
                JSON.stringify(positions),
            );
        } catch (_) {
            // sessionStorageが無効・満杯の場合も画面操作を妨げない。
        }
    }

    function saveScrollPosition(routeKey = activeScrollRouteKey) {
        if (!routeKey) return;
        try {
            const positions = getSavedScrollPositions();
            positions[routeKey] = {
                x: Math.max(0, Math.round(window.scrollX || 0)),
                y: Math.max(0, Math.round(window.scrollY || 0)),
                updatedAt: Date.now(),
            };
            const staleKeys = Object.entries(positions)
                .sort(
                    ([, a], [, b]) =>
                        Number(a?.updatedAt || 0) - Number(b?.updatedAt || 0),
                )
                .slice(0, -MAX_SAVED_SCROLL_POSITIONS)
                .map(([key]) => key);
            staleKeys.forEach((key) => delete positions[key]);
            sessionStorage.setItem(
                SCROLL_POSITIONS_STORAGE_KEY,
                JSON.stringify(positions),
            );
        } catch (_) {
            // sessionStorageが無効・満杯の場合も画面操作を妨げない。
        }
    }

    function scheduleScrollPositionSave() {
        const routeKey = activeScrollRouteKey;
        if (!routeKey || scrollSaveTimer) return;
        scrollSaveTimer = setTimeout(() => {
            scrollSaveTimer = null;
            // 遷移開始後に古いタイマーが実行されても、遷移先の描画状態で
            // 直前ページのスクロール位置を上書きしない。
            if (activeScrollRouteKey !== routeKey) return;
            saveScrollPosition(routeKey);
        }, 200);
    }

    function beginScrollRouteTransition() {
        const previousRouteKey = activeScrollRouteKey;
        if (scrollSaveTimer) {
            clearTimeout(scrollSaveTimer);
            scrollSaveTimer = null;
        }
        // 画面のDOMを切り替える前に直前ページの現在位置を確定する。
        if (previousRouteKey) saveScrollPosition(previousRouteKey);
        // 遷移先を描画するまで保存先を未設定にし、ローディング中のscrollイベントで
        // 直前ページの位置が0,0に書き換えられることを防ぐ。
        activeScrollRouteKey = null;
    }

    function restoreScrollPosition(routeKey) {
        const saved = getSavedScrollPositions()[routeKey];
        const x = Number(saved?.x);
        const y = Number(saved?.y);
        const targetX = Number.isFinite(x) && x >= 0 ? x : 0;
        const targetY = Number.isFinite(y) && y >= 0 ? y : 0;
        const version = ++scrollRestoreVersion;

        const restoreAfterPaint = () => {
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    if (
                        version !== scrollRestoreVersion ||
                        activeScrollRouteKey !== routeKey
                    )
                        return;
                    window.scrollTo({
                        left: targetX,
                        top: targetY,
                        behavior: 'auto',
                    });
                });
            });
        };

        // ルーターが各ページの描画Promiseを完了した後、
        // 次の描画フレームで一度だけ復元する。
        restoreAfterPaint();
    }

    if ('scrollRestoration' in window.history)
        window.history.scrollRestoration = 'manual';
    window.addEventListener('scroll', scheduleScrollPositionSave, {
        passive: true,
    });
    window.addEventListener('pagehide', () => {
        if (scrollSaveTimer) {
            clearTimeout(scrollSaveTimer);
            scrollSaveTimer = null;
        }
        saveScrollPosition();
    });

    // 認証状態はサーバー発行のHttpOnly Cookieだけで保持する。
    // アカウント一覧は表示補助用のプロフィール情報だけを保持する。
    function ensureAccountListStorage() {
        try {
            const accounts = JSON.parse(
                localStorage.getItem('nyaitter_accounts') || '[]',
            );
            if (!Array.isArray(accounts))
                localStorage.removeItem('nyaitter_accounts');
        } catch (_) {
            localStorage.removeItem('nyaitter_accounts');
        }
    }

    ensureAccountListStorage();

    function formatNyaitterId(id) {
        const numericId = Number(id);
        return Number.isSafeInteger(numericId) && numericId >= 0
            ? String(numericId).padStart(4, '0')
            : '????';
    }

    function getNyaitterId(userOrId) {
        if (
            userOrId &&
            typeof userOrId === 'object' &&
            /^#\d{1,16}$/.test(String(userOrId.nyaitter_id || ''))
        ) {
            return userOrId.nyaitter_id;
        }
        const id =
            userOrId && typeof userOrId === 'object' ? userOrId.id : userOrId;
        return `#${formatNyaitterId(id)}`;
    }

    const POST_TIMESTAMP_FORMATS = new Set([
        'relative',
        'relative_detailed',
        'absolute_24',
        'absolute_12',
    ]);

    function normalizePostTimestampFormat(value) {
        return POST_TIMESTAMP_FORMATS.has(value) ? value : 'relative';
    }

    function getPostTimestampFormat() {
        return normalizePostTimestampFormat(
            getCurrentUser()?.settings?.post_timestamp_format,
        );
    }

    function formatPostTimestamp(post, format = getPostTimestampFormat()) {
        const value = post?.created_at;
        const date = value ? new Date(value) : null;
        if (!date || Number.isNaN(date.getTime())) return '日時不明';

        const pad = (number) => String(number).padStart(2, '0');
        const year = date.getFullYear();
        const month = pad(date.getMonth() + 1);
        const day = pad(date.getDate());
        const hour = date.getHours();
        const minute = pad(date.getMinutes());
        const second = pad(date.getSeconds());

        if (format === 'absolute_24')
            return `${year}/${month}/${day} ${pad(hour)}:${minute}:${second}`;
        if (format === 'absolute_12') {
            const period = hour < 12 ? '午前' : '午後';
            const hour12 = hour % 12 || 12;
            return `${year}/${month}/${day} ${period} ${pad(hour12)}:${minute}:${second}`;
        }

        const elapsedSeconds = Math.max(
            0,
            Math.floor((Date.now() - date.getTime()) / 1000),
        );
        let remaining = elapsedSeconds;
        const units = [
            ['年', 365 * 24 * 60 * 60],
            ['ヶ月', 30 * 24 * 60 * 60],
            ['日', 24 * 60 * 60],
            ['時間', 60 * 60],
            ['分', 60],
            ['秒', 1],
        ];
        const parts = [];
        for (const [label, seconds] of units) {
            const amount = Math.floor(remaining / seconds);
            remaining %= seconds;
            if (amount > 0) {
                parts.push(`${amount}${label}`);
                if (format === 'relative') break;
            }
        }
        return `${parts.length > 0 ? parts.join('') : '0秒'}前`;
    }

    function formatSecurityTimestamp(value) {
        const date = value ? new Date(value) : null;
        return date && !Number.isNaN(date.getTime())
            ? date.toLocaleString('ja-JP', {
                  dateStyle: 'medium',
                  timeStyle: 'short',
              })
            : '日時不明';
    }

    function supportsWebPush() {
        return (
            window.isSecureContext &&
            'serviceWorker' in navigator &&
            'PushManager' in window &&
            'Notification' in window
        );
    }

    function base64UrlToUint8Array(base64Url) {
        const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
        const base64 = (base64Url + padding)
            .replace(/-/g, '+')
            .replace(/_/g, '/');
        const rawData = window.atob(base64);
        return Uint8Array.from(rawData, (character) => character.charCodeAt(0));
    }

    async function registerPwaServiceWorker() {
        if (!('serviceWorker' in navigator) || !window.isSecureContext)
            return null;
        if (!getPwaRegistrationPromise()) {
            setPwaRegistrationPromise(
                navigator.serviceWorker
                    .register('/sw.js', { scope: '/' })
                    .then(() => navigator.serviceWorker.ready)
                    .catch((error) => {
                        console.warn(
                            '[pwa] Service worker registration failed:',
                            error,
                        );
                        setPwaRegistrationPromise(null);
                        return null;
                    }),
            );
        }
        return getPwaRegistrationPromise();
    }

    function setPushSettingsUi({
        status,
        actionLabel,
        actionDisabled = false,
    }) {
        const statusEl = document.getElementById('push-notification-status');
        const button = document.getElementById('push-notification-action');
        if (statusEl) statusEl.textContent = status;
        if (button) {
            button.textContent = actionLabel;
            button.disabled = actionDisabled;
        }
    }

    async function loadPushSettingsState() {
        if (!getCurrentUser()) return null;
        if (!supportsWebPush()) {
            setPushSettingsUi({
                status: window.isSecureContext
                    ? 'このブラウザはプッシュ通知に対応していません。'
                    : 'プッシュ通知にはHTTPS（localhostを除く）が必要です。',
                actionLabel: 'この環境では利用できません',
                actionDisabled: true,
            });
            return null;
        }

        setPushSettingsUi({
            status: '通知の状態を確認しています…',
            actionLabel: '読み込み中…',
            actionDisabled: true,
        });
        const [registration, configResult] = await Promise.all([
            registerPwaServiceWorker(),
            apiRequest('/server/api/push/config'),
        ]);
        if (!registration) {
            setPushSettingsUi({
                status: 'サービスワーカーを登録できませんでした。',
                actionLabel: '利用できません',
                actionDisabled: true,
            });
            return null;
        }
        if (
            configResult.error ||
            !configResult.data?.enabled ||
            !configResult.data?.vapid_public_key
        ) {
            setPushSettingsUi({
                status: 'このサーバーではプッシュ通知がまだ設定されていません。',
                actionLabel: 'サーバー設定待ち',
                actionDisabled: true,
            });
            return null;
        }

        const subscription = await registration.pushManager.getSubscription();
        const permission = Notification.permission;
        if (permission === 'denied') {
            setPushSettingsUi({
                status: 'ブラウザで通知が拒否されています。ブラウザ設定から許可してください。',
                actionLabel: '通知が拒否されています',
                actionDisabled: true,
            });
            return {
                registration,
                config: configResult.data,
                subscription,
                permission,
            };
        }

        setPushSettingsUi({
            status: subscription
                ? 'この端末でプッシュ通知を購読中です。'
                : 'この端末ではプッシュ通知を購読していません。',
            actionLabel: subscription
                ? 'この端末の購読を解除'
                : 'この端末で通知を有効化',
            actionDisabled: false,
        });
        return {
            registration,
            config: configResult.data,
            subscription,
            permission,
        };
    }

    async function togglePushSubscription() {
        const button = document.getElementById('push-notification-action');
        if (button) button.disabled = true;
        try {
            const state = await loadPushSettingsState();
            if (!state) return;

            if (state.subscription) {
                const endpoint = state.subscription.endpoint;
                const unsubscribed = await state.subscription.unsubscribe();
                if (!unsubscribed)
                    throw new Error('ブラウザ側の購読解除に失敗しました。');
                const { error } = await apiRequest(
                    '/server/api/push/subscriptions',
                    {
                        method: 'DELETE',
                        body: { endpoint },
                    },
                );
                if (error) throw error;
                await loadPushSettingsState();
                return;
            }

            const permission =
                Notification.permission === 'default'
                    ? await Notification.requestPermission()
                    : Notification.permission;
            if (permission !== 'granted') {
                await loadPushSettingsState();
                return;
            }

            const subscription = await state.registration.pushManager.subscribe(
                {
                    userVisibleOnly: true,
                    applicationServerKey: base64UrlToUint8Array(
                        state.config.vapid_public_key,
                    ),
                },
            );
            const { error } = await apiRequest(
                '/server/api/push/subscriptions',
                {
                    method: 'POST',
                    body: { subscription: subscription.toJSON() },
                },
            );
            if (error) {
                await subscription.unsubscribe();
                throw error;
            }
            await loadPushSettingsState();
        } catch (error) {
            console.error('[pwa] Push subscription update failed:', error);
            setPushSettingsUi({
                status: `通知設定を更新できませんでした: ${error.message || '不明なエラー'}`,
                actionLabel: 'もう一度試す',
                actionDisabled: false,
            });
        }
    }

    const contributors = apiRequest('/server/api/contributors')
        .then(({ data, error }) => {
            if (error || !Array.isArray(data?.contributors)) return [];
            return data.contributors;
        })
        .catch(() => []);

    let customEmojiIds = [];
    const custom_emoji = fetch('/emoji/list.json', {
        credentials: 'same-origin',
    })
        .then((res) => {
            if (!res.ok)
                throw new Error(
                    `emoji list request failed: HTTP ${res.status}`,
                );
            return res.json();
        })
        .then((list) => {
            const emojiList = Array.isArray(list) ? list : [];
            customEmojiIds = [
                ...new Set(
                    emojiList
                        .map((emoji) => String(emoji?.id || ''))
                        .filter((id) => /^[A-Za-z0-9_-]{1,80}$/.test(id)),
                ),
            ].sort(
                (left, right) =>
                    right.length - left.length || left.localeCompare(right),
            );
            return emojiList;
        })
        .catch((error) => {
            console.warn(
                '[emoji] Custom emoji list could not be loaded:',
                error,
            );
            customEmojiIds = [];
            return [];
        });

    const POSTS_PER_PAGE = 30;

    const COLOR_THEME_PRESETS = Object.freeze({
        nyaitter: Object.freeze({
            primary_color: '#ff9900',
            primary_hover_color: '#e88b00',
            light_primary_color: '#ffebcc',
            dark_light_primary_color: '#8f5600',
        }),
        nyax: Object.freeze({
            primary_color: '#1d9bf0',
            primary_hover_color: '#1a8cd8',
            light_primary_color: '#cce6ff',
            dark_light_primary_color: '#004a8f',
        }),
    });
    const COLOR_THEME_CSS_VARIABLES = Object.freeze({
        primary_color: '--primary-color',
        primary_hover_color: '--primary-hover-color',
        light_primary_color: '--l-light-primary-color',
        dark_light_primary_color: '--d-light-primary-color',
    });
    const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

    function normalizeColorTheme(value) {
        return ['nyaitter', 'nyax', 'custom'].includes(value)
            ? value
            : 'nyaitter';
    }

    function getSafeColorPalette(colorTheme, customColors = {}) {
        const theme = normalizeColorTheme(colorTheme);
        const basePalette = COLOR_THEME_PRESETS.nyaitter;
        if (theme !== 'custom') return COLOR_THEME_PRESETS[theme];
        return Object.fromEntries(
            Object.entries(basePalette).map(([key, fallback]) => [
                key,
                typeof customColors?.[key] === 'string' &&
                HEX_COLOR_PATTERN.test(customColors[key])
                    ? customColors[key].toLowerCase()
                    : fallback,
            ]),
        );
    }

    function applyColorTheme(settings = {}) {
        const colorTheme = normalizeColorTheme(settings?.color_theme);
        const palette = getSafeColorPalette(
            colorTheme,
            settings?.custom_colors,
        );
        const rootStyle = document.documentElement.style;
        for (const [key, cssVariable] of Object.entries(
            COLOR_THEME_CSS_VARIABLES,
        )) {
            rootStyle.setProperty(cssVariable, palette[key]);
        }
        const themeColor = document.querySelector('meta[name="theme-color"]');
        if (themeColor) themeColor.content = palette.primary_color;
        return { colorTheme, palette };
    }

    function getCustomColorsFromInputs(root = document) {
        const requestedColors = {};
        root.querySelectorAll('.settings-color-code[data-color-key]').forEach(
            (input) => {
                requestedColors[input.dataset.colorKey] = input.value.trim();
            },
        );
        return getSafeColorPalette('custom', requestedColors);
    }

    function applyInterfaceTheme(themePreference = 'light') {
        setIsDarkmode(
            window.matchMedia('(prefers-color-scheme: dark)').matches,
        );
        const useDarkTheme =
            themePreference === 'dark' ||
            (themePreference === 'auto' && getIsDarkmode());
        document.body.classList.toggle('dark', useDarkTheme);
        document.body.classList.toggle('light', !useDarkTheme);
        setEmoji_picker_theme(useDarkTheme ? 'dark' : 'light');
    }

    function showLoading(show) {
        DOM.loadingOverlay.classList.toggle('hidden', !show);
        DOM.loadingOverlay.setAttribute('aria-hidden', String(!show));
        DOM.loadingOverlay.setAttribute('aria-busy', String(show));
    }

    function isPullToRefreshMobileViewport() {
        return window.matchMedia('(max-width: 680px)').matches;
    }

    function getActivePullToRefreshContext() {
        const screenIds = [
            'main-screen',
            'likes-screen',
            'stars-screen',
            'notifications-screen',
            'profile-screen',
        ];
        const screenId = screenIds.find((id) => {
            const screen = document.getElementById(id);
            return screen && !screen.classList.contains('hidden');
        });
        if (!screenId) return null;

        const screen = document.getElementById(screenId);
        if (!screen) return null;
        if (screenId !== 'profile-screen') return { screenId, screen };

        const profileMatch = /^#profile\/(\d+)(?:\/([^/?#]+))?$/.exec(
            window.location.hash || '',
        );
        const userId = Number(profileMatch?.[1]);
        if (!Number.isInteger(userId) || userId < 0) return null;
        return {
            screenId,
            screen,
            userId,
            subpage: profileMatch?.[2] || 'posts',
        };
    }

    function updatePullToRefreshAvailability() {
        const enabled = Boolean(
            isPullToRefreshMobileViewport() && getActivePullToRefreshContext(),
        );
        document.documentElement.classList.toggle(
            'pull-to-refresh-enabled',
            enabled,
        );
        document.body.classList.toggle('pull-to-refresh-enabled', enabled);
    }

    function setupTimelinePullToRefresh() {
        const indicator = document.getElementById('pull-to-refresh-indicator');
        const label = indicator?.querySelector('.pull-to-refresh-label');
        if (!indicator || !label || indicator.dataset.bound === 'true') return;
        indicator.dataset.bound = 'true';

        const PULL_THRESHOLD = 66;
        const MAX_PULL_DISTANCE = 104;
        let startX = 0;
        let startY = 0;
        let startScrollY = 0;
        let trackingPull = false;
        let pullActive = false;
        let refreshInProgress = false;

        const resetIndicator = () => {
            pullActive = false;
            indicator.style.setProperty('--pull-distance', '0px');
            indicator.style.setProperty('--pull-opacity', '0');
            indicator.classList.remove(
                'is-pulling',
                'is-ready',
                'is-refreshing',
            );
            indicator.setAttribute('aria-hidden', 'true');
            label.textContent = '引いて更新';
        };

        const showPullProgress = (distance) => {
            const ready = distance >= PULL_THRESHOLD;
            indicator.style.setProperty('--pull-distance', `${distance}px`);
            indicator.style.setProperty(
                '--pull-opacity',
                String(Math.min(1, distance / 34)),
            );
            indicator.classList.add('is-pulling');
            indicator.classList.toggle('is-ready', ready);
            indicator.setAttribute('aria-hidden', 'false');
            label.textContent = ready ? '離して更新' : '引いて更新';
        };

        const canStartPull = (target) => {
            const context = getActivePullToRefreshContext();
            if (!context) return false;
            const mainContent = document.getElementById('main-content');
            const isWithinActiveScreen = context.screen.contains(target);
            const isWithinNotificationView =
                context.screenId === 'notifications-screen' &&
                mainContent?.contains(target);
            if (!isWithinActiveScreen && !isWithinNotificationView)
                return false;

            // ホームでは投稿本文・余白を含むタイムライン全体を開始対象にする。
            // 投稿内の操作ボタンや投稿フォームからの開始だけは除外する。
            if (context.screenId === 'main-screen') {
                const timeline = document.getElementById('timeline');
                if (!timeline?.contains(target)) return false;
            }

            // 通知が空の場合でも、タイトル付近を含む中央コンテンツから開始できる。
            // 「すべて既読」などのボタンは共通の除外条件で保護する。
            if (context.screenId === 'notifications-screen' && !mainContent) {
                return false;
            }

            return !target.closest(
                'button, input, textarea, select, option, [contenteditable="true"], .post-form-sticky-container',
            );
        };

        const refreshTimeline = async () => {
            refreshInProgress = true;
            indicator.classList.remove('is-pulling', 'is-ready');
            indicator.classList.add('is-refreshing');
            indicator.style.setProperty('--pull-distance', '0px');
            indicator.style.setProperty('--pull-opacity', '1');
            indicator.setAttribute('aria-hidden', 'false');
            label.textContent = '更新中';

            try {
                const context = getActivePullToRefreshContext();
                if (!context) return;

                // 明示的な更新では、表示中の投稿・ユーザー一覧を必ず再取得する。
                invalidateTimelinePageCache();
                if (context.screenId === 'main-screen') {
                    clearRealtimeTimelineUpdate();
                    await switchTimelineTab(getCurrentTimelineTab(), {
                        forceRefresh: true,
                        resetScroll: true,
                    });
                } else if (context.screenId === 'likes-screen') {
                    await showLikesScreen();
                } else if (context.screenId === 'stars-screen') {
                    await showStarsScreen();
                } else if (context.screenId === 'notifications-screen') {
                    await showNotificationsScreen();
                } else if (context.screenId === 'profile-screen') {
                    // ヘッダー・タブは保持し、下部のタイムライン／ユーザー一覧だけ再取得する。
                    const profileUser = activeProfilePullRefreshUser;
                    if (Number(profileUser?.id) !== context.userId) return;
                    await loadProfileTabContent(profileUser, context.subpage);
                }
            } catch (error) {
                console.error('タイムラインの更新に失敗:', error);
                label.textContent = '更新に失敗しました';
            } finally {
                window.setTimeout(() => {
                    refreshInProgress = false;
                    resetIndicator();
                }, 220);
            }
        };

        document.addEventListener(
            'touchstart',
            (event) => {
                updatePullToRefreshAvailability();
                if (refreshInProgress || !isPullToRefreshMobileViewport())
                    return;
                const target =
                    event.target instanceof Element ? event.target : null;
                const touch = event.touches[0];
                if (!target || !touch || !canStartPull(target)) return;
                startX = touch.clientX;
                startY = touch.clientY;
                startScrollY = Math.max(0, window.scrollY || 0);
                trackingPull = true;
            },
            { passive: true },
        );

        document.addEventListener(
            'touchmove',
            (event) => {
                if (!trackingPull || refreshInProgress) return;
                const touch = event.touches[0];
                if (!touch) {
                    trackingPull = false;
                    resetIndicator();
                    return;
                }

                const deltaX = touch.clientX - startX;
                const deltaY = touch.clientY - startY;
                if (deltaY <= 0 || Math.abs(deltaX) > deltaY) {
                    if (pullActive) resetIndicator();
                    return;
                }

                // 指を下へ動かしている間は追跡を維持する。途中から始めた場合は、
                // 最上端へ戻るまでの移動量を差し引いた残りだけをPTRの引き量にする。
                if (window.scrollY > 1) return;
                const pullDistance = Math.max(0, deltaY - startScrollY);
                const distance = Math.min(
                    MAX_PULL_DISTANCE,
                    pullDistance * 0.55,
                );
                if (distance < 4) return;
                pullActive = true;
                showPullProgress(distance);
                if (event.cancelable) event.preventDefault();
            },
            { passive: false },
        );

        const finishPull = () => {
            if (!trackingPull) return;
            trackingPull = false;
            startScrollY = 0;
            const shouldRefresh =
                pullActive &&
                Number.parseFloat(
                    indicator.style.getPropertyValue('--pull-distance'),
                ) >= PULL_THRESHOLD;
            if (!shouldRefresh) {
                resetIndicator();
                return;
            }
            void refreshTimeline();
        };

        document.addEventListener('touchend', finishPull, { passive: true });
        document.addEventListener(
            'touchcancel',
            () => {
                trackingPull = false;
                startScrollY = 0;
                if (!refreshInProgress) resetIndicator();
            },
            { passive: true },
        );
        window.addEventListener('resize', updatePullToRefreshAvailability, {
            passive: true,
        });
        updatePullToRefreshAvailability();
    }

    function showScreen(screenId) {
        DOM.screens.forEach((screen) => {
            if (!screen.classList.contains('hidden')) {
                screen.classList.add('hidden');
            }
        });
        const targetScreen = document.getElementById(screenId);
        if (targetScreen) {
            targetScreen.classList.remove('hidden');
        }
        setupTimelinePullToRefresh();
        updatePullToRefreshAvailability();
    }

    function escapeHTML(str) {
        if (typeof str !== 'string') return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML.replaceAll(`'`, '&#39;').replaceAll(`"`, '&#34;');
    }

    function getSafeHttpUrl(value, fallback = '') {
        try {
            const url = new URL(String(value || ''), window.location.origin);
            if (!['http:', 'https:'].includes(url.protocol)) return fallback;
            if (
                url.protocol === 'http:' &&
                url.origin !== window.location.origin
            )
                return fallback;
            return url.href;
        } catch (_) {
            return fallback;
        }
    }

    function getEmoji(str) {
        switch (getCurrentUser()?.settings?.emoji || 'twemoji') {
            case 'twemoji':
                let twe_div = document.createElement('div');
                twe_div.innerHTML = twemoji.parse(str, {
                    callback: function (icon, options) {
                        return `https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/svg/${icon}.svg`;
                    },
                });
                twe_div.querySelectorAll('img').forEach((value) => {
                    value.title = emojione.toShort(value.alt);
                });
                return twe_div.innerHTML;
            case 'emojione':
                return emojione.toImage(str);
            default:
                return str;
        }
    }

    function getUserIconUrl(user) {
        const userId = Number(user?.id);
        return Number.isInteger(userId) && userId > 0
            ? `/server/api/users/${encodeURIComponent(userId)}/icon`
            : '/logo.png';
    }

    function getUserHeaderImageUrl(user) {
        const fileId =
            typeof user?.header_image === 'string'
                ? user.header_image.trim()
                : '';
        if (!fileId || fileId.startsWith('data:image')) return null;
        const { data } = api.storage.from('nyaitter').getPublicUrl(fileId);
        return getSafeHttpUrl(data?.publicUrl) || null;
    }

    async function renderDmMessage(msg, dmId = null) {
        const plaintext = await dmE2EDecryptMessage(msg, getCurrentUser().id);
        await ensureMentionedUsersCached([plaintext]);
        if (msg.type === 'system') {
            const formattedContent = formatPostContent(
                plaintext,
                getAllUsersCache(),
                { allowMarkdown: true },
            );
            return `<div class="dm-system-message">${formattedContent}</div>`;
        }

        let attachmentsHTML = '';
        if (msg.attachments && msg.attachments.length > 0) {
            attachmentsHTML += '<div class="attachments-container">';
            for (const attachment of msg.attachments) {
                const { data: publicUrlData } = api.storage
                    .from('nyaitter')
                    .getPublicUrl(attachment.id);
                const safeAttachmentUrl = getSafeHttpUrl(
                    publicUrlData?.publicUrl,
                );
                if (!safeAttachmentUrl) continue;
                const publicURL = escapeHTML(safeAttachmentUrl);
                const attachmentName = escapeHTML(
                    String(attachment.name || '添付ファイル').slice(0, 255),
                );

                let itemHTML = '<div class="attachment-item">';
                if (attachment.type === 'image') {
                    itemHTML += `<img src="${publicURL}" alt="${attachmentName}" class="attachment-image" data-action="open-image" data-url="${publicURL}">`;
                } else if (attachment.type === 'video') {
                    itemHTML += `<video src="${publicURL}" controls></video>`;
                } else if (attachment.type === 'audio') {
                    itemHTML += `<audio src="${publicURL}" controls></audio>`;
                }

                itemHTML += `<a href="${publicURL}" class="attachment-download-link" data-action="download-attachment" data-url="${publicURL}" data-name="${attachmentName}">${getEmoji('📄')} ${attachmentName}</a>`;
                itemHTML += '</div>';
                attachmentsHTML += itemHTML;
            }
            attachmentsHTML += '</div>';
        }

        const formattedContent = plaintext
            ? formatPostContent(plaintext, getAllUsersCache(), {
                  allowMarkdown: true,
              })
            : '';
        const sent = msg.userid === getCurrentUser().id;

        if (sent) {
            return `<div class="dm-message-container sent" data-message-id="${escapeHTML(msg.id)}">
	                <div class="dm-message-wrapper">
	                    <button type="button" class="dm-message-menu-btn" title="メッセージメニュー" aria-label="メッセージメニュー">${ICONS.more}</button>
	                    <div class="post-menu">
	                        <button class="edit-dm-msg-btn">編集</button>
	                        <button class="delete-dm-msg-btn delete-btn">削除</button>
	                    </div>
	                    <div class="dm-message"><div class="dm-message-content">${formattedContent}</div>${attachmentsHTML}</div>
	                </div>
	            </div>`;
        } else {
            const user = getAllUsersCache().get(msg.userid) || {};
            const time = formatPostTimestamp(msg);
            return `<div class="dm-message-container received" data-message-id="${escapeHTML(msg.id)}">
	                <a href="#profile/${user.id}" class="dm-user-link">
	                    <img src="${getUserIconUrl(user)}" class="dm-message-icon">
	                </a>
                        <div class="dm-message-wrapper">
	                    <div class="post-menu">
	                        <button class="report-dm-message-btn" data-dm-id="${escapeHTML(String(dmId || ''))}" data-message-id="${escapeHTML(String(msg.id || ''))}">報告する</button>
	                    </div>
	                    <div class="dm-message-meta">
	                        <a href="#profile/${user.id}" class="dm-user-link">${getEmoji(escapeHTML(user.name || '不明'))}</a>
	                        <span class="dm-message-time">・${time}</span>
	                        <button type="button" class="dm-message-menu-btn" title="メッセージメニュー" aria-label="メッセージメニュー">${ICONS.more}</button>
	                    </div>
	                    <div class="dm-message"><div class="dm-message-content">${formattedContent}</div>${attachmentsHTML}</div>
	                </div>
	            </div>`;
        }
    }

    function attachDmMessageClamp(messageEl) {
        if (!(messageEl instanceof HTMLElement)) return;
        if (messageEl.dataset.clampInitialized === 'true') return;
        const contentEl = messageEl.querySelector('.dm-message-content');
        if (!contentEl) return;
        messageEl.dataset.clampInitialized = 'true';
        messageEl.dataset.clampContent = '1';

        const toggleBtn = document.createElement('button');
        toggleBtn.type = 'button';
        toggleBtn.className = 'dm-clamp-toggle';
        toggleBtn.textContent = '続きを表示';
        toggleBtn.setAttribute('aria-expanded', 'false');
        toggleBtn.addEventListener('click', () => {
            const expanded = contentEl.classList.toggle(
                'dm-message-content-expanded',
            );
            toggleBtn.textContent = expanded ? '閉じる' : '続きを表示';
            toggleBtn.setAttribute('aria-expanded', String(expanded));
            toggleBtn.classList.toggle('expanded', expanded);
        });
        contentEl.after(toggleBtn);

        const measure = () => {
            if (!messageEl.isConnected || !contentEl.isConnected) return null;
            const wasExpanded = contentEl.classList.contains(
                'dm-message-content-expanded',
            );
            if (!wasExpanded)
                contentEl.classList.add('dm-message-content-expanded');
            const naturalHeight = contentEl.getBoundingClientRect().height;
            if (!wasExpanded)
                contentEl.classList.remove('dm-message-content-expanded');
            const clampLimit = Number.parseFloat(
                window.getComputedStyle(contentEl).maxHeight,
            );
            if (Number.isFinite(clampLimit) && naturalHeight > clampLimit + 1) {
                toggleBtn.classList.add('is-visible');
            }
            return true;
        };
        let attempts = 0;
        const timer = setInterval(() => {
            if (measure() === true || ++attempts >= 20) clearInterval(timer);
        }, 50);
    }

    function initializeDmMessageClamps(root = document) {
        root.querySelectorAll('.dm-message').forEach(attachDmMessageClamp);
    }

    function positionDmMessageMenu(menu, menuButton) {
        const edgeMargin = 8;
        const gap = 6;
        const buttonRect = menuButton.getBoundingClientRect();
        const opensRightPreferred = menuButton
            .closest('.dm-message-container')
            ?.classList.contains('received');

        menu.classList.add('dm-message-menu-popover');
        menu.style.maxWidth = `${Math.max(
            0,
            window.innerWidth - edgeMargin * 2,
        )}px`;

        const menuWidth = menu.offsetWidth;
        const menuHeight = menu.offsetHeight;
        let opensRight = Boolean(opensRightPreferred);
        let left = opensRight
            ? buttonRect.right + gap
            : buttonRect.left - menuWidth - gap;

        if (left + menuWidth > window.innerWidth - edgeMargin) {
            opensRight = false;
            left = buttonRect.left - menuWidth - gap;
        }
        if (left < edgeMargin) {
            opensRight = true;
            left = buttonRect.right + gap;
        }
        left = Math.max(
            edgeMargin,
            Math.min(left, window.innerWidth - menuWidth - edgeMargin),
        );

        let top = buttonRect.top;
        if (top + menuHeight > window.innerHeight - edgeMargin) {
            top = buttonRect.bottom - menuHeight;
        }
        top = Math.max(
            edgeMargin,
            Math.min(top, window.innerHeight - menuHeight - edgeMargin),
        );

        menu.classList.toggle('dm-message-menu-opens-right', opensRight);
        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;
        menu.style.right = 'auto';
        menu.style.bottom = 'auto';
    }

    function isActiveDmConversation(dmId) {
        return (
            String(getActiveDmId() || '') === String(dmId || '') &&
            window.location.hash === `#dm/${encodeURIComponent(String(dmId))}`
        );
    }

    function hasRenderedDmMessage(view, messageId) {
        return [...view.querySelectorAll('[data-message-id]')].some(
            (element) =>
                String(element.dataset.messageId) === String(messageId),
        );
    }

    function queueRealtimeDmMessage(dmId, message, sender) {
        const key = String(dmId);
        const pending = getPendingRealtimeDmMessages().get(key) || [];
        if (
            !pending.some(
                (entry) => String(entry.message.id) === String(message.id),
            )
        ) {
            pending.push({ message, sender });
        }
        getPendingRealtimeDmMessages().set(key, pending);
    }

    async function markOpenDmMessageRead(dmId, message) {
        if (Number(message.userid) === Number(getCurrentUser()?.id)) return;
        const { error } = await apiRequest(
            `/server/api/dm/${encodeURIComponent(String(dmId))}/read`,
            {
                method: 'POST',
            },
        );
        if (error)
            console.error('リアルタイムDMの既読化に失敗しました:', error);
    }

    async function appendRealtimeDmMessage(dmId, message, sender = null) {
        if (
            !message ||
            typeof message !== 'object' ||
            !message.id ||
            !isActiveDmConversation(dmId)
        )
            return;
        if (sender && Number.isInteger(Number(sender.id)))
            getAllUsersCache().set(Number(sender.id), sender);

        const view = document.querySelector('.dm-conversation-view');
        if (!view) {
            queueRealtimeDmMessage(dmId, message, sender);
            return;
        }
        if (hasRenderedDmMessage(view, message.id)) return;
        if (getCurrentUser()?.block?.includes(Number(message.userid))) {
            await markOpenDmMessageRead(dmId, message);
            return;
        }

        const messageHtml = await renderDmMessage(message, dmId);
        if (
            !isActiveDmConversation(dmId) ||
            hasRenderedDmMessage(view, message.id)
        )
            return;
        view.insertAdjacentHTML('afterbegin', messageHtml);
        initializeDmMessageClamps(view);
        setLastRenderedMessageId(message.id);
        await markOpenDmMessageRead(dmId, message);
    }

    async function flushRealtimeDmMessages(dmId) {
        const key = String(dmId);
        const pending = getPendingRealtimeDmMessages().get(key) || [];
        getPendingRealtimeDmMessages().delete(key);
        for (const { message, sender } of pending) {
            await appendRealtimeDmMessage(key, message, sender);
        }
    }

    function updateFollowButtonState(
        buttonElement,
        isFollowing,
        isLock = false,
    ) {
        buttonElement.classList.remove(
            'follow-button-not-following',
            'follow-button-following',
        );
        if (isFollowing) {
            buttonElement.classList.add('follow-button-following');
            buttonElement.textContent = 'フォロー中';
            buttonElement.onmouseleave = () => {
                buttonElement.textContent = 'フォロー中';
            };
            buttonElement.onmouseenter = () => {
                buttonElement.textContent = 'フォロー解除';
            };
        } else {
            buttonElement.textContent = 'フォロー';
            buttonElement.classList.add('follow-button-not-following');
            buttonElement.onmouseenter = null;
            buttonElement.onmouseleave = null;
        }
        buttonElement.disabled = false;
    }

    async function sendNotification(recipientId, type, target = null) {
        if (
            !getCurrentUser() ||
            !recipientId ||
            !type ||
            recipientId === getCurrentUser().id
        )
            return;

        try {
            const { error } = await api.rpc(
                'send_notification_with_timestamp',
                {
                    recipient_id: recipientId,
                    type,
                    target,
                },
            );

            if (error) {
                console.error('通知の送信に失敗しました:', error);
            }
        } catch (e) {
            console.error('通知送信中にエラー発生:', e);
        }
    }

    function normalizeStructuredNotification(notification) {
        if (!notification || typeof notification !== 'object') return null;
        const id = Number(notification.id);
        if (!Number.isInteger(id)) return null;
        const target =
            notification.target && typeof notification.target === 'object'
                ? notification.target
                : null;
        const from =
            notification.from && typeof notification.from === 'object'
                ? notification.from
                : null;
        const targetPost =
            notification.target_post &&
            typeof notification.target_post === 'object'
                ? notification.target_post
                : notification.targetPost &&
                    typeof notification.targetPost === 'object'
                  ? notification.targetPost
                  : null;
        return {
            id,
            type:
                typeof notification.type === 'string'
                    ? notification.type
                    : 'admin_notice',
            from,
            target,
            targetPost:
                targetPost && typeof targetPost.content === 'string'
                    ? { id: Number(targetPost.id), content: targetPost.content }
                    : null,
            read: Boolean(notification.read),
            clicked: Boolean(notification.clicked),
            message:
                typeof notification.message === 'string'
                    ? notification.message
                    : null,
            created_at: notification.created_at || null,
        };
    }

    function notificationActorLabel(notification) {
        if (notification.from?.name) return `@${notification.from.name}`;
        if (Number.isInteger(Number(notification.from?.id))) {
            return `@#${String(notification.from.id).padStart(4, '0')}`;
        }
        return '誰か';
    }

    function getNotificationMessageSuffix(notification) {
        switch (notification.type) {
            case 'reply':
                return ' さんがあなたのポストに返信しました。';
            case 'quote':
                return ' さんがあなたのポストを引用しました。';
            case 'repost':
                return ' さんがあなたのポストをリポストしました。';
            case 'mention':
                return ' さんがあなたをメンションしました。';
            case 'like':
                return ' さんがあなたのポストにいいねしました。';
            case 'star':
                return ' さんがあなたのポストをお気に入りに追加しました。';
            case 'follow':
                return ' さんがあなたをフォローしました。';
            case 'dm_invite':
                return ' さんがあなたをDMに招待しました。';
            case 'dm_removed':
                return ' さんによってDMから削除されました。';
            case 'dm_host_transfer':
                return ' さんからDMの管理者権限を受け取りました。';
            case 'admin_notice':
                return ' さんからお知らせがあります。';
            default:
                return '';
        }
    }

    function getNotificationDisplayText(notification) {
        if (
            typeof notification.message === 'string' &&
            notification.message.trim()
        )
            return notification.message.trim();
        if (notification.type === 'login_approval')
            return '不明な場所からのログイン承認が必要です。';
        if (notification.type === 'moderation_assignment')
            return '新しいリクエストが割り当てられました。';
        if (notification.type === 'moderation_action_taken')
            return 'あなたが報告したコンテンツは、審査により不適切であると判定されました。コミュニティの健全化へのご協力に感謝します。';
        if (notification.type === 'moderation_no_action')
            return 'あなたが報告したコンテンツは、審査により適切だと判定されたため対応されません。';
        if (notification.type === 'appeal_approved')
            return '異議申し立てが承認され、アカウントの凍結が解除されました。';
        if (notification.type === 'appeal_rejected')
            return '異議申し立ては審査の結果、承認されませんでした。';
        if (notification.type === 'verification_approved')
            return '認証申請が承認されました。プロフィールに認証バッジが表示されます。';
        if (notification.type === 'verification_rejected')
            return '認証申請は審査の結果、承認されませんでした。';
        const suffix = getNotificationMessageSuffix(notification);
        return suffix
            ? `${notificationActorLabel(notification)}${suffix}`
            : '新しい通知があります。';
    }

    function appendNotificationDisplay(content, notification) {
        content.replaceChildren();

        const timestamp = document.createElement('div');
        timestamp.className = 'notification-timestamp';
        timestamp.textContent = formatPostTimestamp({
            created_at: notification.created_at,
        });
        content.appendChild(timestamp);

        const message = document.createElement('div');
        message.className = 'notification-message';
        if (
            typeof notification.message === 'string' &&
            notification.message.trim()
        ) {
            message.textContent = notification.message.trim();
        } else {
            const actorId = Number(notification.from?.id);
            const suffix = getNotificationMessageSuffix(notification);
            if (!Number.isInteger(actorId) || !suffix) {
                message.textContent = getNotificationDisplayText(notification);
            } else {
                const actorLink = document.createElement('a');
                actorLink.className = 'notification-actor-link';
                actorLink.href = `#profile/${actorId}`;
                actorLink.textContent = notificationActorLabel(notification);
                message.append(actorLink, document.createTextNode(suffix));
            }
        }
        content.appendChild(message);

        if (typeof notification.targetPost?.content === 'string') {
            const postPreview = notification.targetPost.content
                .replace(/[\r\n]+/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
            if (postPreview) {
                const preview = document.createElement('div');
                preview.className = 'notification-target-post';
                preview.textContent = postPreview;
                preview.title = postPreview;
                content.appendChild(preview);
            }
        }
    }

    // 通知タイプごとの遷移先ハッシュを決めるハンドラ。target(サーバー指定)より優先して
    // typeベースで挙動を決めたい通知はここに追加する。戻り値が null の場合は
    // target/from.id を使った既定のフォールバックへ進む。
    const notificationTypeTargetResolvers = {
        follow: (notification) => {
            const fromId = Number(notification.from?.id);
            return Number.isInteger(fromId) ? `#profile/${fromId}` : null;
        },
    };

    function getNotificationTargetHash(notification) {
        const resolver = notificationTypeTargetResolvers[notification.type];
        if (resolver) {
            const resolved = resolver(notification);
            if (resolved) return resolved;
        }

        const target = notification.target;
        if (target?.kind === 'post' && Number.isInteger(Number(target.id)))
            return `#post/${target.id}`;
        if (target?.kind === 'dm' && Number.isInteger(Number(target.id)))
            return `#dm/${target.id}`;
        if (target?.kind === 'user' && Number.isInteger(Number(target.id)))
            return `#profile/${target.id}`;
        if (
            target?.kind === 'route' &&
            typeof target.value === 'string' &&
            target.value.startsWith('#')
        )
            return target.value;
        if (Number.isInteger(Number(notification.from?.id)))
            return `#profile/${notification.from.id}`;
        return '#notifications';
    }

    function formatPostContent(
        text,
        userCache = new Map(),
        { allowMarkdown = false, editorSyntax = false } = {},
    ) {
        const renderSyntax = (syntax) =>
            editorSyntax
                ? `<span class="markdown-syntax">${escapeHTML(syntax)}</span>`
                : '';
        const createCustomEmojiMarkup = (emojiId) => {
            const image = `<img src="/emoji/${encodeURIComponent(emojiId)}.svg" alt="_${emojiId}_" data-emoji-id="${emojiId}" style="height: 1.2em; vertical-align: -0.2em; margin: 0 0.05em;" class="nyaitter-emoji">`;
            if (!editorSyntax) return image;
            return `<span class="markdown-editor-emoji" data-emoji-id="${emojiId}">${renderSyntax('_')}${image}<span class="markdown-editor-emoji-id" hidden>${escapeHTML(emojiId)}</span>${renderSyntax('_')}</span>`;
        };
        const replaceCustomEmoji = (value) => {
            let processed = value;
            for (const emojiId of customEmojiIds) {
                const escapedId = emojiId.replace(
                    /[.*+?^${}()|[\]\\]/g,
                    '\\$&',
                );
                const emojiPattern = new RegExp(`_${escapedId}_`, 'g');
                processed = processed.replace(
                    emojiPattern,
                    createCustomEmojiMarkup(emojiId),
                );
            }
            return processed;
        };
        const processStandardText = (standardText) => {
            let processed = escapeHTML(standardText);
            const urls = [];

            const urlRegex =
                /(https?:\/\/(?:www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b(?:[-a-zA-Z0-9()@:%_\+.~#?&//=;]*))/g;
            processed = processed.replace(urlRegex, (url) => {
                const placeholder = `%%URL_${urls.length}%%`;
                urls.push(url);
                return placeholder;
            });

            processed = replaceCustomEmoji(processed);

            processed = getEmoji(processed);

            const hashtagRegex = /#([^<>/@#\s]+)/g;
            processed = processed.replace(hashtagRegex, (match, tagName) => {
                return `<a href="#search/${encodeURIComponent(tagName)}">#${getEmoji(tagName)}</a>`;
            });
            const mentionRegex = /@(\d+)/g;
            processed = processed.replace(mentionRegex, (match, userId) => {
                const numericId = parseInt(userId);
                if (userCache.has(numericId)) {
                    const user = userCache.get(numericId);
                    const userName = user ? user.name : `user${numericId}`;
                    return `<a href="#profile/${numericId}">@${getEmoji(escapeHTML(userName))}</a>`;
                }
                return match;
            });

            urls.forEach((url, i) => {
                const placeholder = `%%URL_${i}%%`;
                const safeUrl = getSafeHttpUrl(url);
                const link = safeUrl
                    ? `<a href="${escapeHTML(safeUrl)}" target="_blank" rel="noopener noreferrer">${escapeHTML(url)}</a>`
                    : escapeHTML(url);
                processed = processed.replace(placeholder, link);
            });

            return processed.replace(/\n/g, '<br>');
        };

        if (!allowMarkdown) return processStandardText(text);

        return renderLimitedMarkdown(text, {
            renderText: processStandardText,
            renderLinkLabel: (label) =>
                getEmoji(replaceCustomEmoji(escapeHTML(label))),
            renderSyntax,
            allowHeadings: !editorSyntax,
            allowBlockquotes: !editorSyntax,
        });
    }

    function normalizeMarkdownEditorValue(value) {
        return String(value || '').replace(/\r\n?/g, '\n');
    }

    function getMarkdownEditorValue(editor) {
        return editor instanceof HTMLTextAreaElement
            ? normalizeMarkdownEditorValue(editor.value)
            : '';
    }

    function getMarkdownEditorPreview(editor) {
        return editor
            ?.closest('.markdown-textarea-editor')
            ?.querySelector('.markdown-editor-preview');
    }

    function getMarkdownEditorPaint(editor) {
        return editor
            ?.closest('.markdown-textarea-editor')
            ?.querySelector('.markdown-editor-paint');
    }

    function getMarkdownEditorSourceLength(node) {
        if (node.nodeType === Node.TEXT_NODE) return node.data.length;
        if (node.nodeType !== Node.ELEMENT_NODE) return 0;
        const element = node;
        if (
            element.classList.contains('markdown-editor-sentinel') ||
            element.classList.contains('markdown-editor-caret-anchor') ||
            element.classList.contains('markdown-editor-emoji-id')
        ) {
            return 0;
        }
        if (element.tagName === 'BR') return 1;
        if (element.matches('img.nyaitter-emoji[data-emoji-id]')) {
            return (element.dataset.emojiId || '').length;
        }
        return Array.from(element.childNodes).reduce(
            (length, child) => length + getMarkdownEditorSourceLength(child),
            0,
        );
    }

    function getMarkdownEditorSourceSegments(preview) {
        const segments = [];
        let sourceOffset = 0;
        const visit = (node) => {
            if (node.nodeType === Node.TEXT_NODE) {
                const length = node.data.length;
                if (length > 0) {
                    segments.push({
                        start: sourceOffset,
                        end: sourceOffset + length,
                        node,
                        kind: 'text',
                    });
                    sourceOffset += length;
                }
                return;
            }
            if (node.nodeType !== Node.ELEMENT_NODE) return;
            const element = node;
            if (
                element.classList.contains('markdown-editor-sentinel') ||
                element.classList.contains('markdown-editor-caret-anchor') ||
                element.classList.contains('markdown-editor-emoji-id')
            ) {
                return;
            }
            if (element.tagName === 'BR') {
                segments.push({
                    start: sourceOffset,
                    end: sourceOffset + 1,
                    node: element,
                    kind: 'break',
                });
                sourceOffset += 1;
                return;
            }
            if (element.matches('img.nyaitter-emoji[data-emoji-id]')) {
                const length = (element.dataset.emojiId || '').length;
                if (length > 0) {
                    segments.push({
                        start: sourceOffset,
                        end: sourceOffset + length,
                        node: element,
                        kind: 'emoji',
                    });
                    sourceOffset += length;
                }
                return;
            }
            Array.from(element.childNodes).forEach(visit);
        };
        Array.from(preview.childNodes).forEach(visit);
        return { segments, sourceLength: sourceOffset };
    }

    function getMarkdownEditorSegmentBoundary(segment, sourceOffset) {
        if (segment.kind === 'text') {
            return {
                container: segment.node,
                offset: Math.max(
                    0,
                    Math.min(
                        sourceOffset - segment.start,
                        segment.node.data.length,
                    ),
                ),
            };
        }
        if (segment.kind === 'emoji') {
            const label = segment.node
                .closest('.markdown-editor-emoji')
                ?.querySelector('.markdown-editor-emoji-id:not([hidden])');
            if (label?.firstChild) {
                return {
                    container: label.firstChild,
                    offset: Math.max(
                        0,
                        Math.min(
                            sourceOffset - segment.start,
                            label.firstChild.data.length,
                        ),
                    ),
                };
            }
        }
        const parent = segment.node.parentNode;
        const index = Array.prototype.indexOf.call(
            parent.childNodes,
            segment.node,
        );
        return {
            container: parent,
            offset: index + (sourceOffset > segment.start ? 1 : 0),
        };
    }

    function getMarkdownEditorBoundary(preview, sourceOffset) {
        const { segments, sourceLength } =
            getMarkdownEditorSourceSegments(preview);
        const offset = Math.max(0, Math.min(sourceOffset, sourceLength));
        const activeEmojiSegment = segments.find((item) => {
            if (
                item.kind !== 'emoji' ||
                offset < item.start ||
                offset > item.end
            ) {
                return false;
            }
            return Boolean(
                item.node
                    .closest('.markdown-editor-emoji')
                    ?.querySelector('.markdown-editor-emoji-id:not([hidden])'),
            );
        });
        if (activeEmojiSegment) {
            return getMarkdownEditorSegmentBoundary(activeEmojiSegment, offset);
        }
        const segment = segments.find((item) => offset <= item.end);
        if (segment) return getMarkdownEditorSegmentBoundary(segment, offset);
        return { container: preview, offset: preview.childNodes.length };
    }

    function getMarkdownEditorCaretRect(preview, sourceOffset) {
        const { sourceLength } = getMarkdownEditorSourceSegments(preview);
        const offset = Math.max(0, Math.min(sourceOffset, sourceLength));
        if (offset < sourceLength) {
            const nextCharacterRect = getMarkdownEditorSelectionRects(
                preview,
                offset,
                offset + 1,
            ).at(0);
            if (nextCharacterRect) {
                return {
                    left: nextCharacterRect.left,
                    top: nextCharacterRect.top,
                    height: nextCharacterRect.height,
                };
            }
        }
        if (offset > 0) {
            const previousCharacterRect = getMarkdownEditorSelectionRects(
                preview,
                offset - 1,
                offset,
            ).at(-1);
            if (previousCharacterRect) {
                return {
                    left: previousCharacterRect.right,
                    top: previousCharacterRect.top,
                    height: previousCharacterRect.height,
                };
            }
        }

        const boundary = getMarkdownEditorBoundary(preview, offset);
        const range = document.createRange();
        try {
            range.setStart(boundary.container, boundary.offset);
            range.collapse(true);
        } catch {
            return null;
        }
        const rect =
            Array.from(range.getClientRects()).at(-1) ||
            range.getBoundingClientRect();
        if (rect.height > 0) return rect;

        const previewRect = preview.getBoundingClientRect();
        const style = window.getComputedStyle(preview);
        const fontSize = Number.parseFloat(style.fontSize) || 16;
        const lineHeight =
            Number.parseFloat(style.lineHeight) || fontSize * 1.2;
        return {
            left:
                previewRect.left + (Number.parseFloat(style.paddingLeft) || 0),
            top: previewRect.top + (Number.parseFloat(style.paddingTop) || 0),
            height: lineHeight,
        };
    }

    function getMarkdownEditorSelectionRects(preview, start, end) {
        if (start >= end) return [];
        const range = document.createRange();
        const startBoundary = getMarkdownEditorBoundary(preview, start);
        const endBoundary = getMarkdownEditorBoundary(preview, end);
        try {
            range.setStart(startBoundary.container, startBoundary.offset);
            range.setEnd(endBoundary.container, endBoundary.offset);
        } catch {
            return [];
        }
        return Array.from(range.getClientRects()).filter(
            (rect) => rect.width > 0 || rect.height > 0,
        );
    }

    function getMarkdownEditorSelectionSnapshot(editor) {
        const anchor = editor.selectionStart;
        const focus = editor.selectionEnd;
        return {
            anchor,
            focus,
            start: Math.min(anchor, focus),
            end: Math.max(anchor, focus),
        };
    }

    function getMarkdownEditorCompositionRange(editor) {
        const composition = editor._markdownEditorComposition;
        if (!composition?.active || !composition.data) return null;
        const source = editor.value;
        const data = composition.data;
        const preferredStart = Math.max(
            0,
            Math.min(composition.start, source.length - data.length),
        );
        let start =
            source.slice(preferredStart, preferredStart + data.length) === data
                ? preferredStart
                : -1;
        if (start < 0) {
            const aroundCaret = Math.max(
                0,
                editor.selectionStart - data.length,
            );
            start = source.lastIndexOf(data, aroundCaret);
        }
        if (start < 0) return null;
        return { start, end: start + data.length };
    }

    function getMarkdownEditorSelectedCompositionClause(editor, composition) {
        const selection = getMarkdownEditorSelectionSnapshot(editor);
        if (
            selection.start >= selection.end ||
            selection.start < composition.start ||
            selection.end > composition.end
        ) {
            return null;
        }
        return selection;
    }

    function appendMarkdownEditorRect(layer, className, rect, paintRect) {
        const element = document.createElement('span');
        element.className = className;
        element.style.left = `${rect.left - paintRect.left}px`;
        element.style.top = `${rect.top - paintRect.top}px`;
        element.style.width = `${Math.max(rect.width, 1)}px`;
        element.style.height = `${rect.height}px`;
        layer.append(element);
    }

    function syncMarkdownEditorCompositionDecoration(editor, preview, paint) {
        const layer = paint.querySelector('.markdown-editor-composition');
        if (!layer) return;
        layer.replaceChildren();
        const composition = getMarkdownEditorCompositionRange(editor);
        if (!composition) return;
        const paintRect = paint.getBoundingClientRect();
        getMarkdownEditorSelectionRects(
            preview,
            composition.start,
            composition.end,
        ).forEach((rect) => {
            appendMarkdownEditorRect(
                layer,
                'markdown-editor-composition-underline',
                rect,
                paintRect,
            );
        });

        const selectedClause = getMarkdownEditorSelectedCompositionClause(
            editor,
            composition,
        );
        if (!selectedClause) return;
        getMarkdownEditorSelectionRects(
            preview,
            selectedClause.start,
            selectedClause.end,
        ).forEach((rect) => {
            appendMarkdownEditorRect(
                layer,
                'markdown-editor-selection-rect',
                rect,
                paintRect,
            );
        });
    }

    function syncMarkdownEditorEmojiLabels(editor, preview, selection) {
        const { start: selectionStart, end: selectionEnd } = selection;
        const { segments } = getMarkdownEditorSourceSegments(preview);
        preview.querySelectorAll('.markdown-editor-emoji').forEach((token) => {
            const image = token.querySelector(
                'img.nyaitter-emoji[data-emoji-id]',
            );
            const label = token.querySelector('.markdown-editor-emoji-id');
            const segment = segments.find((item) => item.node === image);
            if (!image || !label || !segment) return;
            const tokenStart = Math.max(0, segment.start - 1);
            const tokenEnd = segment.end + 1;
            const active =
                selectionStart === selectionEnd
                    ? selectionStart > tokenStart && selectionStart < tokenEnd
                    : selectionStart < tokenEnd && selectionEnd > tokenStart;
            image.hidden = active;
            label.hidden = !active;
        });
    }

    function syncMarkdownEditorDecoration(editor) {
        const preview = getMarkdownEditorPreview(editor);
        const paint = getMarkdownEditorPaint(editor);
        if (!preview || !paint) return;
        const selectionLayer = paint.querySelector(
            '.markdown-editor-selection',
        );
        const caret = paint.querySelector('.markdown-editor-caret');
        if (!selectionLayer || !caret) return;

        const selection = getMarkdownEditorSelectionSnapshot(editor);
        const expectedMode =
            selection.start === selection.end &&
            !editor._markdownEditorComposition?.active
                ? 'formatted'
                : 'raw';
        if (preview.dataset.markdownEditorMode !== expectedMode) {
            updateMarkdownEditorPreview(editor, selection);
        }
        syncMarkdownEditorEmojiLabels(editor, preview, selection);
        paint.style.transform = `translate(${-editor.scrollLeft}px, ${-editor.scrollTop}px)`;
        selectionLayer.replaceChildren();
        syncMarkdownEditorCompositionDecoration(editor, preview, paint);
        caret.hidden = true;

        if (document.activeElement !== editor) return;

        const { start, end } = selection;
        const paintRect = paint.getBoundingClientRect();
        if (start !== end) {
            getMarkdownEditorSelectionRects(preview, start, end).forEach(
                (rect) => {
                    const highlight = document.createElement('span');
                    highlight.className = 'markdown-editor-selection-rect';
                    highlight.style.left = `${rect.left - paintRect.left}px`;
                    highlight.style.top = `${rect.top - paintRect.top}px`;
                    highlight.style.width = `${Math.max(rect.width, 1)}px`;
                    highlight.style.height = `${rect.height}px`;
                    selectionLayer.append(highlight);
                },
            );
            return;
        }

        const rect = getMarkdownEditorCaretRect(preview, start);
        if (!rect || rect.height === 0) return;
        caret.hidden = false;
        caret.style.left = `${rect.left - paintRect.left}px`;
        caret.style.top = `${rect.top - paintRect.top}px`;
        caret.style.height = `${rect.height}px`;
    }

    function updateMarkdownEditorPreview(
        editor,
        selection = getMarkdownEditorSelectionSnapshot(editor),
    ) {
        const preview = getMarkdownEditorPreview(editor);
        if (!preview) return;
        const source = getMarkdownEditorValue(editor);
        const rawTextMode =
            selection.start !== selection.end ||
            Boolean(editor._markdownEditorComposition?.active);
        if (rawTextMode) {
            preview.textContent = source;
        } else {
            preview.innerHTML = source
                ? formatPostContent(source, getAllUsersCache(), {
                      allowMarkdown: true,
                      editorSyntax: true,
                  })
                : '';
        }
        preview.dataset.markdownEditorMode = rawTextMode ? 'raw' : 'formatted';
        preview.classList.remove('hidden');
        const placeholder = getMarkdownEditorPaint(editor)?.querySelector(
            '.markdown-editor-placeholder',
        );
        if (placeholder) {
            placeholder.textContent = editor.dataset.markdownPlaceholder || '';
            placeholder.hidden = Boolean(source);
        }
        requestAnimationFrame(() => syncMarkdownEditorDecoration(editor));
    }

    function getContentEditorPreference() {
        return getCurrentUser()?.settings?.content_editor === 'nyaitter'
            ? 'nyaitter'
            : 'textarea';
    }

    function applyContentEditorPreference(editor) {
        const host = editor.closest('.markdown-textarea-editor');
        if (!host) return false;
        if (editor.dataset.markdownPlaceholder === undefined) {
            editor.dataset.markdownPlaceholder = editor.placeholder || '';
        }
        const useNyaitterEditor = getContentEditorPreference() === 'nyaitter';
        host.classList.toggle('is-nyaitter-editor', useNyaitterEditor);
        host.classList.toggle('is-plain-textarea', !useNyaitterEditor);
        editor.placeholder = useNyaitterEditor
            ? ''
            : editor.dataset.markdownPlaceholder || '';
        return useNyaitterEditor;
    }

    function refreshMarkdownContentEditors() {
        document
            .querySelectorAll('textarea[data-markdown-content-editor]')
            .forEach((editor) => attachMarkdownContentEditor(editor));
    }

    function attachMarkdownContentEditor(editor) {
        if (!(editor instanceof HTMLTextAreaElement)) return;
        const useNyaitterEditor = applyContentEditorPreference(editor);
        if (!useNyaitterEditor) return;
        if (editor.dataset.markdownContentEditor === 'true') {
            updateMarkdownEditorPreview(editor);
            return;
        }
        editor.dataset.markdownContentEditor = 'true';
        editor.spellcheck = true;
        const sync = () => syncMarkdownEditorDecoration(editor);
        const updateComposition = (event) => {
            const previous = editor._markdownEditorComposition;
            editor._markdownEditorComposition = {
                active: true,
                start: previous?.start ?? editor.selectionStart,
                data: String(event.data || ''),
            };
            updateMarkdownEditorPreview(editor);
        };
        editor.addEventListener('compositionstart', updateComposition);
        editor.addEventListener('compositionupdate', updateComposition);
        editor.addEventListener('compositionend', () => {
            delete editor._markdownEditorComposition;
            updateMarkdownEditorPreview(editor);
        });
        editor.addEventListener('input', () =>
            updateMarkdownEditorPreview(editor),
        );
        editor.addEventListener('select', sync);
        editor.addEventListener('keyup', sync);
        editor.addEventListener('focus', sync);
        editor.addEventListener('blur', sync);
        editor.addEventListener('scroll', sync);
        getMarkdownEditorPreview(editor)?.addEventListener('load', sync, true);

        document.addEventListener('selectionchange', () => {
            if (document.activeElement === editor) sync();
        });
        void custom_emoji.then(() => updateMarkdownEditorPreview(editor));
        updateMarkdownEditorPreview(editor);
    }

    function setMarkdownEditorValue(editor, value, { focus = false } = {}) {
        if (!(editor instanceof HTMLTextAreaElement)) return;
        editor.value = normalizeMarkdownEditorValue(value);
        if (focus) editor.focus();
        editor.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function insertMarkdownEditorText(editor, value) {
        if (!(editor instanceof HTMLTextAreaElement) || !value) return;
        editor.focus();
        const text = String(value);
        const start = editor.selectionStart;
        const end = editor.selectionEnd;
        editor.setRangeText(text, start, end, 'end');
        editor.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function toggleMarkdownSpoiler(spoiler) {
        if (!spoiler) return;
        const revealed = spoiler.classList.toggle('is-revealed');
        spoiler.setAttribute('aria-expanded', String(revealed));
        spoiler.setAttribute(
            'aria-label',
            revealed ? 'ネタバレを隠す' : 'ネタバレを表示',
        );
        spoiler
            .querySelector('.markdown-spoiler-content')
            ?.setAttribute('aria-hidden', String(!revealed));
    }

    document.addEventListener(
        'click',
        (event) => {
            const target =
                event.target instanceof Element ? event.target : null;
            const spoiler = target?.closest('.markdown-spoiler');
            if (
                !spoiler ||
                target.closest('a') ||
                spoiler.closest('.markdown-content-editor')
            )
                return;
            event.stopPropagation();
            toggleMarkdownSpoiler(spoiler);
        },
        true,
    );

    document.addEventListener(
        'keydown',
        (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            const target =
                event.target instanceof Element ? event.target : null;
            const spoiler = target?.closest('.markdown-spoiler');
            if (spoiler?.closest('.markdown-content-editor')) return;
            if (!spoiler) return;
            event.preventDefault();
            event.stopPropagation();
            toggleMarkdownSpoiler(spoiler);
        },
        true,
    );

    function filterBlockedPosts(posts) {
        if (!Array.isArray(posts)) return posts;
        return posts.filter((post) => {
            const authorId = Number(
                post.userid || post.user?.id || post.author?.id,
            );
            if (!Number.isInteger(authorId)) return true;

            // サーバーが相互フォローまで検証する。クライアント側では少なくとも未ログイン・未フォロー時の
            // キャッシュ投稿を除外し、投稿lockと投稿者設定lockの両方を同じ非公開状態として扱う。
            if (post.private || post.lock) {
                const following = (getCurrentUser()?.follow || []).map(Number);
                if (
                    !getCurrentUser() ||
                    (Number(getCurrentUser().id) !== authorId &&
                        !following.includes(authorId))
                ) {
                    return false;
                }
            }
            if (!getCurrentUser()) return true;

            // 自分がこの投稿主をブロックしている場合は常に除外
            if (
                Array.isArray(getCurrentUser().block) &&
                getCurrentUser().block.map(Number).includes(authorId)
            )
                return false;

            const author = getAllUsersCache().get(authorId);
            // 投稿主が自分をブロックしている場合
            if (
                author &&
                Array.isArray(author.block) &&
                author.block.map(Number).includes(Number(getCurrentUser().id))
            ) {
                return false;
            }
            return true;
        });
    }

    async function ensureMentionedUsersCached(texts) {
        const allMentionedIds = new Set();
        for (const text of texts) {
            if (!text) continue;
            for (const match of text.matchAll(/@(\d+)/g)) {
                allMentionedIds.add(parseInt(match[1]));
            }
        }
        const newIdsToFetch = [...allMentionedIds].filter(
            (id) => id && !getAllUsersCache().has(id),
        );
        if (newIdsToFetch.length > 0) {
            const { data: users } = await api
                .from('user')
                .select('id, name, scid, icon_data')
                .in('id', newIdsToFetch);
            if (users) users.forEach((u) => getAllUsersCache().set(u.id, u));
        }
    }

    function isNotBlank(str) {
        if (str.match(/\S/)) return true;
        else return false;
    }

    async function emoji_picker_create(container) {
        const emojiList = await custom_emoji;
        const custom = [];
        for (const value of emojiList) {
            const emojiId = String(value?.id || '');
            if (!/^[A-Za-z0-9_-]{1,80}$/.test(emojiId)) continue;
            const emojiName = String(value?.name || emojiId).slice(0, 120);
            custom.push({
                id: emojiId,
                name: emojiName,
                keywords: [emojiId, emojiName, 'NyaitterEmoji'],
                skins: [{ src: `/emoji/${encodeURIComponent(emojiId)}.svg` }],
            });
        }

        const picker = container.querySelector('#emoji-picker');
        const pickerButton = container.querySelector('.emoji-pic-button');
        const editor = container.querySelector(
            '[data-markdown-content-editor]',
        );
        if (!picker || !pickerButton || !editor) return;

        const emojiMart = window.EmojiMart;
        if (!emojiMart?.Picker) {
            pickerButton.disabled = true;
            pickerButton.title = '絵文字ピッカーを読み込めませんでした';
            return;
        }

        const pickerOptions = {
            onEmojiSelect: (emoji) => {
                const value =
                    Array.isArray(emoji.keywords) &&
                    emoji.keywords.includes('NyaitterEmoji')
                        ? `_${emoji.id}_`
                        : String(emoji.native || '');
                if (!value) return;
                insertMarkdownEditorText(editor, value);
                picker.classList.add('hidden');
            },
            set: 'native',
            searchPosition: 'none',
            locale: 'ja',
            custom: [
                {
                    id: 'nyaitter',
                    name: 'NyaitterEmoji',
                    emojis: custom,
                },
            ],
            categoryIcons: {
                nyaitter: {
                    svg: `<svg viewBox="0 0 1 1" aria-label="Nyaitter"><image href="/logo.png" width="1" height="1" preserveAspectRatio="xMidYMid meet"></image></svg>`,
                },
            },
            categories: [
                'frequent',
                'nyaitter',
                'people',
                'nature',
                'foods',
                'activity',
                'places',
                'objects',
                'symbols',
                'flags',
            ],
            skinTonePosition: 'none',
            skin: '1',
            theme: getEmoji_picker_theme(),
        };

        picker.replaceChildren(new emojiMart.Picker(pickerOptions));
        pickerButton.addEventListener('click', () => {
            picker.classList.toggle('hidden');
            if (!picker.classList.contains('hidden')) {
                const buttonRect = pickerButton.getBoundingClientRect();
                const pickerWidth = 320;
                let left = buttonRect.left;
                if (left + pickerWidth > window.innerWidth)
                    left = window.innerWidth - pickerWidth - 8;
                if (left < 8) left = 8;
                picker.style.left = `${left}px`;
                picker.style.top = `${buttonRect.bottom + 8}px`;
            }
        });
        editor.addEventListener('focus', () => picker.classList.add('hidden'));
    }

    async function router() {
        const generation = ++routerGeneration;
        beginScrollRouteTransition();
        // 進行中の古い復元処理を無効化する。
        scrollRestoreVersion += 1;
        let routeKey = getScrollRouteKey();
        showLoading(true);
        setIsLoadingMore(false);

        applyInterfaceTheme(getCurrentUser()?.settings?.theme || 'light');
        applyColorTheme(getCurrentUser()?.settings || {});

        const existingSubTabs = document.getElementById(
            'profile-sub-tabs-container',
        );
        if (existingSubTabs) {
            existingSubTabs.remove();
        }

        await updateNavAndSidebars();
        // hashchangeと明示的なrouter()呼び出しが重なった場合、古いルーターは
        // 新しい遷移のDOMやスクロール状態に触れない。
        if (generation !== routerGeneration) return;
        const hash = window.location.hash || '#';
        routeKey = getScrollRouteKey(hash);
        const activeDmMatch = hash.match(/^#dm\/([^/]+)$/);
        setActiveDmId(activeDmMatch ? activeDmMatch[1] : null);
        if (!getActiveDmId()) getPendingRealtimeDmMessages().clear();

        if (getPostLoadObserver()) {
            getPostLoadObserver().disconnect();
        }

        document.body.classList.toggle(
            'notocoloremoji',
            getCurrentUser()?.setting?.emoji == 'notocoloremoji',
        );

        try {
            if (hash.startsWith('#post/'))
                await showPostDetail(hash.substring(6));
            else if (hash.startsWith('#profile/')) {
                const path = hash.substring(9);
                const userId = parseInt(path, 10);
                if (isNaN(userId)) {
                    window.location.hash = '#';
                    return;
                }
                const subpageMatch = path.match(/\/(.+)/);
                const subpage = subpageMatch ? subpageMatch[1] : 'posts';
                await showProfileScreen(userId, subpage);
            } else if (hash.startsWith('#search/'))
                await showSearchResults(decodeURIComponent(hash.substring(8)));
            else if (
                hash.startsWith('#admin/reports/') &&
                getCurrentUser()?.admin
            )
                await showAdminReportDetailScreen(
                    hash.substring('#admin/reports/'.length),
                );
            else if (hash === '#admin/reports' && getCurrentUser()?.admin)
                await showAdminReportsScreen();
            else if (hash === '#admin/logs' && getCurrentUser()?.admin)
                await showAdminLogsScreen();
            else if (hash.startsWith('#dm/') && getCurrentUser())
                await showDmScreen(hash.substring(4));
            else if (hash === '#dm' && getCurrentUser()) await showDmScreen();
            else if (
                (hash === '#settings' || hash.startsWith('#settings/')) &&
                getCurrentUser()
            )
                await showSettingsScreen(getSettingsGroupFromHash(hash));
            else if (hash.startsWith('#login-approval/') && getCurrentUser()) {
                await showNotificationsScreen();
                await openLoginApprovalModal(
                    hash.substring('#login-approval/'.length),
                );
            } else if (hash === '#explore') await showExploreScreen();
            else if (hash === '#notifications' && getCurrentUser())
                await showNotificationsScreen();
            else if (hash === '#likes' && getCurrentUser())
                await showLikesScreen();
            else if (hash === '#stars' && getCurrentUser())
                await showStarsScreen();
            else await showMainScreen();
        } catch (error) {
            if (generation !== routerGeneration) return;
            console.error('Routing error:', error);
            DOM.pageHeader.innerHTML = `<h2>エラー</h2>`;
            showScreen('main-screen');
            DOM.timeline.innerHTML = `<p class="error-message">ページの読み込み中にエラーが発生しました。</p>`;
        } finally {
            // `showAdminLogsScreen`内で個別にローディングを解除するため、ここでの一括解除は不要
            if (generation !== routerGeneration) return;
            activeScrollRouteKey = routeKey;
            restoreScrollPosition(routeKey);
        }
    }

    async function loadRightSidebar() {
        if (DOM.rightSidebar.searchWidget) {
            DOM.rightSidebar.searchWidget.innerHTML = ` <div class="sidebar-search-widget"> ${ICONS.explore} <input type="search" id="sidebar-search-input" placeholder="検索"> </div>`;
            document
                .getElementById('sidebar-search-input')
                .addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') {
                        const query = e.target.value.trim();
                        if (query) {
                            window.location.hash = `#search/${encodeURIComponent(query)}`;
                        }
                    }
                });
        }

        let error = null;
        if (getRecommendedUsersCache() === null) {
            if (!recommendedUsersRequest) {
                let query = api
                    .from('user')
                    .select('id, name, scid, icon_data');
                if (getCurrentUser())
                    query = query.neq('id', getCurrentUser().id);
                recommendedUsersRequest = query
                    .order('created_at', { ascending: false })
                    .limit(3)
                    .then((result) => {
                        if (!result.error)
                            setRecommendedUsersCache(
                                Array.isArray(result.data) ? result.data : [],
                            );
                        return result;
                    })
                    .finally(() => {
                        recommendedUsersRequest = null;
                    });
            }
            const result = await recommendedUsersRequest;
            error = result.error;
        }

        const data = getRecommendedUsersCache() || [];

        const linkItems = Array.isArray(WIDGET_LINKS) ? WIDGET_LINKS : [];
        if (DOM.rightSidebar.links) {
            DOM.rightSidebar.links.innerHTML = linkItems
                .map((item) => {
                    const name = escapeHTML(String(item?.name || 'リンク'));
                    const url = escapeHTML(
                        String(item?.url || item?.link || '#'),
                    );
                    const external = /^https:\/\//i.test(
                        String(item?.url || item?.link || ''),
                    );
                    return `<a href="${url}" class="link"${external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${name}</a>`;
                })
                .join('');
        }

        const recommendedUsers = Array.isArray(data) ? data : [];
        if (error || recommendedUsers.length === 0) {
            if (DOM.rightSidebar.recommendations)
                DOM.rightSidebar.recommendations.innerHTML = '';
            return;
        }
        let recHTML = '<div class="widget-title">おすすめユーザー</div>';
        recHTML += recommendedUsers
            .map((user) => {
                const isFollowing = getCurrentUser()?.follow?.includes(user.id);
                const btnClass = isFollowing
                    ? 'follow-button-following'
                    : 'follow-button-not-following';
                const btnText = isFollowing ? 'フォロー中' : 'フォロー';
                return ` <div class="widget-item recommend-user"> <a href="#profile/${user.id}" class="profile-link" style="text-decoration:none; color:inherit; display:flex; align-items:center; gap:0.5rem;"> <img src="${getUserIconUrl(user)}" style="width:40px;height:40px;border-radius:50%;" alt="${escapeHTML(user.name)}'s icon"> <div> <span>${getEmoji(escapeHTML(user.name))}</span> <small style="color:var(--secondary-text-color); display:block;">${getNyaitterId(user)}</small> </div> </a> ${getCurrentUser() && getCurrentUser().id !== user.id ? `<button class="${btnClass}" data-user-id="${user.id}">${btnText}</button>` : ''} </div>`;
            })
            .join('');
        if (DOM.rightSidebar.recommendations)
            DOM.rightSidebar.recommendations.innerHTML = `<div class="sidebar-widget">${recHTML}</div>`;
        DOM.rightSidebar.recommendations
            ?.querySelectorAll('.recommend-user button')
            .forEach((button) => {
                const userId = parseInt(button.dataset.userId);
                if (!isNaN(userId)) {
                    const isFollowing =
                        getCurrentUser()?.follow?.includes(userId);
                    updateFollowButtonState(button, isFollowing);
                    button.onclick = () =>
                        window.handleFollowToggle(userId, button);
                }
            });
    }

    function setupSidebarOverflowMenu() {
        sidebarOverflowAbortController?.abort();
        sidebarOverflowAbortController = new AbortController();
        const { signal } = sidebarOverflowAbortController;
        const sidebar = document.getElementById('left-nav');
        sidebar?.classList.remove('sidebar-overflow-open');
        const menu = DOM.navMenuTop;
        const existingOverflow = menu?.querySelector('.nav-overflow-menu');
        if (existingOverflow && menu) {
            existingOverflow
                .querySelectorAll(':scope > .nav-overflow-panel > a.nav-item')
                .forEach((item) => menu.insertBefore(item, existingOverflow));
            existingOverflow.remove();
        }

        if (window.matchMedia('(max-width: 680px)').matches) return;

        const logo = DOM.navLogo;
        const menuBottom = DOM.navMenuBottom;
        const postButton = menu?.querySelector('.nav-item-post');
        const menuLinks = menu
            ? [...menu.querySelectorAll(':scope > a.nav-item')]
            : [];
        if (!sidebar || !menu || menuLinks.length === 0) return;

        window.addEventListener(
            'resize',
            () => {
                window.clearTimeout(sidebarOverflowResizeTimer);
                sidebarOverflowResizeTimer = window.setTimeout(
                    setupSidebarOverflowMenu,
                    120,
                );
            },
            { signal },
        );

        const availableMenuHeight = () =>
            Math.max(
                0,
                sidebar.clientHeight -
                    (logo?.offsetHeight || 0) -
                    (menuBottom?.offsetHeight || 0) -
                    24,
            );
        if (menu.scrollHeight <= availableMenuHeight()) return;

        const overflow = document.createElement('div');
        overflow.className = 'nav-overflow-menu';
        overflow.innerHTML = `
            <button type="button" class="nav-item nav-overflow-toggle" aria-expanded="false" aria-controls="nav-overflow-panel">
                <span class="nav-item-icon-container">${ICONS.more}</span>
                <span class="nav-item-text">その他</span>
            </button>
            <div id="nav-overflow-panel" class="nav-overflow-panel hidden" role="menu"></div>`;
        const toggle = overflow.querySelector('.nav-overflow-toggle');
        const panel = overflow.querySelector('.nav-overflow-panel');
        menu.insertBefore(overflow, postButton || null);

        const fitsInSidebar = () => menu.scrollHeight <= availableMenuHeight();

        let visibleCount = menuLinks.length;
        while (!fitsInSidebar() && visibleCount > 0) {
            visibleCount -= 1;
            panel.prepend(menuLinks[visibleCount]);
        }

        if (visibleCount === menuLinks.length) {
            overflow.remove();
            return;
        }

        const closeOverflow = () => {
            overflow.classList.remove('is-open');
            sidebar?.classList.remove('sidebar-overflow-open');
            panel.classList.add('hidden');
            toggle?.setAttribute('aria-expanded', 'false');
        };
        const positionOverflowPanel = () => {
            if (!toggle || panel.classList.contains('hidden')) return;
            const edgeMargin = 8;
            const gap = 6;
            const toggleRect = toggle.getBoundingClientRect();
            const panelWidth = Math.min(
                240,
                Math.max(0, window.innerWidth - edgeMargin * 2),
            );
            panel.style.width = `${panelWidth}px`;
            panel.style.maxHeight = `${Math.max(0, window.innerHeight - edgeMargin * 2)}px`;

            const panelHeight = panel.offsetHeight;
            const panelWidthAfterLayout = panel.offsetWidth;
            let top = toggleRect.bottom + gap;
            if (top + panelHeight > window.innerHeight - edgeMargin) {
                top = toggleRect.top - panelHeight - gap;
            }
            top = Math.max(
                edgeMargin,
                Math.min(top, window.innerHeight - panelHeight - edgeMargin),
            );
            const left = Math.max(
                edgeMargin,
                Math.min(
                    toggleRect.left,
                    window.innerWidth - panelWidthAfterLayout - edgeMargin,
                ),
            );
            panel.style.top = `${top}px`;
            panel.style.left = `${left}px`;
        };
        const toggleOverflow = () => {
            const isOpen = overflow.classList.toggle('is-open');
            sidebar?.classList.toggle('sidebar-overflow-open', isOpen);
            panel.classList.toggle('hidden', !isOpen);
            toggle?.setAttribute('aria-expanded', String(isOpen));
            if (isOpen) positionOverflowPanel();
        };

        toggle?.addEventListener(
            'click',
            (event) => {
                event.stopPropagation();
                toggleOverflow();
            },
            { signal },
        );
        document.addEventListener(
            'click',
            (event) => {
                if (!overflow.contains(event.target)) closeOverflow();
            },
            { signal },
        );
        document.addEventListener(
            'keydown',
            (event) => {
                if (event.key === 'Escape') closeOverflow();
            },
            { signal },
        );
    }

    async function updateNavAndSidebars() {
        const hash = window.location.hash || '#';
        const menuItems = [
            { name: 'ホーム', hash: '#', icon: ICONS.home },
            { name: '検索', hash: '#explore', icon: ICONS.explore },
        ];
        let totalUnreadDmCount = 0;
        if (getCurrentUser()) {
            // ページ遷移ではHTTPサマリーを取得しない。初期値と以後の更新はリアルタイムイベントが担う。
            totalUnreadDmCount = Number(
                getCurrentUser().unreadDmTotal ??
                    getCurrentUser().dm_unread_count ??
                    0,
            );

            menuItems.push(
                {
                    name: '通知',
                    hash: '#notifications',
                    icon: ICONS.notifications,
                    badge: getCurrentUser().notification_unread_count,
                },
                { name: 'いいね', hash: '#likes', icon: ICONS.likes },
                { name: 'お気に入り', hash: '#stars', icon: ICONS.stars },
                {
                    name: 'メッセージ',
                    hash: '#dm',
                    icon: ICONS.dm,
                    badge: totalUnreadDmCount,
                },
                {
                    name: 'プロフィール',
                    hash: `#profile/${getCurrentUser().id}`,
                    icon: ICONS.profile,
                },
                {
                    name: '設定',
                    hash: '#settings/profile',
                    icon: ICONS.settings,
                },
            );
            if (getCurrentUser().admin) {
                menuItems.push({
                    name: 'リクエスト',
                    hash: '#admin/reports',
                    icon: ICONS.mask,
                });
            }
        }

        DOM.navLogo.innerHTML = `<a href="#" class="nav-logo-img">${ICONS.nyaitter_logo}</a>`;

        DOM.navMenuTop.innerHTML = menuItems
            .map((item) => {
                let isActive = false;
                if (item.hash === '#') {
                    isActive = hash === '#' || hash === '';
                } else if (item.hash === '#settings/profile') {
                    isActive =
                        hash === '#settings' || hash.startsWith('#settings/');
                } else {
                    isActive = hash.startsWith(item.hash);
                }
                return `
	                <a href="${item.hash}" class="nav-item ${item.hash === '#admin/reports' ? 'nav-item-request' : ''} ${isActive ? 'active' : ''}">
	                    <div class="nav-item-icon-container">
	                        ${item.icon}
	                        ${item.badge && item.badge > 0 ? `<span class="notification-badge">${item.badge > 99 ? '99+' : item.badge}</span>` : ''}
	                    </div>
	                    <span class="nav-item-text">${item.name}</span>
	                </a>`;
            })
            .join('');
        if (getCurrentUser())
            DOM.navMenuTop.innerHTML += `<button class="nav-item nav-item-post"><span class="nav-item-text">ポスト</span><span class="nav-item-icon">${ICONS.send}</span></button>`;
        // 未ログイン時は何も表示せず、ログインしている場合のみアカウントボタンを表示する
        DOM.navMenuBottom.innerHTML = getCurrentUser()
            ? `<button id="account-button" class="nav-item account-button"> <img src="${getUserIconUrl(getCurrentUser())}" class="user-icon" alt="${escapeHTML(getCurrentUser().name)}'s icon"> <div class="account-info"> <span class="name">${getEmoji(escapeHTML(getCurrentUser().name))}</span> <span class="id">${getNyaitterId(getCurrentUser())}</span> </div> </button>`
            : '';
        DOM.loginBanner.classList.toggle('hidden', !!getCurrentUser());
        DOM.navMenuTop.querySelectorAll('a.nav-item').forEach((link) => {
            link.onclick = (e) => {
                // hashchangeイベントに任せるため、preventDefaultはしない
            };
        });
        // ログアウトボタン（account-button）が存在する場合のみイベントリスナーを設定
        DOM.navMenuBottom
            .querySelector('#account-button')
            ?.addEventListener('click', openAccountSwitcherModal);
        DOM.navMenuTop
            .querySelector('.nav-item-post')
            ?.addEventListener('click', () => openPostModal());
        const PostButton = document.getElementsByClassName('nav-item-post')[0];
        const AccountButton = document.getElementById('account-button');
        if (PostButton) {
            if (
                window.matchMedia('(max-width:680px)').matches &&
                location.hash.startsWith('#dm')
            ) {
                if (!PostButton.classList.contains('hidden')) {
                    PostButton.classList.add('hidden');
                }
            } else if (PostButton.classList.contains('hidden')) {
                PostButton.classList.remove('hidden');
            }
        }
        if (AccountButton) {
            if (
                window.matchMedia('(max-width:680px)').matches &&
                location.hash.startsWith('#dm')
            ) {
                if (!AccountButton.classList.contains('hidden')) {
                    AccountButton.classList.add('hidden');
                }
            } else if (AccountButton.classList.contains('hidden')) {
                AccountButton.classList.remove('hidden');
            }
        }
        window.requestAnimationFrame(setupSidebarOverflowMenu);
        await loadRightSidebar();
    }

    function goToLoginPage() {
        if (typeof window.openNyaitterLoginModal === 'function') {
            window.openNyaitterLoginModal({ reset: false });
            return;
        }
        window.location.href = '/login';
    }
    async function handleLogout() {
        if (!(await showAppConfirm('ログアウトしますか？'))) return;
        const userId = getCurrentUser()?.id;
        if (userId) removeAccountFromList(userId);
        api.auth.signOut().then(() => {
            setCurrentUser(null);
            unsubscribeFromChanges();
            window.location.hash = '#';
            router();
        });
    }
    async function checkSession({ route = true } = {}) {
        // 起動アセットの準備後は、アカウント確認の通信完了を待たずに
        // ローディング画面を表示する。確認結果に応じたrouter()が完了時に閉じる。
        showLoading(true);
        const {
            data: { session },
            error: sessionError,
        } = await api.auth.getSession();

        if (sessionError || !session) {
            setCurrentUser(null);
            unsubscribeFromChanges();
            if (route) router();
            return false;
        }

        try {
            const authUserId = session.user.id;

            const { data, error } = await api
                .from('user')
                .select('*')
                .eq('uuid', authUserId)
                .single();

            if (error || !data)
                throw new Error('ユーザーデータの取得に失敗しました。');

            setCurrentUser(data);

            if (getCurrentUser().freeze) {
                DOM.freezeReason.textContent = getCurrentUser().freeze;
                DOM.freezeOverlay.classList.remove('hidden');
                setupFreezeAppealUi();
                await refreshFreezeAppealStatus();
                showLoading(false);
                return false;
            }

            // E2E暗号化を再有効化した場合だけ、鍵ペアを準備して公開鍵を登録する。
            if (DM_E2E_ENABLED) {
                void dmE2EEnsureKeyPairRegistered(getCurrentUser().id);
            }

            addAccountToList(getCurrentUser());
            subscribeToChanges();
            if (route) router();
            return true;
        } catch (error) {
            console.error(error);
            setCurrentUser(null);
            DOM.connectionErrorOverlay.classList.remove('hidden');
            return false;
        }
    }

    function updateFreezeAppealStatus(appeal) {
        const status = document.getElementById('freeze-appeal-status');
        const button = document.getElementById('open-freeze-appeal-btn');
        if (!status || !button) return;
        if (!appeal) {
            status.classList.add('hidden');
            status.textContent = '';
            button.disabled = false;
            button.textContent = '異議申し立てを行う';
            return;
        }
        status.textContent =
            appeal.status === 'assigned'
                ? '異議申し立ては担当管理者に割り当てられ、確認中です。'
                : '異議申し立てを受け付け、担当管理者への割当を待っています。';
        status.classList.remove('hidden');
        button.disabled = true;
        button.textContent = '異議申し立てを確認中';
    }

    async function refreshFreezeAppealStatus() {
        const { data, error } = await apiRequest('/server/api/appeals/me');
        if (error) return;
        updateFreezeAppealStatus(data?.appeal || null);
    }

    function closeFreezeAppealModal() {
        document.getElementById('freeze-appeal-modal')?.classList.add('hidden');
    }

    function setupFreezeAppealUi() {
        const openButton = document.getElementById('open-freeze-appeal-btn');
        const modal = document.getElementById('freeze-appeal-modal');
        const form = document.getElementById('freeze-appeal-form');
        const description = document.getElementById(
            'freeze-appeal-description',
        );
        const errorElement = document.getElementById('freeze-appeal-error');
        if (!openButton || !modal || !form || !description) return;

        openButton.onclick = () => {
            if (openButton.disabled) return;
            form.reset();
            errorElement?.classList.add('hidden');
            modal.classList.remove('hidden');
            description.focus();
        };
        modal
            .querySelectorAll('[data-action="close-freeze-appeal"]')
            .forEach((button) => {
                button.onclick = closeFreezeAppealModal;
            });
        modal.onclick = (event) => {
            if (event.target === modal) closeFreezeAppealModal();
        };
        form.onsubmit = async (event) => {
            event.preventDefault();
            const submit = form.querySelector('button[type="submit"]');
            submit.disabled = true;
            errorElement?.classList.add('hidden');
            const { data, error } = await apiRequest('/server/api/appeals', {
                method: 'POST',
                body: { description: description.value },
            });
            submit.disabled = false;
            if (error) {
                if (errorElement) {
                    errorElement.textContent =
                        error.message ||
                        String(error) ||
                        '異議申し立てを送信できませんでした。';
                    errorElement.classList.remove('hidden');
                }
                return;
            }
            closeFreezeAppealModal();
            updateFreezeAppealStatus(data?.appeal || null);
        };
    }

    function getPendingPushNotificationOpen() {
        const url = new URL(window.location.href);
        const userId = Number(url.searchParams.get('push_user_id'));
        const notificationId = Number(
            url.searchParams.get('push_notification_id'),
        );
        if (
            !Number.isInteger(userId) ||
            userId < 0 ||
            !Number.isInteger(notificationId) ||
            notificationId <= 0
        )
            return null;

        return {
            userId,
            notificationId,
            targetHash: url.hash.startsWith('#') ? url.hash : '#notifications',
        };
    }

    function replaceCurrentLocation({
        hash = window.location.hash,
        clearPush = false,
    } = {}) {
        const url = new URL(window.location.href);
        if (clearPush) {
            url.searchParams.delete('push_user_id');
            url.searchParams.delete('push_notification_id');
        }
        url.hash = hash || '#notifications';
        window.history.replaceState(
            window.history.state,
            '',
            `${url.pathname}${url.search}${url.hash}`,
        );
    }

    async function handlePendingPushNotificationOpen() {
        const pending = getPendingPushNotificationOpen();
        if (!pending) return false;

        // 一時パラメータを早期に消し、更新や再読み込みで同じ通知を再処理しない。
        replaceCurrentLocation({ clearPush: true, hash: pending.targetHash });

        // 先に現在のログイン状態を確定し、対象アカウントでなければ記憶済みセッションへ切り替える。
        await checkSession({ route: false });
        if (Number(getCurrentUser()?.id) !== pending.userId) {
            const { error: switchError } = await apiRequest(
                '/server/auth/accounts/switch',
                {
                    method: 'POST',
                    body: { user_id: pending.userId },
                },
            );
            if (switchError) {
                console.error(
                    'プッシュ通知のアカウント切替に失敗:',
                    switchError,
                );
                replaceCurrentLocation({ hash: '#' });
                await router();
                showAppAlert(
                    '通知の対象アカウントへ切り替えられませんでした。ログイン状態を確認してください。',
                );
                return true;
            }

            setCurrentUser(null);
            unsubscribeFromChanges();
            const sessionReady = await checkSession({ route: false });
            if (
                !sessionReady ||
                Number(getCurrentUser()?.id) !== pending.userId
            ) {
                replaceCurrentLocation({ hash: '#' });
                await router();
                showAppAlert(
                    '通知の対象アカウントを確認できませんでした。ログイン状態を確認してください。',
                );
                return true;
            }
        }

        const { data: readResult, error: readError } = await apiRequest(
            `/server/api/notifications/${encodeURIComponent(String(pending.notificationId))}/read`,
            { method: 'PUT' },
        );
        if (readError) {
            console.error('プッシュ通知の既読化に失敗:', readError);
            replaceCurrentLocation({ hash: '#notifications' });
            await router();
            showAppAlert(
                '通知を既読にできなかったため、対象コンテンツは開きませんでした。',
            );
            return true;
        }
        if (getCurrentUser()) {
            getCurrentUser().notification_unread_count = Number(
                readResult?.notification_unread_count || 0,
            );
        }

        const { error: clickedError } = await apiRequest(
            `/server/api/notifications/${encodeURIComponent(String(pending.notificationId))}/clicked`,
            { method: 'PUT' },
        );
        if (clickedError) {
            console.error('プッシュ通知のクリック済み化に失敗:', clickedError);
            replaceCurrentLocation({ hash: '#notifications' });
            await router();
            showAppAlert(
                '通知をクリック済みにできなかったため、対象コンテンツは開きませんでした。',
            );
            return true;
        }

        // 既読・クリック済みの両方が成功した後にのみ対象コンテンツを描画する。
        replaceCurrentLocation({ hash: pending.targetHash });
        await router();
        return true;
    }

    function getAccountList() {
        try {
            const accounts = JSON.parse(
                localStorage.getItem('nyaitter_accounts') || '[]',
            );
            return Array.isArray(accounts)
                ? accounts.map(
                      ({ token, refresh_token, access_token, ...profile }) =>
                          profile,
                  )
                : [];
        } catch (_) {
            return [];
        }
    }
    function setAccountList(list) {
        localStorage.setItem('nyaitter_accounts', JSON.stringify(list));
    }
    function addAccountToList(user) {
        let accounts = getAccountList();
        if (accounts.find((a) => a.id === user.id)) {
            while (accounts.find((a) => a.id === user.id)) {
                const Index = accounts.findIndex((a) => a.id === user.id);
                accounts.splice(Index, 1);
            }
        }
        accounts.push({
            id: user.id,
            name: user.name,
            icon_data: user.icon_data,
            scid: user.scid,
        });
        setAccountList(accounts);
    }
    function removeAccountFromList(userId) {
        let accounts = getAccountList().filter((a) => a.id !== userId);
        setAccountList(accounts);
    }
    function updateAccountData(user) {
        let accounts = getAccountList();
        let idx = accounts.findIndex((a) => a.id === user.id);
        if (idx !== -1) {
            accounts[idx] = {
                ...accounts[idx],
                name: user.name,
                icon_data: user.icon_data,
                scid: user.scid,
            };
            setAccountList(accounts);
        }
    }

    async function openAccountSwitcherModal() {
        const modal = document.getElementById('account-switcher-modal');
        const content = document.getElementById(
            'account-switcher-modal-content',
        );
        const { data: accountPayload, error } = await apiRequest(
            '/server/auth/accounts',
        );
        const accounts = error
            ? getAccountList()
            : Array.isArray(accountPayload?.accounts)
              ? accountPayload.accounts
              : [];
        const currentId = getCurrentUser()?.id;
        if (!error)
            setAccountList(
                accounts.map(({ id, name, icon_data, scid, nyaitter_id }) => ({
                    id,
                    name,
                    icon_data,
                    scid,
                    nyaitter_id,
                })),
            );

        content.innerHTML = `
	            <button class="account-switcher-add-btn">＋ アカウント追加</button>
	            <ul class="account-switcher-list">
	                ${
                        accounts
                            .map(
                                (acc) => `
	                    <li class="account-switcher-item${Number(acc.id) === Number(currentId) ? ' active' : ''}" data-id="${escapeHTML(String(acc.id))}">
	                        <span class="switcher-user-info">
	                            <img class="switcher-user-icon" src="${getUserIconUrl(acc)}" alt="${escapeHTML(acc.name || '')}">
	                            <span>${getEmoji(escapeHTML(acc.name || '不明なユーザー'))}</span>
								<span style="color:var(--secondary-text-color); font-size:0.95em;">${getNyaitterId(acc)}</span>
	                        </span>
	                        <button class="switcher-delete-btn" title="この端末からアカウントを解除">×</button>
	                    </li>`,
                            )
                            .join('') ||
                        '<li class="account-switcher-empty">アカウントがありません。</li>'
                    }
	            </ul>
	        `;
        modal.classList.remove('hidden');
        modal.querySelector('.modal-close-btn').onclick = () =>
            modal.classList.add('hidden');
        content.querySelector('.account-switcher-add-btn').onclick = () => {
            // 新しいアカウントを追加する時は、現在の画面内で通常の認証を行う。
            modal.classList.add('hidden');
            goToLoginPage();
        };
        content.querySelectorAll('.account-switcher-item').forEach((item) => {
            const userId = Number(item.dataset.id);
            item.onclick = async (event) => {
                if (event.target.closest('.switcher-delete-btn')) {
                    if (
                        !(await showAppConfirm(
                            'この端末からアカウントを解除しますか？',
                        ))
                    )
                        return;
                    const { data: result, error: removeError } =
                        await apiRequest(
                            `/server/auth/accounts/${encodeURIComponent(userId)}`,
                            { method: 'DELETE' },
                        );
                    if (removeError)
                        return showAppAlert(
                            `アカウントの解除に失敗しました: ${removeError.message}`,
                        );
                    removeAccountFromList(userId);
                    if (result?.active_removed) {
                        // 現在使用中のアカウントが解除された。
                        // 残っているアカウントがある場合は一覧の先頭（1番上）のアカウントへ
                        // 自動で切り替え、モーダルを再読み込みして最新の一覧を表示する。
                        setCurrentUser(null);
                        unsubscribeFromChanges();
                        window.location.hash = '#';
                        const {
                            data: remainingPayload,
                            error: remainingError,
                        } = await apiRequest('/server/auth/accounts');
                        const remainingAccounts =
                            !remainingError &&
                            Array.isArray(remainingPayload?.accounts)
                                ? remainingPayload.accounts
                                : getAccountList();
                        if (remainingAccounts.length > 0) {
                            const nextAccount = remainingAccounts[0];
                            const { error: switchError } = await apiRequest(
                                '/server/auth/accounts/switch',
                                {
                                    method: 'POST',
                                    body: { user_id: Number(nextAccount.id) },
                                },
                            );
                            if (switchError) {
                                showAppAlert(
                                    `アカウントの切替に失敗しました: ${switchError.message}`,
                                );
                            } else {
                                await checkSession();
                            }
                        }
                        if (!getCurrentUser()) await checkSession();
                    }
                    await openAccountSwitcherModal();
                    return;
                }
                if (userId === Number(currentId)) return;

                const { error: switchError } = await apiRequest(
                    '/server/auth/accounts/switch',
                    {
                        method: 'POST',
                        body: { user_id: userId },
                    },
                );
                if (switchError)
                    return showAppAlert(
                        `アカウントの切替に失敗しました: ${switchError.message}`,
                    );
                modal.classList.add('hidden');
                setCurrentUser(null);
                unsubscribeFromChanges();
                window.location.hash = '#';
                await checkSession();
            };
        });
    }

    async function openLoginApprovalModal(approvalId) {
        if (
            !getCurrentUser() ||
            !/^[A-Za-z0-9_-]{16,128}$/.test(String(approvalId || ''))
        )
            return;
        const modal = document.getElementById('login-approval-modal');
        const body = document.getElementById('login-approval-modal-body');
        const close = () => {
            modal.classList.add('hidden');
            if (window.location.hash.startsWith('#login-approval/'))
                window.location.hash = '#notifications';
        };
        modal.classList.remove('hidden');
        modal.querySelector('.modal-close-btn').onclick = close;
        modal.onclick = (event) => {
            if (event.target === modal) close();
        };
        body.replaceChildren();
        const loading = document.createElement('p');
        loading.textContent = 'ログイン要求を確認しています…';
        body.appendChild(loading);

        const { data, error } = await apiRequest(
            `/server/auth/login-approvals/${encodeURIComponent(approvalId)}`,
        );
        if (error || !data?.approval) {
            body.replaceChildren();
            const message = document.createElement('p');
            message.textContent =
                error?.message || 'ログイン要求を確認できませんでした。';
            body.appendChild(message);
            return;
        }
        const approval = data.approval;
        const title = document.createElement('h3');
        title.id = 'login-approval-modal-title';
        title.textContent = '不明な場所からのログイン';
        const description = document.createElement('p');
        description.textContent =
            '次の端末からログインしようとしています。心当たりがある場合のみ許可してください。';
        const ip = document.createElement('p');
        ip.className = 'login-approval-detail';
        ip.textContent = `場所: ${approval.ip_masked || '不明なIPアドレス'}`;
        const device = document.createElement('p');
        device.className = 'login-approval-detail';
        device.textContent = `端末: ${approval.user_agent || '不明な端末'}`;
        const requestedAt = document.createElement('p');
        requestedAt.className = 'login-approval-detail';
        requestedAt.textContent = `要求日時: ${formatSecurityTimestamp(approval.created_at)}`;
        body.replaceChildren(title, description, ip, device, requestedAt);

        if (approval.status !== 'pending') {
            const state = document.createElement('p');
            state.className = 'settings-help-text';
            state.textContent =
                approval.status === 'approved'
                    ? 'このログインは許可済みです。'
                    : 'このログイン要求は既に処理済みです。';
            body.appendChild(state);
            return;
        }

        const actions = document.createElement('div');
        actions.className = 'login-approval-actions';
        const deny = document.createElement('button');
        deny.type = 'button';
        deny.className = 'settings-danger-button';
        deny.textContent = '拒否';
        const approve = document.createElement('button');
        approve.type = 'button';
        approve.className = 'settings-primary-button';
        approve.textContent = '許可';
        const decide = async (decision) => {
            approve.disabled = true;
            deny.disabled = true;
            const { error: decisionError } = await apiRequest(
                `/server/auth/login-approvals/${encodeURIComponent(approval.id)}/decision`,
                {
                    method: 'POST',
                    body: { decision },
                },
            );
            if (decisionError) {
                approve.disabled = false;
                deny.disabled = false;
                showAppAlert(
                    `ログイン要求の処理に失敗しました: ${decisionError.message}`,
                );
                return;
            }
            close();
        };
        deny.addEventListener('click', () => decide('deny'));
        approve.addEventListener('click', () => decide('approve'));
        actions.append(deny, approve);
        body.appendChild(actions);
    }

    function openPostModal(replyInfo = null) {
        if (!getCurrentUser()) return goToLoginPage();
        DOM.postModal.classList.remove('hidden');
        const modalContainer = DOM.postModal.querySelector(
            '.post-form-container-modal',
        );
        modalContainer.innerHTML =
            createPostFormHTML(true) +
            `<div id="quoting-preview-container"></div>`;
        attachPostFormListeners(modalContainer);

        if (replyInfo) {
            setReplyingTo(replyInfo);
            const replyInfoDiv = modalContainer.querySelector('#reply-info');
            replyInfoDiv.innerHTML = `<span>@${escapeHTML(replyInfo.name)}に返信中</span>`;
            replyInfoDiv.classList.remove('hidden');
        }

        if (getQuotingPost()) {
            const QuoterepryInfoDiv =
                modalContainer.querySelector('#reply-info');
            QuoterepryInfoDiv.innerHTML = `<span>注意: 引用を返信代わりに使用する行為は推奨されていません。</span>`;
            QuoterepryInfoDiv.classList.remove('hidden');
            const previewContainer = modalContainer.querySelector(
                '#quoting-preview-container',
            );
            const nestedPost = document.createElement('div');
            nestedPost.className = 'nested-repost-container';
            nestedPost.innerHTML = `<div class="post-header"><img src="${getUserIconUrl(getQuotingPost().user)}" class="user-icon" style="width:24px;height:24px;"> <span class="post-author">${getEmoji(escapeHTML(getQuotingPost().user.name))}</span></div><div class="post-content">${escapeHTML(getQuotingPost().content)}</div>`;
            previewContainer.appendChild(nestedPost);
        }

        DOM.postModal.querySelector('.modal-close-btn').onclick =
            closePostModal;
        modalContainer.querySelector('#post-content').focus();
    }
    function closePostModal() {
        DOM.postModal.classList.add('hidden');
        setReplyingTo(null);
        setQuotingPost(null);
        setSelectedFiles([]);
    }
    const handleCtrlEnter = (e) => {
        if (e.ctrlKey && e.key === 'Enter') {
            e.target
                .closest('.post-form')
                .querySelector('button[id^="post-submit-button"]')
                .click();
        }
    };

    function openRepostModal(post, triggerButton) {
        closePostModal();

        const modalId = `repost-menu-${post.id}`;
        if (document.getElementById(modalId)) return;

        const menu = document.createElement('div');
        menu.id = modalId;
        menu.className = 'post-menu is-visible';

        const simpleRepostBtn = document.createElement('button');
        simpleRepostBtn.textContent = 'リポスト';
        simpleRepostBtn.onclick = (e) => {
            e.stopPropagation();
            handleSimpleRepost(post.id);
            menu.remove();
        };

        const quotePostBtn = document.createElement('button');
        quotePostBtn.textContent = '引用ポスト';
        quotePostBtn.onclick = (e) => {
            e.stopPropagation();
            setQuotingPost(post);
            openPostModal();
            menu.remove();
        };

        menu.appendChild(simpleRepostBtn);
        menu.appendChild(quotePostBtn);

        const button = triggerButton;
        if (button) {
            document.body.appendChild(menu);
            const btnRect = button.getBoundingClientRect();
            menu.style.position = 'absolute';
            menu.style.top = `${window.scrollY + btnRect.top - menu.offsetHeight}px`;
            menu.style.left = `${window.scrollX + btnRect.left}px`;
            menu.style.right = 'auto';
        }

        setTimeout(() => {
            document.addEventListener('click', () => menu.remove(), {
                once: true,
            });
        }, 0);
    }

    async function handleSimpleRepost(postId) {
        if (!getCurrentUser()) return showAppAlert('ログインが必要です。');
        showLoading(true);
        try {
            const { data: originalPost, error: fetchError } = await api
                .from('post')
                .select('userid')
                .eq('id', postId)
                .single();

            if (fetchError) throw fetchError;

            const { error: rpcError } = await api.rpc('create_post_new', {
                p_content: null,
                p_reply_id: null,
                p_repost_to: postId,
                p_attachments: null,
                p_mask: false,
            });

            if (rpcError) {
                // SQL関数からのエラーメッセージ（連投制限など）をユーザーに表示
                throw rpcError;
            }

            await sendNotification(originalPost.userid, 'repost', {
                kind: 'post',
                id: postId,
            });

            invalidateTimelinePageCache();
            router(); // タイムラインを更新
        } catch (e) {
            console.error(e);
            const friendlyMessage = e.message.replace(/^Error: /, '');
            showAppAlert(`リポストに失敗しました: ${friendlyMessage}`);
        } finally {
            showLoading(false);
        }
    }

    function createPostFormHTML(isModal) {
        return `
	            <div class="post-form">
	                <img src="${getUserIconUrl(getCurrentUser())}" class="user-icon" alt="your icon">
	                ${isModal ? '<button class="modal-close-btn">×</button>' : ''}
	                <div class="form-content">
	                    <div id="reply-info" class="hidden" style="margin-bottom: 0.5rem; color: var(--secondary-text-color);"></div>
                            <div class="markdown-textarea-editor post-content-editor"><textarea id="post-content" class="markdown-content-editor" rows="3" maxlength="280" spellcheck="true" data-markdown-content-editor placeholder="いまどうしてる？"></textarea><div class="markdown-editor-paint" aria-hidden="true"><div class="markdown-editor-placeholder"></div><div class="markdown-editor-preview hidden"></div><div class="markdown-editor-selection"></div><div class="markdown-editor-composition"></div><div class="markdown-editor-caret"></div></div></div>
                            <div class="file-preview-container"></div>
	                    <div class="post-form-actions">
	                        <button type="button" class="attachment-button float-left" title="ファイルを添付">
	                            ${ICONS.attachment}
	                        </button>
	                        <button type="button" class="emoji-pic-button float-left" title="絵文字を選択">
	                            ${ICONS.emoji}
	                        </button>
	                        <input type="file" id="file-input" class="hidden" multiple>
	                        <div id="emoji-picker" class="hidden"></div>
	                        <button id="post-submit-button" class="float-right">ポスト</button>
	                        <button type="button" class="post-mask-button float-right" title="ワンクッション">
	                            ${ICONS.mask}
	                        </button>
	                        <button type="button" class="post-lock-button float-right" title="プライベート" aria-pressed="false">
	                            ${ICONS.lock}
	                        </button>
	                        ${
                                getCurrentUser()?.admin
                                    ? `<button type="button" class="post-announcement-button float-right" title="アナウンス" aria-pressed="false">
	                            ${ICONS.megaphone}
	                        </button>`
                                    : ''
                            }
	                        <span class="float-clear"></span>
	                    </div>
	                </div>
	            </div>`;
    }
    async function attachPostFormListeners(container) {
        await emoji_picker_create(container);

        container
            .querySelector('.attachment-button')
            .addEventListener('click', () => {
                container.querySelector('#file-input').click();
            });
        container
            .querySelector('#file-input')
            .addEventListener('change', (e) =>
                handleFileSelection(e, container),
            );
        container
            .querySelector('.post-mask-button')
            .addEventListener('click', () => handlePostMask(container));
        container
            .querySelector('.post-lock-button')
            .addEventListener('click', () => handlePostLock(container));
        const announcementButton = container.querySelector(
            '.post-announcement-button',
        );
        if (announcementButton) {
            announcementButton.addEventListener('click', () =>
                handlePostAnnouncement(container),
            );
        }
        container
            .querySelector('#post-submit-button')
            .addEventListener('click', () => handlePostSubmit(container));
        const editor = container.querySelector('#post-content');
        editor.addEventListener('keydown', handleCtrlEnter);
        editor.addEventListener('paste', (event) => {
            const imageFiles = Array.from(event.clipboardData?.items || [])
                .filter(
                    (item) =>
                        item.kind === 'file' && item.type.startsWith('image/'),
                )
                .map((item, index) => {
                    const file = item.getAsFile();
                    if (!file) return null;
                    if (file.name) return file;
                    const extension =
                        item.type.split('/')[1]?.replace(/[^a-z0-9]/gi, '') ||
                        'png';
                    return new File(
                        [file],
                        `pasted-image-${Date.now()}-${index}.${extension}`,
                        { type: item.type },
                    );
                })
                .filter(Boolean);

            // 画像はここではアップロードせず、通常の添付選択と同じリストに追加する。
            // 実際のアップロードは投稿送信時のhandlePostSubmitで行われる。
            if (imageFiles.length > 0) {
                void handleFileSelection(
                    { target: { files: imageFiles } },
                    container,
                    { append: true },
                );
            }
        });
        attachMarkdownContentEditor(editor);
    }

    async function compressImage(file) {
        return new Promise((resolve, reject) => {
            if (!file.type.startsWith('image/')) {
                resolve(file);
                return;
            }

            const reader = new FileReader();
            reader.onload = (e) => {
                const img = new Image();
                img.onload = () => {
                    const MAX_WIDTH = 1920;
                    const MAX_HEIGHT = 1920;
                    const JPEG_QUALITY = 0.85; // 品質 (85)

                    let { width, height } = img;

                    if (width > MAX_WIDTH || height > MAX_HEIGHT) {
                        const ratio = Math.min(
                            MAX_WIDTH / width,
                            MAX_HEIGHT / height,
                        );
                        width = Math.round(width * ratio);
                        height = Math.round(height * ratio);
                    }

                    const canvas = document.createElement('canvas');
                    canvas.width = width;
                    canvas.height = height;
                    const ctx = canvas.getContext('2d');

                    ctx.imageSmoothingEnabled = true;
                    ctx.imageSmoothingQuality = 'high';

                    ctx.drawImage(img, 0, 0, width, height);

                    // PNG/WebPで透明度がある場合はそのまま、それ以外はJPEGに変換
                    let outputType = 'image/jpeg';
                    let quality = JPEG_QUALITY;

                    if (
                        file.type === 'image/png' ||
                        file.type === 'image/webp'
                    ) {
                        const imageData = ctx.getImageData(0, 0, width, height);
                        const hasTransparency = imageData.data.some(
                            (_, i) => i % 4 === 3 && imageData.data[i] < 255,
                        );

                        if (hasTransparency) {
                            outputType = 'image/png';
                            quality = 0.9; // PNGのみ品質を90にする
                        }
                    }

                    canvas.toBlob(
                        (blob) => {
                            if (!blob) {
                                reject(new Error('画像の圧縮に失敗しました'));
                                return;
                            }

                            // 圧縮後のファイルサイズが元より大きい場合は元のファイルを使用
                            if (blob.size >= file.size) {
                                resolve(file);
                                return;
                            }

                            const extension =
                                outputType === 'image/jpeg' ? '.jpg' : '.png';
                            const originalName = file.name.replace(
                                /\.[^/.]+$/,
                                '',
                            );
                            const compressedFile = new File(
                                [blob],
                                originalName + extension,
                                {
                                    type: outputType,
                                    lastModified: Date.now(),
                                },
                            );

                            resolve(compressedFile);
                        },
                        outputType,
                        quality,
                    );
                };

                img.onerror = () =>
                    reject(new Error('画像の読み込みに失敗しました'));
                img.src = e.target.result;
            };

            reader.onerror = () =>
                reject(new Error('ファイルの読み込みに失敗しました'));
            reader.readAsDataURL(file);
        });
    }

    async function handleFileSelection(
        event,
        container,
        { append = false } = {},
    ) {
        const previewContainer = container.querySelector(
            '.file-preview-container',
        );

        previewContainer.innerHTML =
            '<div class="spinner" style="margin: 1rem;"></div>'; // 処理中表示

        const files = Array.from(event.target.files);
        const compressedFiles = [];

        for (const file of files) {
            try {
                const compressed = await compressImage(file);
                compressedFiles.push(compressed);
            } catch (error) {
                console.error('ファイル処理エラー:', error);
                compressedFiles.push(file); // エラー時は元ファイルを使用する
            }
        }

        setSelectedFiles(
            append
                ? [...getSelectedFiles(), ...compressedFiles]
                : compressedFiles,
        );

        // 圧縮後のファイル一覧をhidden inputにも反映し、通常のファイル添付と同じ状態に保つ。
        const fileInput = container.querySelector('#file-input');
        if (fileInput && typeof DataTransfer !== 'undefined') {
            const selectedFileList = new DataTransfer();
            getSelectedFiles().forEach((file) =>
                selectedFileList.items.add(file),
            );
            fileInput.files = selectedFileList.files;
        }

        previewContainer.innerHTML = '';

        getSelectedFiles().forEach((file, index) => {
            const previewItem = document.createElement('div');
            previewItem.className = 'file-preview-item';

            if (file.type.startsWith('image/')) {
                const reader = new FileReader();
                reader.onload = (e) => {
                    previewItem.innerHTML = `<img src="${e.target.result}" alt="${escapeHTML(file.name)}"><button class="file-preview-remove" data-index="${index}">×</button>`;
                    previewContainer.appendChild(previewItem);
                };
                reader.readAsDataURL(file);
            } else if (file.type.startsWith('video/')) {
                const reader = new FileReader();
                reader.onload = (e) => {
                    previewItem.innerHTML = `<video src="${e.target.result}" controls></video><button class="file-preview-remove" data-index="${index}">×</button>`;
                    previewContainer.appendChild(previewItem);
                };
                reader.readAsDataURL(file);
            } else if (file.type.startsWith('audio/')) {
                previewItem.innerHTML = `<span>${getEmoji('🎵')} ${getEmoji(escapeHTML(file.name))}</span><button class="file-preview-remove" data-index="${index}">×</button>`;
                previewContainer.appendChild(previewItem);
            } else {
                previewItem.innerHTML = `<span>${getEmoji('📄')} ${getEmoji(escapeHTML(file.name))}</span><button class="file-preview-remove" data-index="${index}">×</button>`;
                previewContainer.appendChild(previewItem);
            }
        });

        previewContainer.addEventListener('click', (e) => {
            if (e.target.classList.contains('file-preview-remove')) {
                const indexToRemove = parseInt(e.target.dataset.index);
                getSelectedFiles().splice(indexToRemove, 1);
                handleFileSelection(
                    { target: { files: new DataTransfer().files } },
                    container,
                );
                const newFiles = new DataTransfer();
                getSelectedFiles().forEach((file) => newFiles.items.add(file));
                container.querySelector('#file-input').files = newFiles.files;
            }
        });
    }

    function handlePostMask(container) {
        const button = container.querySelector('.post-mask-button');
        button.classList.toggle('active');
    }

    function handlePostLock(container) {
        const button = container.querySelector('.post-lock-button');
        button.classList.toggle('active');
        button.setAttribute(
            'aria-pressed',
            String(button.classList.contains('active')),
        );
    }

    function handlePostAnnouncement(container) {
        const button = container.querySelector('.post-announcement-button');
        if (!button) return;
        button.classList.toggle('active');
        button.setAttribute(
            'aria-pressed',
            String(button.classList.contains('active')),
        );
    }

    async function handlePostSubmit(container) {
        if (!getCurrentUser()) return showAppAlert('ログインが必要です。');
        const contentEl = container.querySelector('#post-content');
        const content = getMarkdownEditorValue(contentEl).trim();
        if (!content && getSelectedFiles().length === 0 && !getQuotingPost())
            return showAppAlert(
                '内容を入力するか、ファイルを添付してください。',
            );

        const maskActive = container
            .querySelector('.post-mask-button')
            .classList.contains('active');
        const lockActive = container
            .querySelector('.post-lock-button')
            .classList.contains('active');
        const announcementActive =
            container
                .querySelector('.post-announcement-button')
                ?.classList.contains('active') || false;

        const button = container.querySelector('#post-submit-button');
        button.disabled = true;
        button.textContent = '送信中...';
        showLoading(true);

        let attachmentsData = [];
        let uploadedFileIds = []; // 削除用にファイルIDを保持

        try {
            for (const file of getSelectedFiles()) {
                const fileId = await uploadFileViaEdgeFunction(file);
                uploadedFileIds.push(fileId); // 削除候補としてIDを保存
                const fileType = file.type.startsWith('image/')
                    ? 'image'
                    : file.type.startsWith('video/')
                      ? 'video'
                      : file.type.startsWith('audio/')
                        ? 'audio'
                        : 'file';
                attachmentsData.push({
                    type: fileType,
                    id: fileId,
                    name: file.name,
                });
            }

            const { data: newPost, error: rpcError } = await api
                .rpc('create_post_new', {
                    p_content: content,
                    p_reply_id: getReplyingTo()?.id || null,
                    p_repost_to: getQuotingPost()?.id || null,
                    p_attachments:
                        attachmentsData.length > 0 ? attachmentsData : null,
                    p_mask: maskActive,
                    p_lock: lockActive,
                    p_announcement: announcementActive,
                })
                .single(); // .single()を追加して、返り値が1行であることを期待

            if (rpcError) {
                throw rpcError; // catchブロックに処理を移譲
            }

            let repliedUserId = null;
            if (getReplyingTo()) {
                const { data: parentPost } = await api
                    .from('post')
                    .select('userid')
                    .eq('id', getReplyingTo().id)
                    .single();
                if (parentPost && parentPost.userid !== getCurrentUser().id) {
                    repliedUserId = parentPost.userid;
                    // 返信通知は投稿APIがサーバー側で構造化通知として生成する。
                }
            }
            if (getQuotingPost()) {
                repliedUserId = getQuotingPost().userid; // メンション通知の重複送信を避ける。
                // 引用通知は投稿APIがサーバー側で構造化通知として生成する。
            }
            const mentionedIds = new Set();
            for (const match of content.matchAll(/@(\d+)/g)) {
                const mentionedId = parseInt(match[1]);
                if (
                    mentionedId !== getCurrentUser().id &&
                    mentionedId !== repliedUserId
                ) {
                    mentionedIds.add(mentionedId);
                }
            }
            mentionedIds.forEach((id) => {
                void sendNotification(id, 'mention', {
                    kind: 'post',
                    id: newPost.id,
                });
            });

            const replyTargetId = getReplyingTo()?.id || null;
            invalidateTimelinePageCache();
            setSelectedFiles([]);
            setMarkdownEditorValue(contentEl, '');
            container.querySelector('.file-preview-container').innerHTML = '';
            if (container.closest('.modal-overlay')) {
                closePostModal();
            }

            if (replyTargetId) {
                const detailHash = `#post/${replyTargetId}`;
                if (window.location.hash !== detailHash)
                    window.location.hash = detailHash;
                await router();
            } else if (
                window.location.hash === '#' ||
                window.location.hash === ''
            ) {
                await router();
            }
        } catch (e) {
            console.error('ポスト送信に失敗しました:', e);
            if (uploadedFileIds.length > 0) {
                console.warn(
                    '投稿に失敗したため、アップロード済みファイルを削除します:',
                    uploadedFileIds,
                );
                await deleteFilesViaEdgeFunction(uploadedFileIds);
            }
            showAppAlert(`投稿に失敗しました: ${e.message}`);
        } finally {
            button.disabled = false;
            button.textContent = 'ポスト';
            showLoading(false);
        }
    }

    function imageDataUrlToFile(dataUrl) {
        const match =
            /^data:(image\/(?:jpeg|png|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/i.exec(
                String(dataUrl || ''),
            );
        if (!match) {
            throw new Error('アイコン画像の形式が正しくありません。');
        }

        const mimeType = match[1].toLowerCase();
        const binary = atob(match[2]);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
            bytes[index] = binary.charCodeAt(index);
        }

        const extension = {
            'image/jpeg': 'jpg',
            'image/png': 'png',
            'image/gif': 'gif',
            'image/webp': 'webp',
        }[mimeType];
        return new File([bytes], `icon.${extension}`, { type: mimeType });
    }

    async function uploadFileViaEdgeFunction(file) {
        const base64 = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(',')[1]);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(file);
        });
        const { data, error } = await apiRequest('/server/api/posts/uploads', {
            method: 'POST',
            body: { file: base64, fileName: file.name, contentType: file.type },
        });

        if (error) {
            throw new Error(
                `ファイルアップロードに失敗しました: ${error.message}`,
            );
        }

        // Edge Functionからの戻り値はdataの中にさらにdataプロパティがある場合がある
        const responseData = data.data || data;
        if (responseData.error) {
            throw new Error(
                `ファイルアップロードに失敗しました: ${responseData.error}`,
            );
        }

        return responseData.id;
    }

    async function deleteFilesViaEdgeFunction(fileIds) {
        if (!fileIds || fileIds.length === 0) return;

        const { error } = await apiRequest('/server/api/posts/uploads', {
            method: 'DELETE',
            body: { fileIds },
        });

        if (error) {
            console.error('ファイルの削除に失敗しました:', error.message);
            // ここではエラーをthrowせず、コンソールに出力するに留める
        }
    }

    window.openImageModal = (src) => {
        const safeUrl = getSafeHttpUrl(src);
        if (!safeUrl) return;
        DOM.imagePreviewModalContent.src = safeUrl;
        DOM.imagePreviewModal.classList.remove('hidden');
    };
    window.closeImageModal = () => {
        DOM.imagePreviewModal.classList.add('hidden');
        DOM.imagePreviewModalContent.src = '';
    };

    window.handleDownload = async (fileUrl, fileName) => {
        const safeUrl = getSafeHttpUrl(fileUrl);
        if (!safeUrl) {
            console.warn('[attachments] Unsafe download URL was rejected.');
            return;
        }
        try {
            const response = await fetch(safeUrl, {
                credentials: 'same-origin',
            });
            if (!response.ok) throw new Error('ファイルの取得に失敗しました。');
            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.style.display = 'none';
            a.href = url;
            a.download = fileName;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => window.URL.revokeObjectURL(url), 1000);
        } catch (e) {
            console.error('ダウンロードエラー:', e);
            showAppAlert('ファイルのダウンロードに失敗しました。');
        }
    };

    async function renderPost(post, author, options = {}) {
        if (!post || filterBlockedPosts([post]).length === 0) return null;
        await ensureMentionedUsersCached([post.content]);
        const {
            isNested = false,
            isDirectReply = false,
            userCache = new Map(),
            metricsPromise,
            isPinned = false,
            clampHeight = false,
        } = options;

        const displayAuthor = author || post.author;
        if (!displayAuthor) return null;

        const isSimpleRepost = post.repost_to && !post.content;

        if (isSimpleRepost) {
            const authorOfRepost = displayAuthor;
            const originalPost = post.reposted_post;

            if (!originalPost) {
                const deletedPostWrapper = document.createElement('div');
                deletedPostWrapper.className = 'post';
                deletedPostWrapper.dataset.postId = post.id;

                const deletedPostMain = document.createElement('div');
                deletedPostMain.className = 'post-main';

                const repostIndicator = document.createElement('div');
                repostIndicator.className = 'repost-indicator';
                repostIndicator.innerHTML = `${ICONS.repost}`; // 安全な内部SVGなのでinnerHTML
                const repostAuthorLink = document.createElement('a');
                repostAuthorLink.href = `#profile/${authorOfRepost.id}`;
                repostAuthorLink.textContent = authorOfRepost.name; // 安全なtextContent
                repostAuthorLink.innerHTML = getEmoji(
                    repostAuthorLink.innerHTML,
                ); // Emoji Oneの変換
                const repostText = document.createElement('span');
                repostText.textContent = ` さんがリポストしました`;
                repostIndicator.appendChild(repostAuthorLink);
                repostIndicator.appendChild(repostText);
                deletedPostMain.appendChild(repostIndicator);

                const deletedContainer = document.createElement('div');
                deletedContainer.className = 'deleted-post-container';
                deletedContainer.textContent = 'このポストは削除されました。'; // 安全なtextContent
                deletedPostMain.appendChild(deletedContainer);

                deletedPostWrapper.appendChild(deletedPostMain);
                return deletedPostWrapper;
            }

            const postEl = await renderPost(originalPost, originalPost.author, {
                ...options,
                isNested: false,
                metricsPromise,
            });
            if (!postEl) return null;

            postEl.dataset.postId = post.id;
            postEl.dataset.actionTargetId = originalPost.id;

            const repostedPostMain = postEl.querySelector('.post-main');
            if (repostedPostMain) {
                const repostIndicator = document.createElement('div');
                repostIndicator.className = 'repost-indicator';
                repostIndicator.innerHTML = `${ICONS.repost}`;
                const repostAuthorLink = document.createElement('a');
                repostAuthorLink.href = `#profile/${authorOfRepost.id}`;
                repostAuthorLink.textContent = authorOfRepost.name;
                repostAuthorLink.innerHTML = getEmoji(
                    repostAuthorLink.innerHTML,
                ); // Emoji Oneの変換
                const repostText = document.createElement('span');
                repostText.textContent = ` さんがリポストしました`;
                repostIndicator.appendChild(repostAuthorLink);
                repostIndicator.appendChild(repostText);
                repostedPostMain.prepend(repostIndicator);

                const postHeader =
                    repostedPostMain.querySelector('.post-header');
                if (postHeader) {
                    postHeader.querySelector('.post-menu-btn')?.remove();
                    postHeader.querySelector('.post-menu')?.remove();

                    if (
                        getCurrentUser() &&
                        !isNested &&
                        (getCurrentUser().id === post.userid ||
                            getCurrentUser().admin)
                    ) {
                        const menuBtn = document.createElement('button');
                        menuBtn.type = 'button';
                        menuBtn.className = 'post-menu-btn';
                        menuBtn.title = 'ポストメニュー';
                        menuBtn.setAttribute('aria-label', 'ポストメニュー');
                        menuBtn.innerHTML = ICONS.more;
                        const menu = document.createElement('div');
                        menu.className = 'post-menu';
                        const deleteBtn = document.createElement('button');
                        deleteBtn.className = 'delete-btn';
                        deleteBtn.textContent = 'リポストを削除';
                        menu.appendChild(deleteBtn);
                        postHeader.appendChild(menuBtn);
                        postHeader.appendChild(menu);
                    }
                }
            }
            return postEl;
        }

        if (!author) return null;

        const postEl = document.createElement('div');
        postEl.className = 'post';
        postEl.dataset.postId = post.id;
        postEl.dataset.actionTargetId = post.id;

        const userIconLink = document.createElement('a');
        userIconLink.href = `#profile/${displayAuthor.id}`;
        userIconLink.className = 'user-icon-link';
        const userIcon = document.createElement('img');
        userIcon.src = getUserIconUrl(displayAuthor);
        userIcon.className = 'user-icon';
        userIcon.alt = `${displayAuthor.name}'s icon`;
        userIconLink.appendChild(userIcon);
        postEl.appendChild(userIconLink);

        const postMain = document.createElement('div');
        postMain.className = 'post-main';

        if (isPinned) {
            const pinnedDiv = document.createElement('div');
            pinnedDiv.className = 'pinned-indicator';
            pinnedDiv.innerHTML = `${ICONS.pin} <span>ピン留めされたポスト</span>`;
            postMain.appendChild(pinnedDiv);
        } else if (!isDirectReply) {
            if (post.reply_to_post && post.reply_to_post.author) {
                const replyDiv = document.createElement('div');
                replyDiv.className = 'replying-to';
                const replyAuthorLink = document.createElement('a');
                replyAuthorLink.href = `#profile/${post.reply_to_post.author.id}`;
                replyAuthorLink.textContent = `@${post.reply_to_post.author.name}`;
                replyAuthorLink.innerHTML = getEmoji(replyAuthorLink.innerHTML); // Emoji Oneの変換
                const replyText = document.createElement('span');
                replyText.textContent = ` さんに返信`;
                replyDiv.appendChild(replyAuthorLink);
                replyDiv.appendChild(replyText);
                postMain.appendChild(replyDiv);
            } else if (post.reply_to_user_id && post.reply_to_user_name) {
                const replyDiv = document.createElement('div');
                replyDiv.className = 'replying-to';
                const replyAuthorLink = document.createElement('a');
                replyAuthorLink.href = `#profile/${post.reply_to_user_id}`;
                replyAuthorLink.textContent = `@${post.reply_to_user_name}`;
                replyAuthorLink.innerHTML = getEmoji(replyAuthorLink.innerHTML); // Emoji Oneの変換
                const replyText = document.createElement('span');
                replyText.textContent = ` さんに返信`;
                replyDiv.appendChild(replyAuthorLink);
                replyDiv.appendChild(replyText);
                postMain.appendChild(replyDiv);
            }
        }

        const postHeader = document.createElement('div');
        postHeader.className = 'post-header';
        const authorLink = document.createElement('a');
        authorLink.href = `#profile/${displayAuthor.id}`;
        authorLink.className = 'post-author';
        authorLink.textContent = displayAuthor.name || '不明'; // 安全なtextContent
        authorLink.innerHTML = getEmoji(authorLink.innerHTML);
        postHeader.appendChild(authorLink);

        if (displayAuthor.admin) {
            const adminBadge = document.createElement('img');
            adminBadge.src = 'icons/admin.png';
            adminBadge.className = 'admin-badge';
            adminBadge.title = 'NyaitterTeam';
            authorLink.appendChild(adminBadge);
        } else if ((await contributors).includes(displayAuthor.id)) {
            const contributorBadge = document.createElement('img');
            contributorBadge.src = 'icons/contributor.png';
            contributorBadge.className = 'contributor-badge';
            contributorBadge.title = '開発協力者';
            authorLink.appendChild(contributorBadge);
        } else if (displayAuthor.verify) {
            const verifyBadge = document.createElement('img');
            verifyBadge.src = 'icons/verify.png';
            verifyBadge.className = 'verify-badge';
            verifyBadge.title = '認証済み';
            authorLink.appendChild(verifyBadge);
        }

        const postTime = document.createElement('span');
        postTime.className = 'post-time';
        postTime.textContent = `${getNyaitterId(displayAuthor)} · ${formatPostTimestamp(post)}`;
        postHeader.appendChild(postTime);
        if (post.private || post.lock) {
            const lockIndicator = document.createElement('span');
            lockIndicator.className = 'post-lock-indicator';
            lockIndicator.title = 'プライベート';
            lockIndicator.setAttribute('aria-label', 'プライベート');
            lockIndicator.innerHTML = ICONS.lock;
            postHeader.appendChild(lockIndicator);
        }

        if (getCurrentUser()) {
            const menuBtn = document.createElement('button');
            menuBtn.type = 'button';
            menuBtn.className = 'post-menu-btn';
            menuBtn.title = 'ポストメニュー';
            menuBtn.setAttribute('aria-label', 'ポストメニュー');
            menuBtn.innerHTML = ICONS.more;
            const menu = document.createElement('div');
            menu.className = 'post-menu';

            const shareBtn = document.createElement('button');
            shareBtn.className = 'share-btn';
            shareBtn.textContent = 'URLをコピー';
            menu.appendChild(shareBtn);

            if (Number(getCurrentUser().id) !== Number(post.userid)) {
                const reportBtn = document.createElement('button');
                reportBtn.className = 'report-btn';
                reportBtn.textContent = '報告する';
                reportBtn.onclick = (event) => {
                    event.stopPropagation();
                    openReportModal({
                        targetKind: 'post',
                        targetId: post.id,
                        targetLabel: 'このポスト',
                    });
                    menu.classList.remove('is-visible');
                };
                menu.appendChild(reportBtn);
            }

            if (getCurrentUser().id === post.userid || getCurrentUser().admin) {
                const pinBtn = document.createElement('button');
                pinBtn.className = 'pin-btn';
                if (!getCurrentUser().pin || getCurrentUser().pin !== post.id) {
                    pinBtn.textContent = 'ピン留め';
                } else {
                    pinBtn.textContent = 'ピン留めを解除';
                }
                menu.appendChild(pinBtn);

                if (!post.repost_to || post.content) {
                    const editBtn = document.createElement('button');
                    editBtn.className = 'edit-btn';
                    editBtn.textContent = '編集';
                    menu.appendChild(editBtn);
                }

                const deleteBtn = document.createElement('button');
                deleteBtn.className = 'delete-btn';
                deleteBtn.textContent = '削除';
                menu.appendChild(deleteBtn);
            }

            postHeader.appendChild(menuBtn);
            postHeader.appendChild(menu);
        }
        postMain.appendChild(postHeader);

        if (post.content) {
            const postContent = document.createElement('div');
            postContent.className = 'post-content';

            // maskが有効の場合contentをhidden化&頭に!があればそれだけ表示
            if (post.mask) {
                postContent.classList.add('hidden');
                if (post.content.startsWith('!')) {
                    const masktitle = document.createElement('div');
                    masktitle.className = 'post-content post-mask-title';
                    masktitle.innerHTML = formatPostContent(
                        post.content.split('\n')[0].slice(1),
                        userCache,
                        { allowMarkdown: true },
                    );
                    postMain.appendChild(masktitle);
                    postContent.innerHTML = formatPostContent(
                        post.content.slice(1),
                        userCache,
                        { allowMarkdown: true },
                    );
                } else {
                    postContent.innerHTML = formatPostContent(
                        post.content,
                        userCache,
                        { allowMarkdown: true },
                    );
                }
            } else {
                postContent.innerHTML = formatPostContent(
                    post.content,
                    userCache,
                    { allowMarkdown: true },
                );
            }
            postMain.appendChild(postContent);
        }

        // maskが有効の場合表示ボタンを追加
        if (post.mask) {
            const postAlert = document.createElement('button');
            postAlert.className = 'post-mask-alert';
            postAlert.innerText =
                'このポストにはワンクッションが付与されています';
            postMain.appendChild(postAlert);
        }

        if (post.attachments && post.attachments.length > 0) {
            const attachmentsContainer = document.createElement('div');
            attachmentsContainer.className = 'attachments-container';
            // maskが有効の場合attachmentsもhidden化
            if (post.mask) {
                attachmentsContainer.classList.add('hidden');
            } else if (post.attachments.length > 2) {
                const postAlert = document.createElement('button');
                postAlert.className = 'post-mask-alert';
                postAlert.innerText = `${post.attachments.length}件のファイル`;
                postMain.appendChild(postAlert);
                attachmentsContainer.classList.add('hidden');
            }
            if (isNested) {
                const itemDiv = document.createElement('div');
                itemDiv.className = 'attachment-item';

                const fileinfo = document.createElement('p');
                fileinfo.className = 'attachment-fileinfo';
                fileinfo.textContent = `📄 ${post.attachments.length}件のファイル`;
                itemDiv.appendChild(fileinfo);
                attachmentsContainer.appendChild(itemDiv);
            } else {
                for (const attachment of post.attachments) {
                    const { data: publicUrlData } = api.storage
                        .from('nyaitter')
                        .getPublicUrl(attachment.id);
                    const publicURL = getSafeHttpUrl(publicUrlData?.publicUrl);
                    if (!publicURL) continue;
                    const attachmentName = String(
                        attachment.name || '添付ファイル',
                    ).slice(0, 255);

                    const itemDiv = document.createElement('div');
                    itemDiv.className = 'attachment-item';

                    if (attachment.type === 'image') {
                        const img = document.createElement('img');
                        img.src = publicURL;
                        img.alt = attachmentName;
                        img.className = 'attachment-image';
                        img.onclick = (e) => {
                            e.stopPropagation();
                            window.openImageModal(publicURL);
                        };
                        itemDiv.appendChild(img);
                    } else if (attachment.type === 'video') {
                        const video = document.createElement('video');
                        video.src = publicURL;
                        video.controls = true;
                        video.onclick = (e) => {
                            e.stopPropagation();
                        };
                        itemDiv.appendChild(video);
                    } else if (attachment.type === 'audio') {
                        const audio = document.createElement('audio');
                        audio.src = publicURL;
                        audio.controls = true;
                        audio.onclick = (e) => {
                            e.stopPropagation();
                        };
                        itemDiv.appendChild(audio);
                    } else {
                        const downloadLink = document.createElement('a');
                        downloadLink.href = '#'; // ページ遷移を防ぐ
                        downloadLink.className = 'attachment-download-link';
                        downloadLink.textContent = `📄 ${attachmentName}`;

                        downloadLink.onclick = (e) => {
                            e.preventDefault(); // href="#"のデフォルトの動作（ページトップへ移動）を防ぐ
                            e.stopPropagation(); // 親要素へのイベント伝播を防ぐ
                            window.handleDownload(publicURL, attachmentName); // 正しいファイル名でダウンロードを開始
                        };
                        itemDiv.appendChild(downloadLink);
                    }
                    attachmentsContainer.appendChild(itemDiv);
                }
            }
            postMain.appendChild(attachmentsContainer);
        }

        if (post.repost_to && post.content) {
            const nestedContainer = document.createElement('div');
            nestedContainer.className = 'nested-repost-container';
            if (post.reposted_post) {
                const nestedPostEl = await renderPost(
                    post.reposted_post,
                    post.reposted_post.author,
                    { ...options, isNested: true },
                );
                if (nestedPostEl) {
                    nestedContainer.appendChild(nestedPostEl);
                }
            } else {
                const deletedContainer = document.createElement('div');
                deletedContainer.className = 'deleted-post-container';
                deletedContainer.textContent = 'このポストは削除されました。';
                nestedContainer.appendChild(deletedContainer);
            }
            postMain.appendChild(nestedContainer);
        }

        if (getCurrentUser() && !isNested) {
            const actionsDiv = document.createElement('div');
            actionsDiv.className = 'post-actions';

            // アクションボタンのステータス表示は、常に表示されているポストの内容(post)に依存する
            // シンプルリポストの場合、その中身(post.reposted_post)にカウントが設定されている
            const actionTargetPost =
                isSimpleRepost && post.reposted_post
                    ? post.reposted_post
                    : post;

            if (actionTargetPost) {
                const replyBtn = document.createElement('button');
                replyBtn.className = 'reply-button';
                replyBtn.dataset.username = escapeHTML(
                    actionTargetPost.user?.name || author.name,
                );
                replyBtn.innerHTML = `${ICONS.reply} <span>---</span>`;
                actionsDiv.appendChild(replyBtn);

                const likeBtn = document.createElement('button');
                likeBtn.className = `like-button ${getCurrentUser().like?.includes(actionTargetPost.id) ? 'liked' : ''}`;
                likeBtn.innerHTML = `${ICONS.likes} <span>---</span>`;
                actionsDiv.appendChild(likeBtn);

                const starBtn = document.createElement('button');
                starBtn.className = `star-button ${getCurrentUser().star?.includes(actionTargetPost.id) ? 'starred' : ''}`;
                starBtn.innerHTML = `${ICONS.stars} <span>---</span>`;
                actionsDiv.appendChild(starBtn);

                const repostBtn = document.createElement('button');
                repostBtn.className = 'repost-button';
                repostBtn.innerHTML = `${ICONS.repost} <span>---</span>`;
                actionsDiv.appendChild(repostBtn);

                (async () => {
                    await metricsPromise;

                    const replyCount =
                        actionTargetPost.reply_count ?? METRICS_FALLBACK;
                    const likeCount =
                        actionTargetPost.like_count ?? METRICS_FALLBACK;
                    const starCount =
                        actionTargetPost.star_count ?? METRICS_FALLBACK;
                    const repostCount =
                        actionTargetPost.repost_count ?? METRICS_FALLBACK;

                    replyBtn.innerHTML = `${ICONS.reply} <span>${replyCount}</span>`;
                    likeBtn.innerHTML = `${ICONS.likes} <span>${likeCount}</span>`;
                    starBtn.innerHTML = `${ICONS.stars} <span>${starCount}</span>`;
                    repostBtn.innerHTML = `${ICONS.repost} <span>${repostCount}</span>`;
                })();
            }

            postMain.appendChild(actionsDiv);
        }

        postEl.appendChild(postMain);

        // タイムラインの長いポスト本文は一定の高さに制限し、超える分は隠す。
        // 詳細表示・引用（ネスト）・マスク付きポストには適用しない。
        if (clampHeight && !isNested && !post.mask && post.content) {
            postEl.dataset.clampContent = '1';
            const contentEl = postMain.querySelector('.post-content');
            if (contentEl) {
                const toggleBtn = document.createElement('button');
                toggleBtn.type = 'button';
                toggleBtn.className = 'post-clamp-toggle';
                toggleBtn.textContent = '続きを表示';
                toggleBtn.addEventListener('click', () => {
                    const expanded = contentEl.classList.toggle(
                        'post-content-expanded',
                    );
                    toggleBtn.textContent = expanded ? '閉じる' : '続きを表示';
                    toggleBtn.classList.toggle('expanded', expanded);
                });
                contentEl.after(toggleBtn);

                // クランプを一時解除して本文そのものの実表示高さを測る。
                // 見出しなどの子要素の内部レイアウトではなく、クランプ上限を
                // 超えた本文だけに「続きを表示する」を付ける。
                const measure = () => {
                    if (!postEl.isConnected || !contentEl.isConnected)
                        return null;
                    const wasExpanded = contentEl.classList.contains(
                        'post-content-expanded',
                    );
                    if (!wasExpanded)
                        contentEl.classList.add('post-content-expanded');
                    const naturalHeight =
                        contentEl.getBoundingClientRect().height;
                    if (!wasExpanded)
                        contentEl.classList.remove('post-content-expanded');
                    const clampLimit = Number.parseFloat(
                        window.getComputedStyle(contentEl).maxHeight,
                    );
                    if (
                        Number.isFinite(clampLimit) &&
                        naturalHeight > clampLimit + 1
                    ) {
                        toggleBtn.classList.add('is-visible');
                    }
                    return true;
                };
                let attempts = 0;
                const timer = setInterval(() => {
                    if (measure() === true || ++attempts >= 20)
                        clearInterval(timer);
                }, 50);
            }
        }

        return postEl;
    }

    async function showMainScreen() {
        DOM.pageHeader.innerHTML = `<h2 id="page-title">ホーム</h2>`;
        showScreen('main-screen');
        setupTimelinePullToRefresh();
        updateRealtimeTimelineIndicator();

        const tabsContainer = document.querySelector('.timeline-tabs');
        if (getCurrentUser()) {
            tabsContainer.innerHTML = `
	                <button class="timeline-tab-button" data-tab="all">すべて</button>
	                <button class="timeline-tab-button" data-tab="foryou">おすすめ</button>
	                <button class="timeline-tab-button" data-tab="following">フォロー中</button>
		                <button class="timeline-tab-button" data-tab="announce">お知らせ</button>
		            `;
            // ユーザー設定からデフォルトタブを取得。なければ 'all' を使用
            setCurrentTimelineTab(
                getCurrentUser().settings?.default_timeline_tab || 'all',
            );
        } else {
            tabsContainer.innerHTML = `
	                <button class="timeline-tab-button" data-tab="all">すべて</button>
		                <button class="timeline-tab-button" data-tab="announce">お知らせ</button>
		            `;
            // 未ログインユーザーのデフォルトは「すべて」固定
            setCurrentTimelineTab('all');
        }

        if (getCurrentUser()) {
            DOM.postFormContainer.innerHTML = createPostFormHTML(false);
            attachPostFormListeners(DOM.postFormContainer);
        } else {
            DOM.postFormContainer.innerHTML = '';
        }

        await switchTimelineTab(getCurrentTimelineTab());
        showLoading(false);
    }

    async function showExploreScreen() {
        DOM.pageHeader.innerHTML = `
	            <div class="header-search-bar">
	                ${ICONS.explore}
	                <input type="search" id="search-input" placeholder="検索">
	            </div>`;
        const searchInput = document.getElementById('search-input');
        const performSearch = () => {
            const query = searchInput.value.trim();
            if (query) {
                window.location.hash = `#search/${encodeURIComponent(query)}`;
            }
        };
        searchInput.onkeydown = (e) => {
            if (e.key === 'Enter') performSearch();
        };

        showScreen('explore-screen');
        const contentDiv = DOM.exploreContent;
        contentDiv.innerHTML = '<div class="spinner"></div>'; // ローディング表示

        try {
            // 新しいSQL関数を呼び出してトレンドを取得
            const { data: trends, error } = await api.rpc(
                'get_trending_hashtags',
            );
            if (error) throw error;

            if (trends && trends.length > 0) {
                let trendsHtml = `
	                    <div class="trends-widget-container">
	                        <div class="trends-widget-title">トレンド</div>
	                `;
                trends.forEach((trend, index) => {
                    trendsHtml += `
	                        <a href="#search/${encodeURIComponent(trend.tag_name)}" class="trend-item">
	                            <div class="trend-item-meta">
	                                <span>${index + 1}</span>位
	                            </div>
	                            <div class="trend-item-name">#${escapeHTML(trend.tag_name)}</div>
	                            <div class="trend-item-count">${trend.occurrence_count}件のポスト</div>
	                        </a>
	                    `;
                });
                trendsHtml += `</div>`;
                contentDiv.innerHTML = trendsHtml;
            } else {
                contentDiv.innerHTML =
                    '<p style="padding: 2rem; text-align: center; color: var(--secondary-text-color);">現在、トレンドはありません。</p>';
            }
        } catch (err) {
            console.error('トレンドの取得に失敗:', err);
            contentDiv.innerHTML =
                '<p style="padding: 2rem; text-align: center; color: var(--secondary-text-color);">トレンドの取得に失敗しました。</p>';
        } finally {
            showLoading(false);
        }
    }

    async function showSearchResults(query, tab = 'posts') {
        DOM.pageHeader.innerHTML = `
	            <div class="header-search-bar">
	                ${ICONS.explore}
	                <input type="search" id="search-input" placeholder="検索">
	            </div>
	            <br>
	            <h2 id="page-title">検索結果: "${getEmoji(escapeHTML(query))}"</h2>
	            <div class="search-tabs" id="search-tabs-container">
	                <button class="tab-button ${tab === 'posts' ? 'active' : ''}" data-search-tab="posts">ポスト</button>
	                <button class="tab-button ${tab === 'users' ? 'active' : ''}" data-search-tab="users">ユーザー</button>
	            </div>
	        `;
        const searchInput = document.getElementById('search-input');
        const performSearch = () => {
            const newQuery = searchInput.value.trim();
            if (newQuery) {
                window.location.hash = `#search/${encodeURIComponent(newQuery)}`;
            }
        };
        searchInput.onkeydown = (e) => {
            if (e.key === 'Enter') performSearch();
        };

        document
            .getElementById('search-tabs-container')
            .querySelectorAll('.tab-button')
            .forEach((button) => {
                button.onclick = (e) => {
                    e.stopPropagation();
                    loadSearchTabContent(query, button.dataset.searchTab);
                };
            });

        showScreen('search-results-screen');
        await loadSearchTabContent(query, tab);
    }

    async function loadSearchTabContent(query, tab) {
        const searchRequestVersion = ++activeSearchRequestVersion;
        setCurrentSearchTab(tab);
        document
            .querySelectorAll('#search-tabs-container .tab-button')
            .forEach((btn) =>
                btn.classList.toggle('active', btn.dataset.searchTab === tab),
            );

        setIsLoadingMore(false);
        if (getPostLoadObserver()) getPostLoadObserver().disconnect();

        const contentDiv = DOM.searchResultsContent;
        contentDiv.innerHTML = '';

        if (tab === 'users') {
            const normalizedQuery = String(query || '')
                .normalize('NFKC')
                .trim()
                .replace(/\s+/g, ' ');
            // ORフィルターの区切り文字・ワイルドカードを検索語として解釈させない。
            const filterQuery = normalizedQuery.replace(/[%,()]/g, ' ');
            const filters = [
                `name.ilike.%${filterQuery}%`,
                `nyaitter_id.ilike.%${filterQuery}%`,
                `scid.ilike.%${filterQuery}%`,
                `me.ilike.%${filterQuery}%`,
            ];
            // #1234 と 1234 のどちらでもNyaitter IDを優先して検索する
            const normalizedIdQuery = normalizedQuery.replace(/^#/, '');
            if (/^\d+$/.test(normalizedIdQuery)) {
                filters.unshift(`id.eq.${Number(normalizedIdQuery)}`);
            }

            const userScope = getCurrentUser()?.id ?? 'guest';
            const searchUsersCacheKey = `${userScope}:search:users:${normalizedQuery.toLocaleLowerCase('ja-JP')}`;
            const needle = normalizedQuery.toLocaleLowerCase('ja-JP');
            const scoreUser = (user) => {
                const id = String(user.id || '');
                const values = [user.name, user.scid, user.me]
                    .filter((value) => typeof value === 'string')
                    .map((value) =>
                        value.normalize('NFKC').toLocaleLowerCase('ja-JP'),
                    );
                if (id === normalizedIdQuery) return 0;
                if (values.some((value) => value === needle)) return 1;
                if (values.some((value) => value.startsWith(needle))) return 2;
                return 3;
            };

            await loadUsersWithPagination(contentDiv, 'search', {
                filters: filters.join(','),
                pageSize: 15,
                pageCache: getUserPageCache(searchUsersCacheKey),
                sortResults: (left, right) =>
                    scoreUser(left) - scoreUser(right) ||
                    Number(left.id) - Number(right.id),
                isCurrent: () =>
                    searchRequestVersion === activeSearchRequestVersion &&
                    getCurrentSearchTab() === 'users',
            });
            if (
                searchRequestVersion === activeSearchRequestVersion &&
                getCurrentSearchTab() === 'users'
            )
                showLoading(false);
        } else {
            if (getCurrentUser()) {
                const tagPostButton = document.createElement('button');
                tagPostButton.className = 'tag-post-button';
                tagPostButton.innerHTML = 'このタグでポストする';
                tagPostButton.addEventListener('click', async () => {
                    if (!getCurrentUser()) return goToLoginPage();
                    DOM.postModal.classList.remove('hidden');
                    const modalContainer = DOM.postModal.querySelector(
                        '.post-form-container-modal',
                    );
                    modalContainer.innerHTML =
                        createPostFormHTML(true) +
                        `<div id="quoting-preview-container"></div>`;
                    attachPostFormListeners(modalContainer);
                    modalContainer.querySelector('textarea').textContent =
                        '#' + query;

                    DOM.postModal.querySelector('.modal-close-btn').onclick =
                        closePostModal;
                    modalContainer.querySelector('textarea').focus();
                });
                contentDiv.appendChild(tagPostButton);
            }

            const postResultsContainer = document.createElement('div');
            contentDiv.appendChild(postResultsContainer);
            const userScope = getCurrentUser()?.id ?? 'guest';
            await loadPostsWithPagination(postResultsContainer, 'search', {
                query,
                pageCache: getAuxiliaryPostPageCache(
                    `${userScope}:search:posts:${query}`,
                ),
            });
            showLoading(false);
        }
    }

    async function showNotificationsScreen() {
        if (!getCurrentUser()) {
            DOM.pageHeader.innerHTML = `<h2 id="page-title">通知</h2>`;
            showScreen('notifications-screen');
            DOM.notificationsContent.innerHTML =
                '<p style="padding: 2rem; text-align:center; color: var(--secondary-text-color);">通知を見るにはログインが必要です。</p>';
            showLoading(false);
            return;
        }

        DOM.pageHeader.innerHTML = `
	            <div class="header-with-action-button">
	                <h2 id="page-title">通知</h2>
	                <button id="mark-all-read-btn" class="header-action-btn">すべて既読</button>
	            </div>`;

        showScreen('notifications-screen');
        const contentDiv = DOM.notificationsContent;
        contentDiv.innerHTML = '<div class="spinner"></div>';

        document
            .getElementById('mark-all-read-btn')
            .addEventListener('click', async () => {
                if (!(await showAppConfirm('すべての通知を既読にしますか？')))
                    return;

                showLoading(true);
                try {
                    const { data, error } = await api.rpc(
                        'mark_all_notifications_as_clicked',
                        {
                            p_user_id: getCurrentUser().id,
                        },
                    );
                    if (error) throw error;

                    if (getCurrentUser().notice) {
                        getCurrentUser().notice.forEach((n) => {
                            n.read = true;
                            n.clicked = true;
                        });
                    }
                    getCurrentUser().notification_unread_count = Number(
                        data?.notification_unread_count || 0,
                    );
                    await showNotificationsScreen();
                    await updateNavAndSidebars();
                } catch (e) {
                    console.error('すべて既読処理でエラー:', e);
                    showAppAlert('処理中にエラーが発生しました。');
                } finally {
                    showLoading(false);
                }
            });

        try {
            // 通知一覧を表示した時点で既読化する。clickedは通知を個別に開いた時だけ更新する。
            const { data: readAllOnOpenData, error: readAllOnOpenError } =
                await apiRequest('/server/api/notifications/read-all', {
                    method: 'PUT',
                });
            if (readAllOnOpenError) {
                console.error(
                    '通知一覧表示時の既読化に失敗しました:',
                    readAllOnOpenError,
                );
            } else {
                if (getCurrentUser().notice)
                    getCurrentUser().notice.forEach((notification) => {
                        notification.read = true;
                    });
                getCurrentUser().notification_unread_count = Number(
                    readAllOnOpenData?.notification_unread_count || 0,
                );
                getCurrentUser().nav_summary_fetched_recently = false;
                void updateNavAndSidebars();
            }

            contentDiv.innerHTML = '';
            const { data: notificationPayload, error } = await apiRequest(
                '/server/api/notifications?limit=100',
            );
            if (error) {
                const noticeEl = document.createElement('div');
                const content = document.createElement('div');
                content.className = 'notification-item-content';
                content.textContent =
                    '[エラー] 通知の取得に失敗したため古い通知を表示しています。';
                noticeEl.appendChild(content);
                contentDiv.appendChild(noticeEl);
            } else {
                getCurrentUser().notice = (
                    notificationPayload.notifications || []
                )
                    .map(normalizeStructuredNotification)
                    .filter(Boolean);
                getCurrentUser().notification_unread_count = Number(
                    notificationPayload.notification_unread_count || 0,
                );
                getCurrentUser().nav_summary_fetched_recently = false;
            }

            if (getCurrentUser().notice?.length) {
                getCurrentUser().notice.forEach((n_obj) => {
                    const notification = normalizeStructuredNotification(n_obj);
                    if (!notification) return;

                    const noticeEl = document.createElement('div');
                    noticeEl.className = 'widget-item notification-item';
                    if (!notification.clicked) {
                        noticeEl.classList.add('notification-new');
                    }
                    if (notification.clicked) {
                        noticeEl.classList.add('notification-clicked');
                    }
                    noticeEl.dataset.notificationId = notification.id;
                    noticeEl.dataset.notificationClicked = String(
                        notification.clicked,
                    );

                    const content = document.createElement('div');
                    content.className = 'notification-item-content';
                    appendNotificationDisplay(content, notification);

                    const deleteBtn = document.createElement('button');
                    deleteBtn.className = 'notification-delete-btn';
                    deleteBtn.innerHTML = '×';
                    deleteBtn.title = '通知を削除';

                    noticeEl.appendChild(content);
                    noticeEl.appendChild(deleteBtn);
                    contentDiv.appendChild(noticeEl);
                });
            } else {
                contentDiv.innerHTML =
                    '<p style="padding: 2rem; text-align:center; color: var(--secondary-text-color);">通知はまだありません。</p>';
            }
        } catch (e) {
            console.error('通知画面エラー:', e);
            contentDiv.innerHTML = `<p class="error-message">通知の読み込みに失敗しました。</p>`;
        } finally {
            showLoading(false);
        }
    }

    async function showLikesScreen() {
        DOM.pageHeader.innerHTML = `<h2 id="page-title">いいね</h2>`;
        showScreen('likes-screen');
        DOM.likesContent.innerHTML = '';
        const userScope = getCurrentUser()?.id ?? 'guest';
        await loadPostsWithPagination(DOM.likesContent, 'likes', {
            ids: getCurrentUser().like,
            pageCache: getAuxiliaryPostPageCache(
                `${userScope}:likes:${(getCurrentUser().like || []).join(',')}`,
            ),
        });
        showLoading(false);
    }
    async function showStarsScreen() {
        DOM.pageHeader.innerHTML = `<h2 id="page-title">お気に入り</h2>`;
        showScreen('stars-screen');
        DOM.starsContent.innerHTML = '';
        const userScope = getCurrentUser()?.id ?? 'guest';
        await loadPostsWithPagination(DOM.starsContent, 'stars', {
            ids: getCurrentUser().star,
            pageCache: getAuxiliaryPostPageCache(
                `${userScope}:stars:${(getCurrentUser().star || []).join(',')}`,
            ),
        });
        showLoading(false);
    }

    async function showPostDetail(postId) {
        DOM.pageHeader.innerHTML = `
	            <div class="header-with-back-button">
	                <button class="header-back-btn" data-action="history-back">${ICONS.back}</button>
	                <h2 id="page-title">ポスト</h2>
	            </div>`;
        showScreen('post-detail-screen');
        const contentDiv = DOM.postDetailContent;
        contentDiv.innerHTML = '<div class="spinner"></div>';

        try {
            const { data: threadPayload, error: threadError } =
                await apiRequest(
                    `/server/api/posts/${encodeURIComponent(postId)}/thread`,
                );
            const mainPost = threadPayload?.post || null;
            const allRepliesRaw = Array.isArray(threadPayload?.replies)
                ? threadPayload.replies
                : [];
            if (threadError || !mainPost) {
                throw threadError || new Error('ポストの取得に失敗しました。');
            }

            if (mainPost.repost_to && !mainPost.content) {
                window.location.replace(`#post/${mainPost.repost_to}`);
                return;
            }

            // スレッド応答には投稿・参照投稿のmetricsがすでに含まれる。
            const metricsPromise = Promise.resolve();

            contentDiv.innerHTML = '';

            if (mainPost.reply_to_post) {
                const parentPostEl = await renderPost(
                    mainPost.reply_to_post,
                    mainPost.reply_to_post.author,
                    { userCache: getAllUsersCache(), metricsPromise },
                );
                if (parentPostEl) {
                    const parentContainer = document.createElement('div');
                    parentContainer.className = 'parent-post-container';
                    parentContainer.appendChild(parentPostEl);
                    contentDiv.appendChild(parentContainer);
                }
            }

            const mainPostEl = await renderPost(mainPost, mainPost.author, {
                userCache: getAllUsersCache(),
                metricsPromise,
            });
            if (mainPostEl) contentDiv.appendChild(mainPostEl);

            const repliesHeader = document.createElement('h3');
            repliesHeader.textContent = '返信';
            repliesHeader.style.cssText =
                'padding: 1rem; border-top: 1px solid var(--border-color); border-bottom: 1px solid var(--border-color); margin-top: 1rem; margin-bottom: 0; font-size: 1.2rem;';
            contentDiv.appendChild(repliesHeader);

            const rootPostId = Number(postId);
            const normalizedReplies = allRepliesRaw
                .map((reply) => {
                    const replyId = Number(reply?.id);
                    const parentId = Number(reply?.reply_id ?? reply?.replyTo);
                    if (
                        !Number.isInteger(replyId) ||
                        !Number.isInteger(parentId)
                    )
                        return null;
                    return {
                        ...reply,
                        id: replyId,
                        reply_id: parentId,
                        // 新しいハイドレート済み応答と旧フラット応答の両方を受け入れる。
                        author: reply.author || reply.user || null,
                    };
                })
                .filter(Boolean);
            const repliesByParentId = new Map();
            normalizedReplies.forEach((reply) => {
                const parentId = reply.reply_id;
                if (!repliesByParentId.has(parentId)) {
                    repliesByParentId.set(parentId, []);
                }
                repliesByParentId.get(parentId).push(reply);
            });
            // 各親ID内の返信を時間順にソート
            for (const replies of repliesByParentId.values()) {
                replies.sort((a, b) => {
                    const aTime = new Date(a.created_at).getTime();
                    const bTime = new Date(b.created_at).getTime();
                    return aTime - bTime;
                });
            }

            const repliesById = new Map(
                normalizedReplies.map((reply) => [reply.id, reply]),
            );
            const flatReplyList = [];
            const visitedReplyIds = new Set();
            const buildFlatList = (parentId, depth = 0) => {
                const children = repliesByParentId.get(Number(parentId)) || [];
                for (const child of children) {
                    if (visitedReplyIds.has(child.id)) continue;
                    visitedReplyIds.add(child.id);
                    flatReplyList.push({ ...child, thread_depth: depth });
                    buildFlatList(child.id, depth + 1); // 孫以降は深さを1段ずつ増やす
                }
            };
            buildFlatList(rootPostId); // メインポストを起点にツリーを平坦化

            const repliesContainer = document.createElement('div');
            contentDiv.appendChild(repliesContainer);
            const trigger = document.createElement('div');
            trigger.className = 'load-more-trigger';
            contentDiv.appendChild(trigger);

            let pagination = { page: 0, hasMore: flatReplyList.length > 0 };
            const REPLIES_PER_PAGE = 10;
            let isLoadingReplies = false;

            const loadMoreReplies = async () => {
                if (isLoadingReplies || !pagination.hasMore) return;
                isLoadingReplies = true;
                trigger.innerHTML = '<div class="spinner"></div>';

                const from = pagination.page * REPLIES_PER_PAGE;
                const to = from + REPLIES_PER_PAGE;
                const repliesToRender = flatReplyList.slice(from, to);

                // キャッシュ

                for (const reply of repliesToRender) {
                    const replyDepth = Math.max(
                        0,
                        Number(reply.thread_depth) || 0,
                    );
                    const postForRender = {
                        ...reply,
                    };

                    const authorForRender = reply.author || {
                        id: reply.author_id,
                        name: reply.author_name,
                        scid: reply.author_scid,
                        icon_data: reply.author_icon_data,
                        admin: reply.author_admin,
                        verify: reply.author_verify,
                    };

                    if (replyDepth > 0) {
                        const parentReply = repliesById.get(reply.reply_id);
                        if (!postForRender.reply_to_post && parentReply) {
                            postForRender.reply_to_post = {
                                ...parentReply,
                                author:
                                    parentReply.author ||
                                    parentReply.user ||
                                    null,
                            };
                        }
                        if (
                            !postForRender.reply_to_post &&
                            reply.reply_to_user_id
                        ) {
                            postForRender.reply_to_post = {
                                author: {
                                    id: reply.reply_to_user_id,
                                    name: reply.reply_to_user_name,
                                },
                            };
                        }
                    }

                    const isDirectReply = replyDepth === 0;

                    const postEl = await renderPost(
                        postForRender,
                        authorForRender,
                        {
                            userCache: getAllUsersCache(),
                            isDirectReply,
                            metricsPromise,
                        },
                    );

                    if (postEl) {
                        let replyNode = postEl;
                        if (replyDepth > 0) {
                            // `.post` 自体ではなく外側ラッパーをずらすことで、flexレイアウト下でも
                            // 孫返信の左余白が確実に反映されるようにする。
                            const nestedWrapper = document.createElement('div');
                            nestedWrapper.className = 'thread-nested-reply';
                            nestedWrapper.style.setProperty(
                                '--reply-indent',
                                `${Math.min(replyDepth, 3) * 2}rem`,
                            );
                            nestedWrapper.dataset.replyDepth =
                                String(replyDepth);
                            nestedWrapper.appendChild(postEl);
                            replyNode = nestedWrapper;
                        }
                        repliesContainer.appendChild(replyNode);
                    }
                }

                pagination.page++;
                if (
                    pagination.page * REPLIES_PER_PAGE >=
                    flatReplyList.length
                ) {
                    pagination.hasMore = false;
                }

                if (!pagination.hasMore) {
                    trigger.textContent = repliesContainer.hasChildNodes()
                        ? 'すべての返信を読み込みました'
                        : 'まだ返信はありません。';
                    if (repliesLoadObserver) repliesLoadObserver.disconnect();
                } else {
                    trigger.innerHTML = '';
                }
                isLoadingReplies = false;
            };

            const repliesLoadObserver = new IntersectionObserver(
                (entries) => {
                    if (entries[0].isIntersecting) {
                        loadMoreReplies();
                    }
                },
                { rootMargin: '200px' },
            );

            const savedDetailPosition =
                getSavedScrollPositions()[getScrollRouteKey()];
            const savedDetailY = Number(savedDetailPosition?.y);
            const restoreTargetY =
                Number.isFinite(savedDetailY) && savedDetailY > 0
                    ? savedDetailY
                    : 0;

            if (pagination.hasMore) {
                await loadMoreReplies();
                while (
                    pagination.hasMore &&
                    document.documentElement.scrollHeight <
                        restoreTargetY + window.innerHeight
                ) {
                    await loadMoreReplies();
                }
            } else {
                trigger.textContent = 'まだ返信はありません。';
            }

            if (pagination.hasMore) repliesLoadObserver.observe(trigger);
        } catch (err) {
            console.error('Post detail error:', err);
            contentDiv.innerHTML = `<p class="error-message">${err.message || 'ページの読み込みに失敗しました。'}</p>`;
        } finally {
            showLoading(false);
        }
    }

    async function showDmScreen(dmId = null) {
        if (!getCurrentUser()) {
            window.location.hash = '#';
            return;
        }
        showScreen('dm-screen');
        const contentDiv = DOM.dmContent;

        if (dmId) {
            DOM.pageHeader.innerHTML = '';
            contentDiv.innerHTML = '<div id="dm-conversation-container"></div>';
            await showDmConversation(dmId);
        } else {
            DOM.pageHeader.innerHTML = `<h2 id="page-title">メッセージ</h2>`;

            contentDiv.innerHTML = `
	                <div id="dm-list-container">
	                    <button class="dm-new-message-btn" data-action="open-create-dm">新しいメッセージ</button>
	                    <div id="dm-list-items-wrapper" class="spinner"></div>
	                </div>
	            `;
            const listItemsWrapper = document.getElementById(
                'dm-list-items-wrapper',
            );

            try {
                const dmListCacheKey = getDmCacheKey('list');
                let dmPayload = getScreenDataCache(dmListCacheKey);
                if (!dmPayload) {
                    const { data, error } = await apiRequest('/server/api/dm');
                    if (error) throw error;
                    dmPayload = data || {};
                    setScreenDataCache(dmListCacheKey, dmPayload);
                }
                const dmList = Array.isArray(dmPayload?.dm) ? dmPayload.dm : [];
                const unreadCountsMap = getDmUnreadCounts();
                unreadCountsMap.clear();
                dmList.forEach((dm) =>
                    unreadCountsMap.set(
                        String(dm.id),
                        Number(dm.unread_count || 0),
                    ),
                );
                for (const member of dmPayload?.members || []) {
                    getAllUsersCache().set(member.id, member);
                }
                getCurrentUser().unreadDmTotal = Number(
                    dmPayload?.unread_total || 0,
                );
                // メッセージ画面を開いた時点で、取得済みの未読合計をサイドメニューへ即時反映する。
                void updateNavAndSidebars();

                if (window.location.hash.startsWith('#dm/')) {
                    window.history.replaceState({ path: '#dm' }, '', '#dm');
                }

                if (dmList.length === 0) {
                    listItemsWrapper.innerHTML =
                        '<p style="text-align:center; padding: 2rem; color: var(--secondary-text-color);">まだメッセージはありません。</p>';
                } else {
                    listItemsWrapper.innerHTML = dmList
                        .map((dm) => {
                            const unreadCount =
                                unreadCountsMap.get(String(dm.id)) || 0;
                            const titlePrefix =
                                unreadCount > 0 ? `(${unreadCount}) ` : '';
                            const title = getEmoji(
                                escapeHTML(
                                    dm.title ||
                                        dm.member
                                            .map(
                                                (id) =>
                                                    getAllUsersCache().get(id)
                                                        ?.name || id,
                                            )
                                            .join(', '),
                                ),
                            );

                            return `
	<div class="dm-list-item" data-action="open-dm" data-dm-id="${escapeHTML(String(dm.id))}">
	                                <div class="dm-list-item-title"><span class="dm-list-item-unread-prefix">${titlePrefix}</span>${title}</div>
	                                <button type="button" class="dm-manage-btn" title="DM管理メニュー" aria-label="DM管理メニュー" data-action="open-dm-manage" data-dm-id="${escapeHTML(String(dm.id))}">${ICONS.more}</button>
	                            </div>
	                        `;
                        })
                        .join('');
                }

                listItemsWrapper.classList.remove('spinner');
            } catch (e) {
                console.error('DMリストの読み込みに失敗:', e);
                listItemsWrapper.innerHTML =
                    '<p class="error-message">メッセージの読み込みに失敗しました。</p>';
                listItemsWrapper.classList.remove('spinner');
            } finally {
                showLoading(false);
            }
        }
    }
    async function showDmConversation(dmId) {
        const container = document.getElementById('dm-conversation-container');
        container.innerHTML = '<div class="spinner"></div>';

        let dmSelectedFiles = [];

        try {
            const dmConversationCacheKey = getDmCacheKey(
                'conversation',
                String(dmId),
            );
            let dmPayload = getScreenDataCache(dmConversationCacheKey);
            let error = null;
            const usedCachedPayload = Boolean(dmPayload);
            let cachedUnreadBefore = 0;
            let readSucceeded = !usedCachedPayload;
            if (!dmPayload) {
                const result = await apiRequest(
                    `/server/api/dm/${encodeURIComponent(dmId)}?mark_read=1`,
                );
                dmPayload = result.data || {};
                error = result.error;
                if (!error)
                    setScreenDataCache(dmConversationCacheKey, dmPayload);
            } else {
                // キャッシュ復元時も既読化し、成功時はバッジを待たずにローカル状態へ反映する。
                const key = String(dmId);
                cachedUnreadBefore = Number(getDmUnreadCounts().get(key) || 0);
                const { error: readError } = await apiRequest(
                    `/server/api/dm/${encodeURIComponent(dmId)}/read`,
                    { method: 'POST' },
                );
                if (readError) {
                    console.error('DM既読化に失敗しました:', readError);
                } else {
                    readSucceeded = true;
                    getDmUnreadCounts().set(key, 0);
                    getCurrentUser().unreadDmTotal = Math.max(
                        0,
                        Number(getCurrentUser().unreadDmTotal || 0) -
                            cachedUnreadBefore,
                    );
                    deleteScreenDataCache(getDmCacheKey('list'));
                }
            }
            const dm = Array.isArray(dmPayload?.dm) ? dmPayload.dm[0] : null;
            for (const member of dmPayload?.members || []) {
                getAllUsersCache().set(member.id, member);
            }
            setActiveDmMemberIds(
                Array.isArray(dm?.member) ? dm.member.map(Number) : [],
            );
            if (!usedCachedPayload) {
                getCurrentUser().unreadDmTotal = Number(
                    dmPayload?.unread_total || 0,
                );
            }
            if (dm && readSucceeded) {
                getDmUnreadCounts().set(String(dm.id), 0);
                deleteScreenDataCache(getDmCacheKey('list'));
                if (!error) void updateNavAndSidebars();
            }
            if (error || !dm || !dm.member.includes(getCurrentUser().id)) {
                DOM.pageHeader.innerHTML = `
	                    <div class="header-with-back-button">
	                        <button class="header-back-btn" data-action="history-back">${ICONS.back}</button>
	                        <h2 id="page-title">エラー</h2>
	                    </div>`;
                container.innerHTML =
                    '<p class="error-message" style="margin:2rem;">DMが見つからないか、アクセス権がありません。</p>';
                showLoading(false);
                return;
            }

            DOM.pageHeader.innerHTML = `
	                <div class="header-with-back-button">
	                    <button class="header-back-btn" data-action="history-back">${ICONS.back}</button>
	                    <div style="flex-grow:1;">
	                        <h2 id="page-title" style="font-size: 1.1rem; margin-bottom: 0;">${getEmoji(escapeHTML(dm.title))}</h2>
	                        <small style="color: var(--secondary-text-color);">${dm.member.length}人のメンバー</small>
	                    </div>
	                    <button type="button" class="dm-manage-btn" title="DM管理メニュー" aria-label="DM管理メニュー" data-action="open-dm-manage" data-dm-id="${escapeHTML(String(dm.id))}">${ICONS.more}</button>
	                </div>
	            `;

            setActiveDmId(String(dm.id));
            let posts = dm.post || [];
            posts = filterBlockedPosts(posts);
            const allUserIdsInDm = new Set(dm.member);

            posts.forEach((msg) => {
                if (msg.userid) allUserIdsInDm.add(msg.userid);
                if (msg.content) {
                    for (const match of msg.content.matchAll(/@(\d+)/g)) {
                        allUserIdsInDm.add(parseInt(match[1]));
                    }
                }
            });

            const newIdsToFetch = [...allUserIdsInDm].filter(
                (id) => id && !getAllUsersCache().has(id),
            );
            if (newIdsToFetch.length > 0) {
                const { data: users } = await api
                    .from('user')
                    .select('id, name, scid, icon_data')
                    .in('id', newIdsToFetch);
                if (users) {
                    users.forEach((u) => getAllUsersCache().set(u.id, u));
                }
            }

            const messagesHTMLArray = await Promise.all(
                posts
                    .slice()
                    .reverse()
                    .map((msg) => renderDmMessage(msg, dm.id)),
            );
            const messagesHTML = messagesHTMLArray.join('');

            container.innerHTML = `
	                <div class="dm-conversation-view">${messagesHTML}</div>
	                <div class="dm-message-form">
	                    <div class="dm-form-content">
                            <div class="markdown-textarea-editor dm-content-editor"><textarea id="dm-message-input" class="markdown-content-editor" rows="2" spellcheck="true" data-markdown-content-editor placeholder="メッセージを送信"></textarea><div class="markdown-editor-paint" aria-hidden="true"><div class="markdown-editor-placeholder"></div><div class="markdown-editor-preview hidden"></div><div class="markdown-editor-selection"></div><div class="markdown-editor-composition"></div><div class="markdown-editor-caret"></div></div></div>
                            <div class="file-preview-container dm-file-preview"></div>
	                    </div>
	                    <div class="dm-form-actions">
	                        <button id="dm-attachment-btn" class="attachment-button" title="ファイルを添付">${ICONS.attachment}</button>
	                        <input type="file" id="dm-file-input" class="hidden" multiple>
	                        <button id="send-dm-btn" title="送信 (Ctrl+Enter)">${ICONS.send}</button>
	                    </div>
	                </div>
	            `;

            // 既読化によるリアルタイム通知から router() が再入しないよう、ここでは
            // 会話を再読込せずナビゲーションだけを更新する。
            void updateNavAndSidebars();
            await flushRealtimeDmMessages(dm.id);
            initializeDmMessageClamps(container);

            const messageInput = document.getElementById('dm-message-input');
            attachMarkdownContentEditor(messageInput);
            const fileInput = document.getElementById('dm-file-input');
            const previewContainer = container.querySelector(
                '.file-preview-container',
            );

            document.getElementById('dm-attachment-btn').onclick = () =>
                fileInput.click();

            fileInput.onchange = (event) => {
                dmSelectedFiles = Array.from(event.target.files);
                previewContainer.innerHTML = '';
                dmSelectedFiles.forEach((file, index) => {
                    const previewItem = document.createElement('div');
                    previewItem.className = 'file-preview-item';

                    if (file.type.startsWith('image/')) {
                        const reader = new FileReader();
                        reader.onload = (e) => {
                            previewItem.innerHTML = `<img src="${e.target.result}" alt="${escapeHTML(file.name)}"><button class="file-preview-remove" data-index="${index}">×</button>`;
                        };
                        reader.readAsDataURL(file);
                    } else if (file.type.startsWith('video/')) {
                        const reader = new FileReader();
                        reader.onload = (e) => {
                            previewItem.innerHTML = `<video src="${e.target.result}" style="width:100px; height:100px; object-fit:cover;" controls></video><button class="file-preview-remove" data-index="${index}">×</button>`;
                        };
                        reader.readAsDataURL(file);
                    } else if (file.type.startsWith('audio/')) {
                        const reader = new FileReader();
                        reader.onload = (e) => {
                            previewItem.innerHTML = `<div style="display:flex; align-items:center; gap:0.5rem;"><audio src="${e.target.result}" controls style="height: 30px; width: 200px;"></audio><button class="file-preview-remove" data-index="${index}" style="position:relative; top:0; right:0;">×</button></div>`;
                        };
                        reader.readAsDataURL(file);
                    } else {
                        previewItem.innerHTML = `<span>📄 ${escapeHTML(file.name)}</span><button class="file-preview-remove" data-index="${index}">×</button>`;
                    }

                    previewContainer.appendChild(previewItem);
                });
            };

            previewContainer.addEventListener('click', (e) => {
                if (e.target.classList.contains('file-preview-remove')) {
                    const indexToRemove = parseInt(e.target.dataset.index);
                    dmSelectedFiles.splice(indexToRemove, 1);
                    const newFiles = new DataTransfer();
                    dmSelectedFiles.forEach((file) => newFiles.items.add(file));
                    fileInput.files = newFiles.files;
                    fileInput.dispatchEvent(new Event('change'));
                }
            });

            const sendMessageAction = () => {
                sendDmMessage(dmId, dmSelectedFiles).then(() => {
                    dmSelectedFiles = [];
                    fileInput.value = '';
                    previewContainer.innerHTML = '';
                });
            };

            messageInput.addEventListener('keydown', (e) => {
                if (e.ctrlKey && e.key === 'Enter') {
                    e.preventDefault();
                    sendMessageAction();
                }
            });
            document.getElementById('send-dm-btn').onclick = sendMessageAction;

            setLastRenderedMessageId(
                posts.length > 0 ? posts[posts.length - 1].id : null,
            );
        } catch (e) {
            console.error('DM会話の読み込みに失敗:', e);
            container.innerHTML =
                '<p class="error-message">メッセージの読み込みに失敗しました。</p>';
        } finally {
            showLoading(false);
        }
    }

    async function getPublicProfile(userId) {
        const normalizedId = Number(userId);
        if (!Number.isInteger(normalizedId) || normalizedId < 0) {
            return { data: null, error: new Error('Invalid user id') };
        }
        if (getPublicProfileCache().has(normalizedId)) {
            return {
                data: getPublicProfileCache().get(normalizedId),
                error: null,
            };
        }
        const result = await apiRequest(
            `/server/api/users/${encodeURIComponent(normalizedId)}`,
        );
        if (!result.error && result.data?.user)
            getPublicProfileCache().set(normalizedId, result.data.user);
        return { data: result.data?.user || null, error: result.error };
    }

    function resetProfileTabNavigation(userId, subpage) {
        const normalizedUserId = Number(userId);
        if (!Number.isInteger(normalizedUserId) || normalizedUserId < 0) return;

        const normalizedTab = String(subpage || 'posts');
        const hash =
            normalizedTab === 'posts'
                ? `#profile/${normalizedUserId}`
                : `#profile/${normalizedUserId}/${normalizedTab}`;
        const userScope = getCurrentUser()?.id ?? 'guest';
        const profileCachePrefix = `${userScope}:${hash}:${normalizedUserId}:`;
        let cacheChanged = false;
        profilePostPageCaches.forEach((_, cacheKey) => {
            if (cacheKey.startsWith(profileCachePrefix)) {
                profilePostPageCaches.delete(cacheKey);
                cacheChanged = true;
            }
        });

        if (normalizedTab === 'following' || normalizedTab === 'followers') {
            cacheChanged =
                userPageCaches.delete(
                    `${userScope}:profile-users:${normalizedUserId}:${normalizedTab}`,
                ) || cacheChanged;
        }
        if (getPublicProfileCache().delete(normalizedUserId)) {
            cacheChanged = true;
        }
        if (cacheChanged) persistPageCaches();

        const routeKey = getScrollRouteKey(hash);
        clearSavedScrollPosition(routeKey);

        if (window.location.hash === hash) {
            // 同一タブではhashchangeが発火しないため、先頭へ移動してから再描画する。
            // router()の遷移開始処理が0,0を保存するので、古い位置は復元されない。
            window.scrollTo({ left: 0, top: 0, behavior: 'auto' });
            void router();
            return;
        }
        window.location.hash = hash;
    }

    async function showProfileScreen(userId, subpage = 'posts') {
        DOM.pageHeader.innerHTML = `
	            <div class="header-with-back-button">
	                <button class="header-back-btn" data-action="history-back">${ICONS.back}</button>
	                <h2 id="page-title">
	                    <div id="page-title-main">プロフィール</div>
	                    <small id="page-title-sub"></small>
	                </h2>
	            </div>`;
        showScreen('profile-screen');
        const profileHeader = document.getElementById('profile-header');
        const profileTabs = document.getElementById('profile-tabs');

        document.querySelector('.freeze-notice')?.remove();
        document.getElementById('profile-content').innerHTML = '';
        profileHeader.innerHTML = '<div class="spinner"></div>';
        profileTabs.innerHTML = '';

        try {
            const userResult = await getPublicProfile(userId);
            const { data: user, error } = userResult;
            if (error || !user) {
                profileHeader.innerHTML = '<h2>ユーザーが見つかりません</h2>';
                showLoading(false);
                return;
            }
            user.lock = user.visibility?.posts === 'followers_only';
            user.postCount = Number(user.post_count || 0);
            user.mediaCount = Number(user.media_count || 0);
            const followerCount = Number(user.follower_count || 0);
            await ensureMentionedUsersCached([user.me]);

            if (user.account_state === 'frozen') {
                document.getElementById('page-title-main').innerHTML = getEmoji(
                    escapeHTML(user.name),
                );
                document.getElementById('page-title-sub').textContent =
                    `${getNyaitterId(user)}`;
                profileHeader.innerHTML = `
	                    <div class="header-top">
	                        <img src="${getUserIconUrl(user)}" class="user-icon-large" alt="${escapeHTML(user.name)}'s icon">
	                        <div id="profile-actions" class="profile-actions"></div>
	                    </div>
	                    <div class="profile-info">
	                        <h2>${getEmoji(escapeHTML(user.name))}</h2>
							<div class="user-id" title="Nyaitter ID">${getNyaitterId(user)}</div>
	                    </div>`;
                const actionsContainer =
                    profileHeader.querySelector('#profile-actions');
                if (
                    actionsContainer &&
                    getCurrentUser()?.admin &&
                    Number(user.id) !== Number(getCurrentUser().id)
                ) {
                    const menuButton = document.createElement('button');
                    menuButton.type = 'button';
                    menuButton.className = 'profile-menu-button dm-button';
                    menuButton.innerHTML = ICONS.more;
                    menuButton.title = '管理者メニュー';
                    menuButton.setAttribute('aria-label', '管理者メニュー');
                    menuButton.onclick = (event) => {
                        event.stopPropagation();
                        openProfileMenu(user);
                    };
                    actionsContainer.appendChild(menuButton);
                }
                const freezeNotice = document.createElement('div');
                freezeNotice.className = 'freeze-notice';
                freezeNotice.innerHTML = `このユーザーは<a href="rule" target="_blank" rel="noopener noreferrer">Nyaitterルール</a>に違反したため凍結されています。`;
                profileTabs.innerHTML = '';
                profileTabs.insertAdjacentElement('afterend', freezeNotice);

                showLoading(false);
                return;
            }

            // ブロック状態の通知
            let blockNoticeHtml = '';
            if (getCurrentUser() && getCurrentUser().id !== user.id) {
                if (
                    Array.isArray(getCurrentUser().block) &&
                    getCurrentUser().block.includes(user.id)
                ) {
                    blockNoticeHtml += `<div class="freeze-notice">あなたはこのユーザーをブロックしています。ポスト/メッセージは表示されません。</div>`;
                }
                if (user.relationship?.profile_blocks_viewer) {
                    blockNoticeHtml += `<div class="freeze-notice">このユーザーはあなたをブロックしています。ポスト/メッセージは表示されません。</div>`;
                }
                if (user.lock) {
                    blockNoticeHtml += `<div class="freeze-notice">このユーザーはポストを非公開に設定しています。表示するには相互フォロー状態になってください。</div>`;
                }
            } else if (!getCurrentUser()) {
                if (user.lock) {
                    blockNoticeHtml += `<div class="freeze-notice">このユーザーはポストを非公開に設定しています。</div>`;
                }
            }
            if (blockNoticeHtml) {
                // 通知を生成
                document
                    .querySelectorAll('.freeze-notice')
                    .forEach((el) => el.remove());
                profileTabs.insertAdjacentHTML('afterend', blockNoticeHtml);
            }

            // 最小公開プロフィールと並列取得済みのカウントを利用する。
            const headerImageUrl = getUserHeaderImageUrl(user);
            const userMeHtml = formatPostContent(
                user.me || '',
                getAllUsersCache(),
            );
            profileHeader.classList.toggle(
                'has-profile-banner',
                Boolean(headerImageUrl),
            );
            const profileBannerHtml = headerImageUrl
                ? `<div class="profile-banner"><img src="${escapeHTML(headerImageUrl)}" alt="${escapeHTML(user.name)}のヘッダー画像"></div>`
                : '';

            profileHeader.innerHTML = `
	                ${profileBannerHtml}
	                <div class="header-top">

	                    <img src="${getUserIconUrl(user)}" class="user-icon-large" alt="${escapeHTML(user.name)}'s icon">
	                    <div id="profile-actions" class="profile-actions"></div>
	                </div>
	                <div class="profile-info">
	                    <h2>
	                        ${getEmoji(escapeHTML(user.name))}
	                        ${user.admin ? `<img src="icons/admin.png" class="admin-badge" title="NyaitterTeam">` : (await contributors).includes(user.id) ? `<img src="icons/contributor.png" class="contributor-badge" title="開発協力者">` : user.verify ? `<img src="icons/verify.png" class="verify-badge" title="認証済み">` : ''}
	                        
	                    </h2>
											<div class="user-id" title="Nyaitter ID">${getNyaitterId(user)} ${user.visibility?.scid === 'public' && user.scid ? `(<a href="https://scratch.mit.edu/users/${user.scid}" class="scidlink" target="_blank" rel="noopener noreferrer">@${user.scid}</a>)` : ''}</div>

	                    <p class="user-me">${userMeHtml}</p>
	                    <div class="profile-joined" aria-label="アカウント作成日">
	                    <svg class="calendar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false">
	                        <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
	                        <line x1="16" y1="2" x2="16" y2="6"></line>
	                        <line x1="8" y1="2" x2="8" y2="6"></line>
	                        <line x1="3" y1="10" x2="21" y2="10"></line>
	                    </svg>
	                    <span class="profile-joined-text">${(() => {
                            const value = user.created_at;
                            const d = value ? new Date(value) : null;
                            if (!d || Number.isNaN(d.getTime())) {
                                return 'Nyaitterを利用しています';
                            }
                            const parts = new Intl.DateTimeFormat('ja-JP', {
                                timeZone: 'Asia/Tokyo',
                                year: 'numeric',
                                month: 'numeric',
                                day: 'numeric',
                            }).formatToParts(d);
                            const get = (type) =>
                                parts.find((part) => part.type === type)?.value;
                            return `${get('year')}年${get('month')}月${get('day')}日よりNyaitterを利用しています`;
                        })()}</span>
	                    </div>
	                    <div class="user-stats">
	                        <a href="#profile/${user.id}/following"><strong>${user.following_count || 0}</strong> フォロー中</a>
	                        <a href="#profile/${user.id}/followers" id="follower-count"><strong>${followerCount}</strong> フォロワー</a>
	                    </div>
	                </div>`;

            if (getCurrentUser() && userId !== getCurrentUser().id) {
                const actionsContainer =
                    profileHeader.querySelector('#profile-actions');
                if (actionsContainer) {
                    // DMボタン
                    const dmButton = document.createElement('button');
                    dmButton.className = 'dm-button';
                    dmButton.title = 'メッセージを送信';
                    dmButton.innerHTML = ICONS.dm;
                    dmButton.onclick = () => handleDmButtonClick(userId);
                    actionsContainer.appendChild(dmButton);

                    // フォローボタン
                    const followButton = document.createElement('button');
                    const isFollowing =
                        getCurrentUser().follow?.includes(userId);
                    updateFollowButtonState(
                        followButton,
                        isFollowing,
                        user.lock,
                    );
                    followButton.classList.add('profile-follow-button');
                    followButton.onclick = () =>
                        window.handleFollowToggle(
                            userId,
                            followButton,
                            user.lock,
                        );
                    actionsContainer.appendChild(followButton);

                    const menuButton = document.createElement('button');
                    menuButton.type = 'button';
                    menuButton.className = 'profile-menu-button dm-button'; // dm-buttonのスタイルを流用
                    menuButton.innerHTML = ICONS.more;
                    menuButton.title = 'プロフィールメニュー';
                    menuButton.setAttribute(
                        'aria-label',
                        'プロフィールメニュー',
                    );
                    menuButton.onclick = (e) => {
                        e.stopPropagation();
                        openProfileMenu(user);
                    };
                    actionsContainer.appendChild(menuButton);
                }
            }

            const mainTabs = [
                { key: 'posts', name: 'ポスト' },
                { key: 'replies', name: '返信', className: 'mobile-hidden' },
                { key: 'media', name: 'メディア' },
                { key: 'likes', name: 'いいね' },
                { key: 'stars', name: 'お気に入り' },
            ];

            profileTabs.innerHTML = mainTabs
                .map(
                    (tab) =>
                        `<button class="tab-button ${tab.className || ''} ${tab.key === subpage ? 'active' : ''}" data-tab="${tab.key}">${tab.name}</button>`,
                )
                .join('');

            profileTabs.querySelectorAll('.tab-button').forEach((button) => {
                button.onclick = (e) => {
                    e.stopPropagation();
                    resetProfileTabNavigation(user.id, button.dataset.tab);
                };
            });

            activeProfilePullRefreshUser = user;
            await loadProfileTabContent(user, subpage);
        } catch (err) {
            profileHeader.innerHTML =
                '<h2>プロフィールの読み込みに失敗しました</h2>';
            console.error(err);
        } finally {
            showLoading(false);
        }
    }

    async function loadProfileTabContent(user, subpage) {
        const profileHeader = document.getElementById('profile-header');
        const profileTabs = document.getElementById('profile-tabs');
        const contentDiv = document.getElementById('profile-content');

        setIsLoadingMore(false);
        if (getPostLoadObserver()) getPostLoadObserver().disconnect();
        contentDiv.innerHTML = '';

        const isFollowListActive =
            subpage === 'following' || subpage === 'followers';

        profileHeader.classList.toggle('hidden', isFollowListActive);
        profileTabs.classList.toggle('hidden', isFollowListActive);

        const pageTitleMain = document.getElementById('page-title-main');
        const pageTitleSub = document.getElementById('page-title-sub');
        pageTitleMain.innerHTML = getEmoji(escapeHTML(user.name));
        if (isFollowListActive) {
            pageTitleSub.textContent = `${getNyaitterId(user)}`;
        } else if (subpage === 'media') {
            pageTitleSub.textContent = `${user.mediaCount || 0} 件の画像と動画`;
        } else {
            pageTitleSub.textContent = `${user.postCount || 0} 件のポスト`;
        }

        const existingSubTabs = document.getElementById(
            'profile-sub-tabs-container',
        );
        if (existingSubTabs) existingSubTabs.remove();

        if (isFollowListActive) {
            const subTabsContainer = document.createElement('div');
            subTabsContainer.id = 'profile-sub-tabs-container';
            subTabsContainer.innerHTML = `
	                <div class="profile-sub-tabs">
	                    <button class="tab-button ${subpage === 'following' ? 'active' : ''}" data-sub-tab="following">フォロー中</button>
	                    <button class="tab-button ${subpage === 'followers' ? 'active' : ''}" data-sub-tab="followers">フォロワー</button>
	                </div>`;

            DOM.pageHeader.parentNode.insertBefore(
                subTabsContainer,
                DOM.pageHeader.nextSibling,
            );
            const headerHeight = DOM.pageHeader.offsetHeight;
            subTabsContainer.style.top = `${headerHeight}px`;

            subTabsContainer
                .querySelectorAll('.tab-button')
                .forEach((button) => {
                    button.onclick = (e) => {
                        e.stopPropagation();
                        resetProfileTabNavigation(
                            user.id,
                            button.dataset.subTab,
                        );
                    };
                });
        } else {
            document
                .querySelectorAll('#profile-tabs .tab-button')
                .forEach((btn) =>
                    btn.classList.toggle('active', btn.dataset.tab === subpage),
                );
        }

        try {
            switch (subpage) {
                case 'posts':
                    await loadPostsWithPagination(contentDiv, 'profile_posts', {
                        userId: user.id,
                        subType: 'posts_only',
                        pinId: user.pinned_post_id,
                        pageCache: getProfilePostPageCache(
                            user.id,
                            'posts_only',
                            user.pinned_post_id,
                        ),
                    });
                    break;
                case 'replies':
                    await loadPostsWithPagination(contentDiv, 'profile_posts', {
                        userId: user.id,
                        subType: 'replies_only',
                        pageCache: getProfilePostPageCache(
                            user.id,
                            'replies_only',
                        ),
                    });
                    break;
                case 'likes':
                    if (user.visibility?.likes !== 'public') {
                        contentDiv.innerHTML =
                            '<p style="padding: 2rem; text-align:center;">🔒 このユーザーのいいねは非公開です。</p>';
                        break;
                    }
                    await loadPostsWithPagination(contentDiv, 'likes', {
                        userId: user.id,
                        pageCache: getProfilePostPageCache(user.id, 'likes'),
                    });
                    break;
                case 'stars':
                    if (user.visibility?.stars !== 'public') {
                        contentDiv.innerHTML =
                            '<p style="padding: 2rem; text-align:center;">🔒 このユーザーのお気に入りは非公開です。</p>';
                        break;
                    }
                    await loadPostsWithPagination(contentDiv, 'stars', {
                        userId: user.id,
                        pageCache: getProfilePostPageCache(user.id, 'stars'),
                    });
                    break;
                case 'following':
                    if (user.visibility?.following !== 'public') {
                        contentDiv.innerHTML =
                            '<p style="padding: 2rem; text-align:center;">🔒 このユーザーのフォローリストは非公開です。</p>';
                        break;
                    }
                    await loadUsersWithPagination(contentDiv, 'follows', {
                        userId: user.id,
                        pageCache: getUserPageCache(
                            `${getCurrentUser()?.id ?? 'guest'}:profile-users:${user.id}:following`,
                        ),
                    });
                    break;
                case 'followers':
                    if (user.visibility?.followers !== 'public') {
                        contentDiv.innerHTML =
                            '<p style="padding: 2rem; text-align:center;">🔒 このユーザーのフォロワーリストは非公開です。</p>';
                        break;
                    }
                    await loadUsersWithPagination(contentDiv, 'followers', {
                        userId: user.id,
                        pageCache: getUserPageCache(
                            `${getCurrentUser()?.id ?? 'guest'}:profile-users:${user.id}:followers`,
                        ),
                    });
                    break;
                case 'media':
                    await loadMediaGrid(contentDiv, { userId: user.id });
                    break;
            }
        } catch (err) {
            contentDiv.innerHTML = `<p class="error-message">コンテンツの読み込みに失敗しました。</p>`;
            console.error('loadProfileTabContent error:', err);
        }
    }

    async function showSettingsScreen(
        initialGroup = getSettingsGroupFromHash(),
    ) {
        if (!getCurrentUser()) return router();
        DOM.pageHeader.innerHTML = `<h2 id="page-title">設定</h2>`;
        showScreen('settings-screen');
        setNewIconDataUrl(null);
        setResetIconToDefault(false);
        setNewHeaderDataUrl(null);
        setResetHeaderToDefault(false);

        document.getElementById('settings-screen').innerHTML = `
	                <div class="settings-layout">
			                    <nav class="settings-group-list" aria-label="設定グループ">
			                        <a href="#settings/profile" class="settings-group-button" data-settings-group="profile">プロフィール</a>
			                        <a href="#settings/privacy" class="settings-group-button" data-settings-group="privacy">プライバシーとセキュリティ</a>
			                        <a href="#settings/ui" class="settings-group-button" data-settings-group="ui">UI / フォント</a>
				                        <a href="#settings/notifications" class="settings-group-button" data-settings-group="notifications">通知</a>
				                        <a href="#settings/storage" class="settings-group-button" data-settings-group="storage">ストレージ</a>
				                        <a href="#settings/api" class="settings-group-button" data-settings-group="api">API / Bot</a>
			                        <a href="#settings/resources" class="settings-group-button" data-settings-group="resources">リソース</a>
			                    </nav>
	                    <form id="settings-form" class="settings-detail">
	                        <div class="settings-detail-heading">
	                            <h3 id="settings-group-title">プロフィール</h3>
	                            <p id="settings-group-description" class="settings-group-description">プロフィールに表示される情報と画像を設定します。</p>
	                        </div>
	                        <section class="settings-group-panel" data-settings-panel="profile">
	                            <label for="setting-username">ユーザー名</label>
	                            <input type="text" id="setting-username" required value="${escapeHTML(getCurrentUser().name)}">
	                            <label for="setting-icon-input">アイコン</label>
	                            <div class="setting-icon-container">
	                                <img id="setting-icon-preview" src="${getUserIconUrl(getCurrentUser())}" alt="アイコンのプレビュー" title="クリックしてファイルを選択">
	                                <button type="button" id="reset-icon-btn">デフォルトに戻す</button>
	                            </div>
	                            <input type="file" id="setting-icon-input" accept="image/*" class="hidden">
	                            <label for="setting-header-input">ヘッダー画像</label>
	                            <div class="setting-header-container">
	                                <div id="setting-header-preview" class="setting-header-preview ${getUserHeaderImageUrl(getCurrentUser()) ? '' : 'is-empty'}" title="クリックしてファイルを選択">
	                                    ${getUserHeaderImageUrl(getCurrentUser()) ? `<img src="${escapeHTML(getUserHeaderImageUrl(getCurrentUser()))}" alt="ヘッダー画像のプレビュー">` : '<span>ヘッダー画像を選択</span>'}
	                                </div>
	                                <button type="button" id="reset-header-btn">ヘッダー画像を削除</button>
	                            </div>
	                            <input type="file" id="setting-header-input" accept="image/*" class="hidden">
	                            <label for="setting-me">自己紹介</label>
	                            <textarea id="setting-me">${escapeHTML(getCurrentUser().me || '')}</textarea>
	                        </section>
	                        <section class="settings-group-panel" data-settings-panel="privacy" hidden>
	                            <fieldset><legend>公開設定</legend>
	                                <label><input type="checkbox" id="setting-show-like" ${getCurrentUser().settings?.show_like ? 'checked' : ''}> いいねしたポストを公開する</label>
	                                <label><input type="checkbox" id="setting-show-follow" ${getCurrentUser().settings?.show_follow ? 'checked' : ''}> フォローしている人を公開する</label>
	                                <label><input type="checkbox" id="setting-show-follower" ${(getCurrentUser().settings?.show_follower ?? true) ? 'checked' : ''}> フォロワーリストを公開する</label>
	                                <label><input type="checkbox" id="setting-show-star" ${getCurrentUser().settings?.show_star ? 'checked' : ''}> お気に入りを公開する</label>
	                                <label><input type="checkbox" id="setting-show-scid" ${getCurrentUser().settings?.show_scid ? 'checked' : ''}> Scratchアカウント名を公開する</label>
	                                <label><input type="checkbox" id="setting-lock" ${getCurrentUser().settings?.lock ? 'checked' : ''}> ポストを非公開にする</label>
	                            </fieldset>
	                            <fieldset class="settings-login-security"><legend>ログインのセーフティ</legend>
	                                <label><input type="checkbox" id="setting-reject-unknown-login" ${(getCurrentUser().settings?.reject_unknown_login ?? true) ? 'checked' : ''}> 不明な場所からのログインを拒否</label>
	                                <p class="settings-help-text">有効にすると、初めて利用するIPアドレスからのログインには、ログイン済み端末での許可が必要です。</p>
	                            </fieldset>
	                            <section class="settings-verification-application" aria-labelledby="settings-verification-title">
	                                <h4 id="settings-verification-title">認証</h4>
	                                <p class="settings-help-text">認証済みアカウントにはプロフィール上で認証バッジが表示されます。申請は担当管理者が審査します。</p>
	                                <button type="button" id="open-verification-application-btn" class="settings-bot-secondary-button" ${getCurrentUser().verify ? 'disabled' : ''}>${getCurrentUser().verify ? '認証済み' : '認証を申請する'}</button>
	                                <p id="verification-application-status" class="settings-help-text hidden" role="status"></p>
	                            </section>
	                            <section class="settings-sessions" aria-labelledby="settings-sessions-title">
	                                <h4 id="settings-sessions-title">セッション</h4>
	                                <p class="settings-help-text">有効なログイン端末を管理できます。IPアドレスは安全のため一部のみ表示されます。</p>
	                                <div id="settings-sessions-list" class="settings-sessions-list" aria-live="polite"></div>
	                            </section>
	                            <div class="settings-danger-zone"></div>
	                        </section>
	                        <section class="settings-group-panel" data-settings-panel="ui" hidden>
	                            <label for="setting-default-timeline">ホーム画面のデフォルトタブ</label>
	                            <select id="setting-default-timeline" class="settings-select">
	                                <option value="all">すべて</option><option value="foryou">おすすめ</option><option value="following">フォロー中</option>
	                            </select>
	                            <label for="setting-post-timestamp-format">ポスト日時の表示</label>
	                            <select id="setting-post-timestamp-format" class="settings-select">
	                                <option value="relative">相対</option>
	                                <option value="relative_detailed">相対（詳細）</option>
	                                <option value="absolute_24">絶対（24時間）</option>
	                                <option value="absolute_12">絶対（12時間）</option>
	                            </select>
	                            <p class="settings-help-text">プロフィールの参加日時には適用されません。</p>
                            <label for="setting-emoji-kind">絵文字のフォント</label>
                            <select id="setting-emoji-kind" class="settings-select">
                                <option value="twemoji">Twemoji</option><option value="emojione">Emoji One</option><option value="default">デフォルト（端末絵文字）</option>
                            </select>
                            <label for="setting-content-editor">コンテンツエディタ</label>
                            <select id="setting-content-editor" class="settings-select">
                                <option value="textarea">Textarea</option>
                                <option value="nyaitter">Nyaitterエディタ</option>
                            </select>
                            <p class="settings-help-text">Textareaはブラウザ標準の入力欄です。NyaitterエディタはMarkdownとカスタム絵文字を入力中に表示します。</p>
                            <label for="setting-theme">テーマ</label>
	                            <select id="setting-theme" class="settings-select">
	                                <option value="auto">端末設定</option><option value="light">ライト</option><option value="dark">ダーク</option>
	                            </select>
	                            <label for="setting-color-theme">カラーテーマ</label>
	                            <select id="setting-color-theme" class="settings-select">
	                                <option value="nyaitter">Nyaitter</option>
	                                <option value="nyax">NyaX</option>
	                                <option value="custom">カスタム</option>
	                            </select>
	                            <p class="settings-help-text">アクセントカラーと選択状態の配色を変更します。</p>
	                            <section id="settings-custom-colors" class="settings-custom-colors" hidden aria-labelledby="settings-custom-colors-title">
	                                <h4 id="settings-custom-colors-title">カスタムカラー</h4>
	                                <p class="settings-help-text">各色はカラーピッカーまたは16進数カラーコード（例: <code>#ff9900</code>）で指定できます。</p>
	                                <div class="settings-color-grid">
	                                    <label class="settings-color-field">メインカラー
	                                        <span class="settings-color-control"><input type="color" id="setting-color-primary-picker" data-color-key="primary_color" aria-label="メインカラーのカラーピッカー"><input type="text" id="setting-color-primary" data-color-key="primary_color" class="settings-color-code" inputmode="text" autocomplete="off" spellcheck="false" maxlength="7" pattern="#[0-9a-fA-F]{6}" aria-label="メインカラーのカラーコード"></span>
	                                    </label>
	                                    <label class="settings-color-field">ホバー時のメインカラー
	                                        <span class="settings-color-control"><input type="color" id="setting-color-primary-hover-picker" data-color-key="primary_hover_color" aria-label="ホバー時のメインカラーのカラーピッカー"><input type="text" id="setting-color-primary-hover" data-color-key="primary_hover_color" class="settings-color-code" inputmode="text" autocomplete="off" spellcheck="false" maxlength="7" pattern="#[0-9a-fA-F]{6}" aria-label="ホバー時のメインカラーのカラーコード"></span>
	                                    </label>
	                                    <label class="settings-color-field">ライトモードの淡色
	                                        <span class="settings-color-control"><input type="color" id="setting-color-light-primary-picker" data-color-key="light_primary_color" aria-label="ライトモードの淡色のカラーピッカー"><input type="text" id="setting-color-light-primary" data-color-key="light_primary_color" class="settings-color-code" inputmode="text" autocomplete="off" spellcheck="false" maxlength="7" pattern="#[0-9a-fA-F]{6}" aria-label="ライトモードの淡色のカラーコード"></span>
	                                    </label>
	                                    <label class="settings-color-field">ダークモードの淡色
	                                        <span class="settings-color-control"><input type="color" id="setting-color-dark-light-primary-picker" data-color-key="dark_light_primary_color" aria-label="ダークモードの淡色のカラーピッカー"><input type="text" id="setting-color-dark-light-primary" data-color-key="dark_light_primary_color" class="settings-color-code" inputmode="text" autocomplete="off" spellcheck="false" maxlength="7" pattern="#[0-9a-fA-F]{6}" aria-label="ダークモードの淡色のカラーコード"></span>
	                                    </label>
	                                </div>
	                            </section>
	                        </section>
	                        <section class="settings-group-panel" data-settings-panel="notifications" hidden>
	                            <section class="settings-push-notifications" aria-labelledby="push-notification-title">
	                                <h4 id="push-notification-title">プッシュ通知</h4>
	                                <p id="push-notification-status" role="status">通知の状態を確認しています…</p>
	                                <button type="button" id="push-notification-action" class="settings-primary-button" disabled>読み込み中…</button>
	                                <p class="settings-help-text">通知はこの端末・ブラウザごとに設定されます。HTTPS対応のブラウザで利用できます。</p>
	                            </section>
	                        </section>
		                        <section class="settings-group-panel" data-settings-panel="storage" hidden>
		                            <section class="settings-storage" aria-labelledby="settings-storage-title">
		                                <div class="settings-storage-heading">
		                                    <div>
		                                        <h4 id="settings-storage-title">保存済みファイル</h4>
		                                        <p id="settings-storage-summary" class="settings-help-text" role="status">ストレージ使用量を読み込んでいます…</p>
		                                    </div>
		                                    <button type="button" id="settings-storage-refresh-btn" class="settings-bot-secondary-button">更新</button>
		                                </div>
		                                <div class="settings-storage-progress" aria-hidden="true"><div id="settings-storage-progress-value" class="settings-storage-progress-value"></div></div>
		                                <div id="settings-storage-files" class="settings-sessions-list" aria-live="polite"></div>
		                            </section>
		                        </section>
		                        <section class="settings-group-panel" data-settings-panel="api" hidden>
	                            <div class="settings-bot-section">
	                                <h4 id="settings-bot-title">Bot用 APIキー</h4>
	                                <p class="settings-help-text">プログラムやスクリプトからNyaitter APIを操作するためのAPIキー（Botトークン）を生成・管理できます。</p>
	                                
	                                <div class="settings-bot-create-container">
	                                    <label for="setting-bot-token-name" style="font-weight: 600; font-size: 0.9rem;">新しいAPIキーの名前</label>
	                                    <div class="settings-bot-create-form">
	                                        <input type="text" id="setting-bot-token-name" placeholder="例: 投稿Bot, 自動通知スクリプト" maxlength="50" autocomplete="off">
	                                        <button type="button" id="setting-bot-token-create-btn">APIキーを生成</button>
	                                    </div>
	                                </div>

	                                <div id="settings-bot-token-newly-created" class="settings-bot-new-key-box" hidden>
	                                    <div class="settings-bot-new-key-header">
	                                        <strong>APIキーが生成されました</strong>
	                                        <p class="settings-bot-new-key-warning">⚠️ このキーは一度しか表示されません。安全な場所にコピーして保存してください。</p>
	                                    </div>
	                                    <div class="settings-bot-new-key-display">
	                                        <input type="text" id="settings-bot-new-key-value" readonly spellcheck="false" autocomplete="off">
	                                        <button type="button" id="settings-bot-copy-key-btn" class="settings-bot-copy-button">コピー</button>
	                                    </div>
	                                    <div style="margin-top: 0.5rem; text-align: right;">
	                                        <button type="button" id="settings-bot-close-new-key-btn" class="settings-bot-secondary-button">完了</button>
	                                    </div>
	                                </div>

	                                <div class="settings-bot-list-section">
	                                    <h4 style="margin-top: 1.5rem; font-size: 1rem;">生成済みのAPIキー</h4>
	                                    <div id="settings-bot-tokens-list" class="settings-sessions-list" aria-live="polite"></div>
	                                </div>

	                                <div class="settings-bot-docs-section">
	                                    <h4 style="margin-top: 1.5rem; font-size: 1rem;">APIの使い方</h4>
	                                    <p class="settings-help-text">HTTPリクエストの <code>Authorization</code> ヘッダー（または <code>X-API-Key</code> ヘッダー）に指定してください。トークンをURLのクエリパラメータへ含めないでください。</p>
	                                    <pre class="settings-code-example"><code>curl -X POST ${window.location.origin}/server/api/posts \\
  -H "Authorization: Bearer bot_..." \\
  -H "Content-Type: application/json" \\
  -d '{"content": "Hello from Bot!"}'</code></pre>
	                                </div>
	                            </div>
	                        </section>
		                        <section class="settings-group-panel" data-settings-panel="resources" hidden>
		                            <section class="settings-resource-links" aria-labelledby="settings-resource-links-title">
		                                <h4 id="settings-resource-links-title">リンク</h4>
		                                <div id="settings-resource-links" class="settings-sessions-list"></div>
		                            </section>
		                        </section>
	                    </form>
	                    <div id="verification-application-modal" class="modal-overlay hidden" role="dialog" aria-modal="true" aria-labelledby="verification-application-title">
	                        <section class="modal-content verification-application-modal-content">
	                            <button type="button" class="modal-close-btn" data-action="close-verification-application" aria-label="閉じる">×</button>
	                            <div class="login-modal-heading">
	                                <h3 id="verification-application-title">認証を申請する</h3>
	                            </div>
	                            <p class="settings-help-text">申請内容は担当管理者が確認します。追加の説明は必要ありません。</p>
	                            <div class="verification-application-note">
	                                <strong>申請について</strong>
	                                <p>申請後は管理者への割り当てを待ちます。審査が完了すると通知でお知らせします。</p>
	                            </div>
	                            <p id="verification-application-error" class="login-modal-message login-modal-error hidden" role="alert"></p>
	                            <div class="verification-application-actions">
	                                <button type="button" class="login-secondary-button" data-action="close-verification-application">キャンセル</button>
	                                <button type="button" id="submit-verification-application-btn" class="settings-primary-button login-auth-action">申請する</button>
	                            </div>
	                        </section>
	                    </div>
	                </div>
	            `;

        // settings-group-list の sticky top をページヘッダー高さに合わせる
        const pageHeader = document.getElementById('page-header');
        const headerH = pageHeader
            ? pageHeader.getBoundingClientRect().height
            : 0;
        document.documentElement.style.setProperty(
            '--settings-nav-top',
            `${headerH + 8}px`,
        );

        // settingsに値がない場合は 'all' をデフォルトとして扱う
        const currentDefaultTab =
            getCurrentUser().settings?.default_timeline_tab || 'all';
        document.getElementById('setting-default-timeline').value =
            currentDefaultTab;
        document.getElementById('setting-post-timestamp-format').value =
            normalizePostTimestampFormat(
                getCurrentUser().settings?.post_timestamp_format,
            );

        const emoji_kind = getCurrentUser().settings?.emoji || 'twemoji';
        document.getElementById('setting-emoji-kind').value = emoji_kind;
        document.getElementById('setting-content-editor').value =
            getCurrentUser().settings?.content_editor === 'nyaitter'
                ? 'nyaitter'
                : 'textarea';

        const theme = getCurrentUser().settings?.theme || 'light';
        document.getElementById('setting-theme').value = theme;

        const colorThemeSelect = document.getElementById('setting-color-theme');
        const customColorsSection = document.getElementById(
            'settings-custom-colors',
        );
        const savedColorTheme = normalizeColorTheme(
            getCurrentUser().settings?.color_theme,
        );
        const savedCustomColors = getSafeColorPalette(
            'custom',
            getCurrentUser().settings?.custom_colors,
        );
        colorThemeSelect.value = savedColorTheme;
        document
            .querySelectorAll('.settings-color-code[data-color-key]')
            .forEach((codeInput) => {
                const colorKey = codeInput.dataset.colorKey;
                const colorPicker = document.getElementById(
                    `${codeInput.id}-picker`,
                );
                const color = savedCustomColors[colorKey];
                codeInput.value = color;
                colorPicker.value = color;
            });

        const updateColorThemeSettingsUi = () => {
            const isCustom = colorThemeSelect.value === 'custom';
            customColorsSection.hidden = !isCustom;
            document
                .querySelectorAll('#settings-custom-colors input')
                .forEach((input) => {
                    input.disabled = !isCustom;
                    if (!isCustom) input.setCustomValidity('');
                });
            applyColorTheme({
                color_theme: colorThemeSelect.value,
                custom_colors: getCustomColorsFromInputs(document),
            });
        };

        document
            .querySelectorAll('.settings-color-code[data-color-key]')
            .forEach((codeInput) => {
                const colorPicker = document.getElementById(
                    `${codeInput.id}-picker`,
                );
                colorPicker.addEventListener('input', () => {
                    codeInput.value = colorPicker.value.toLowerCase();
                    codeInput.setCustomValidity('');
                    if (colorThemeSelect.value === 'custom')
                        updateColorThemeSettingsUi();
                });
                codeInput.addEventListener('input', () => {
                    const color = codeInput.value.trim();
                    if (!HEX_COLOR_PATTERN.test(color)) {
                        codeInput.setCustomValidity(
                            'カラーコードは #rrggbb 形式で入力してください。',
                        );
                        return;
                    }
                    const normalizedColor = color.toLowerCase();
                    codeInput.value = normalizedColor;
                    codeInput.setCustomValidity('');
                    colorPicker.value = normalizedColor;
                    if (colorThemeSelect.value === 'custom')
                        updateColorThemeSettingsUi();
                });
                codeInput.addEventListener('change', () => {
                    if (!HEX_COLOR_PATTERN.test(codeInput.value.trim())) {
                        codeInput.value = colorPicker.value.toLowerCase();
                        codeInput.setCustomValidity('');
                    }
                });
            });
        colorThemeSelect.addEventListener('change', updateColorThemeSettingsUi);
        updateColorThemeSettingsUi();

        const settingsGroupMeta = {
            profile: {
                title: 'プロフィール',
                description: 'プロフィールに表示される情報と画像を設定します。',
                saveable: true,
            },
            privacy: {
                title: 'プライバシーとセキュリティ',
                description: '公開範囲とアカウントに関する操作を管理します。',
                saveable: true,
            },
            ui: {
                title: 'UI / フォント',
                description:
                    'ホーム画面、テーマ、絵文字フォントの見た目を設定します。',
                saveable: true,
            },
            notifications: {
                title: '通知',
                description: 'この端末で受け取るプッシュ通知を管理します。',
                saveable: false,
            },
            storage: {
                title: 'ストレージ',
                description: 'アップロード済みファイルと保存容量を管理します。',
                saveable: false,
            },
            api: {
                title: 'API / Bot',
                description:
                    'Botやスクリプト連携用のAPIキーを生成・管理します。',
                saveable: false,
            },
            resources: {
                title: 'リソース',
                description: 'Nyaitterに関する資料と便利なリンクです。',
                saveable: false,
            },
        };
        const selectSettingsGroup = (group) => {
            const meta = settingsGroupMeta[group] || settingsGroupMeta.profile;
            document
                .querySelectorAll('.settings-group-button')
                .forEach((button) => {
                    const active = button.dataset.settingsGroup === group;
                    button.classList.toggle('active', active);
                    button.setAttribute(
                        'aria-current',
                        active ? 'page' : 'false',
                    );
                });
            document
                .querySelectorAll('.settings-group-panel')
                .forEach((panel) => {
                    panel.hidden = panel.dataset.settingsPanel !== group;
                });
            document.getElementById('settings-group-title').textContent =
                meta.title;
            document.getElementById('settings-group-description').textContent =
                meta.description;
            if (group === 'privacy') {
                void loadLoginSecuritySessions();
            }
            if (group === 'notifications') {
                void loadPushSettingsState();
            }
            if (group === 'storage') {
                void loadUserStorage();
            }
            if (group === 'api') {
                void loadUserBotTokens();
            }
        };
        const verificationApplicationModal = document.getElementById(
            'verification-application-modal',
        );
        const verificationApplicationButton = document.getElementById(
            'open-verification-application-btn',
        );
        const verificationApplicationStatus = document.getElementById(
            'verification-application-status',
        );
        const verificationApplicationError = document.getElementById(
            'verification-application-error',
        );
        const verificationApplicationSubmit = document.getElementById(
            'submit-verification-application-btn',
        );
        const closeVerificationApplicationModal = () =>
            verificationApplicationModal?.classList.add('hidden');
        const updateVerificationApplicationStatus = (application) => {
            if (
                !verificationApplicationButton ||
                !verificationApplicationStatus
            )
                return;
            if (getCurrentUser().verify) {
                verificationApplicationButton.disabled = true;
                verificationApplicationButton.textContent = '認証済み';
                verificationApplicationStatus.classList.add('hidden');
                return;
            }
            if (!application) {
                verificationApplicationButton.disabled = false;
                verificationApplicationButton.textContent = '認証を申請する';
                verificationApplicationStatus.classList.add('hidden');
                verificationApplicationStatus.textContent = '';
                return;
            }
            verificationApplicationButton.disabled = true;
            verificationApplicationButton.textContent = '認証申請を確認中';
            verificationApplicationStatus.textContent =
                application.status === 'assigned'
                    ? '認証申請は担当管理者に割り当てられ、確認中です。'
                    : '認証申請を受け付け、担当管理者への割当を待っています。';
            verificationApplicationStatus.classList.remove('hidden');
        };
        const refreshVerificationApplicationStatus = async () => {
            if (getCurrentUser().verify)
                return updateVerificationApplicationStatus(null);
            const { data, error } = await apiRequest(
                '/server/api/verification-applications/me',
            );
            if (!error)
                updateVerificationApplicationStatus(data?.application || null);
        };
        verificationApplicationButton?.addEventListener('click', () => {
            if (!verificationApplicationButton.disabled) {
                verificationApplicationError?.classList.add('hidden');
                verificationApplicationModal?.classList.remove('hidden');
            }
        });
        verificationApplicationModal
            ?.querySelectorAll('[data-action="close-verification-application"]')
            .forEach((button) => {
                button.addEventListener(
                    'click',
                    closeVerificationApplicationModal,
                );
            });
        verificationApplicationModal?.addEventListener('click', (event) => {
            if (event.target === verificationApplicationModal)
                closeVerificationApplicationModal();
        });
        verificationApplicationSubmit?.addEventListener('click', async () => {
            verificationApplicationSubmit.disabled = true;
            verificationApplicationError?.classList.add('hidden');
            const { data, error } = await apiRequest(
                '/server/api/verification-applications',
                {
                    method: 'POST',
                    body: {},
                },
            );
            verificationApplicationSubmit.disabled = false;
            if (error) {
                if (verificationApplicationError) {
                    verificationApplicationError.textContent =
                        error.message || '認証申請を送信できませんでした。';
                    verificationApplicationError.classList.remove('hidden');
                }
                return;
            }
            closeVerificationApplicationModal();
            updateVerificationApplicationStatus(data?.application || null);
        });
        void refreshVerificationApplicationStatus();

        const dangerZone = document.querySelector('.settings-danger-zone');

        let dangerZoneHTML = `
	            <button type="button" id="settings-account-switcher-btn">アカウント切替</button>
	            <button type="button" id="settings-logout-btn">ログアウト</button>
	        `;

        // 管理者の場合「アクセスログ」ボタンを追加
        if (getCurrentUser().admin) {
            dangerZoneHTML += `
	                <a href="#admin/logs" id="settings-showlog-btn">
	                    アクセスログ
	                </a>
	            `;
        }
        dangerZone.innerHTML = dangerZoneHTML;

        const sessionsList = document.getElementById('settings-sessions-list');

        const loadLoginSecuritySessions = async () => {
            const { data, error } = await apiRequest('/server/auth/sessions');
            sessionsList.replaceChildren();
            if (error) {
                console.error('セッション一覧の取得に失敗:', error);
                return;
            }
            const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
            if (sessions.length === 0) {
                const empty = document.createElement('p');
                empty.className = 'settings-help-text';
                empty.textContent = '有効なセッションはありません。';
                sessionsList.appendChild(empty);
                return;
            }
            sessions.forEach((session) => {
                const item = document.createElement('article');
                item.className = 'settings-session-item';
                const details = document.createElement('div');
                details.className = 'settings-session-details';
                const title = document.createElement('div');
                title.className = 'settings-session-title';
                title.textContent = session.ip_masked || '旧セッション';
                if (session.current) {
                    const currentBadge = document.createElement('span');
                    currentBadge.className = 'settings-session-current';
                    currentBadge.textContent = 'この端末';
                    title.appendChild(currentBadge);
                }
                const device = document.createElement('p');
                device.className = 'settings-session-device';
                device.textContent = session.user_agent || '不明な端末';
                const dates = document.createElement('p');
                dates.className = 'settings-session-dates';
                dates.textContent = `開始: ${formatSecurityTimestamp(session.created_at)} / 有効期限: ${formatSecurityTimestamp(session.expires_at)}`;
                details.append(title, device, dates);
                const actions = document.createElement('div');
                actions.className = 'settings-session-actions';
                const invalidateButton = document.createElement('button');
                invalidateButton.type = 'button';
                invalidateButton.className =
                    'settings-session-invalidate-button';
                invalidateButton.textContent = '無効化';
                invalidateButton.addEventListener('click', async () => {
                    if (
                        !(await showAppConfirm(
                            session.current
                                ? 'この端末のセッションを無効化してログアウトしますか？'
                                : 'このセッションを無効化しますか？',
                        ))
                    )
                        return;
                    const { data: result, error: invalidateError } =
                        await apiRequest(
                            `/server/auth/sessions/${encodeURIComponent(session.id)}`,
                            { method: 'DELETE' },
                        );
                    if (invalidateError)
                        return showAppAlert(
                            `セッションの無効化に失敗しました: ${invalidateError.message}`,
                        );
                    if (result?.active_removed) {
                        setCurrentUser(null);
                        unsubscribeFromChanges();
                        window.location.hash = '#';
                        await checkSession();
                        return;
                    }
                    await loadLoginSecuritySessions();
                });
                actions.appendChild(invalidateButton);
                if (session.can_revoke_trust) {
                    const revokeButton = document.createElement('button');
                    revokeButton.type = 'button';
                    revokeButton.className = 'settings-session-revoke-button';
                    revokeButton.textContent = '信頼を取り消す';
                    revokeButton.addEventListener('click', async () => {
                        if (
                            !(await showAppConfirm(
                                'このIPアドレスの信頼を取り消し、同じIPアドレスの全セッションを無効化しますか？',
                            ))
                        )
                            return;
                        const { data: result, error: revokeError } =
                            await apiRequest(
                                `/server/auth/sessions/${encodeURIComponent(session.id)}/revoke-ip`,
                                { method: 'POST' },
                            );
                        if (revokeError)
                            return showAppAlert(
                                `信頼の取り消しに失敗しました: ${revokeError.message}`,
                            );
                        if (result?.active_removed) {
                            setCurrentUser(null);
                            unsubscribeFromChanges();
                            window.location.hash = '#';
                            await checkSession();
                            return;
                        }
                        await loadLoginSecuritySessions();
                    });
                    actions.appendChild(revokeButton);
                }
                item.append(details, actions);
                sessionsList.appendChild(item);
            });
        };

        const botTokensList = document.getElementById(
            'settings-bot-tokens-list',
        );
        const createBotTokenBtn = document.getElementById(
            'setting-bot-token-create-btn',
        );
        const botTokenNameInput = document.getElementById(
            'setting-bot-token-name',
        );
        const newlyCreatedBox = document.getElementById(
            'settings-bot-token-newly-created',
        );
        const newlyCreatedValue = document.getElementById(
            'settings-bot-new-key-value',
        );
        const copyBotKeyBtn = document.getElementById(
            'settings-bot-copy-key-btn',
        );
        const closeNewKeyBtn = document.getElementById(
            'settings-bot-close-new-key-btn',
        );

        const loadUserBotTokens = async () => {
            if (!botTokensList) return;
            const { data, error } = await apiRequest('/server/auth/bot-tokens');
            botTokensList.replaceChildren();
            if (error) {
                console.error('Botトークン一覧の取得に失敗:', error);
                const errP = document.createElement('p');
                errP.className = 'settings-help-text';
                errP.textContent = 'APIキー一覧の取得に失敗しました。';
                botTokensList.appendChild(errP);
                return;
            }
            const tokens = Array.isArray(data?.tokens) ? data.tokens : [];
            if (tokens.length === 0) {
                const empty = document.createElement('p');
                empty.className = 'settings-help-text';
                empty.textContent = '生成済みのAPIキーはありません。';
                botTokensList.appendChild(empty);
                return;
            }
            tokens.forEach((token) => {
                const item = document.createElement('article');
                item.className = 'settings-session-item';
                const details = document.createElement('div');
                details.className = 'settings-session-details';
                const title = document.createElement('div');
                title.className = 'settings-session-title';
                title.textContent = token.name || '名称未設定';
                const idBadge = document.createElement('span');
                idBadge.className = 'settings-bot-token-id';
                idBadge.textContent = `ID: ${token.tokenId}`;
                title.appendChild(idBadge);
                const dates = document.createElement('p');
                dates.className = 'settings-session-dates';
                const createdStr = token.createdAt
                    ? formatSecurityTimestamp(token.createdAt)
                    : '日時不明';
                const lastUsedStr = token.lastUsedAt
                    ? formatSecurityTimestamp(token.lastUsedAt)
                    : '未使用';
                dates.textContent = `作成: ${createdStr} / 最終使用: ${lastUsedStr}`;
                details.append(title, dates);

                const actions = document.createElement('div');
                actions.className = 'settings-session-actions';
                const revokeBtn = document.createElement('button');
                revokeBtn.type = 'button';
                revokeBtn.className = 'settings-session-revoke-button';
                revokeBtn.textContent = '無効化';
                revokeBtn.addEventListener('click', async () => {
                    if (
                        !(await showAppConfirm(
                            `APIキー「${token.name || token.tokenId}」を無効化しますか？\n無効化するとこのキーを使用したBotはアクセスできなくなります。`,
                        ))
                    )
                        return;
                    revokeBtn.disabled = true;
                    const { error: revokeError } = await apiRequest(
                        `/server/auth/bot-tokens/${encodeURIComponent(token.tokenId)}`,
                        { method: 'DELETE' },
                    );
                    if (revokeError) {
                        showAppAlert(
                            `APIキーの無効化に失敗しました: ${revokeError.message}`,
                        );
                        revokeBtn.disabled = false;
                        return;
                    }
                    await loadUserBotTokens();
                });
                actions.appendChild(revokeBtn);
                item.append(details, actions);
                botTokensList.appendChild(item);
            });
        };

        const resourceLinksList = document.getElementById(
            'settings-resource-links',
        );
        if (resourceLinksList) {
            resourceLinksList.replaceChildren();
            const resources = Array.isArray(RESOURCE_LINKS)
                ? RESOURCE_LINKS
                : [];
            if (resources.length === 0) {
                const empty = document.createElement('p');
                empty.className = 'settings-help-text';
                empty.textContent = '表示するリソースリンクはありません。';
                resourceLinksList.appendChild(empty);
            } else {
                resources.forEach((resource) => {
                    if (
                        !resource ||
                        typeof resource.name !== 'string' ||
                        typeof resource.url !== 'string'
                    )
                        return;
                    const item = document.createElement('article');
                    item.className = 'settings-session-item';
                    const link = document.createElement('a');
                    link.className = 'settings-session-title';
                    link.textContent = resource.name;
                    link.href = resource.url;
                    if (/^https:\/\//i.test(resource.url)) {
                        link.target = '_blank';
                        link.rel = 'noopener noreferrer';
                    }
                    item.appendChild(link);
                    resourceLinksList.appendChild(item);
                });
            }
        }

        const formatStorageSize = (value) => {
            const bytes = Math.max(0, Number(value) || 0);
            if (bytes < 1024) return `${bytes} B`;
            if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
            if (bytes < 1024 * 1024 * 1024)
                return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
            return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
        };

        const loadUserStorage = async () => {
            const summary = document.getElementById('settings-storage-summary');
            const progress = document.getElementById(
                'settings-storage-progress-value',
            );
            const fileList = document.getElementById('settings-storage-files');
            if (!summary || !progress || !fileList) return;

            summary.textContent = 'ストレージ使用量を読み込んでいます…';
            fileList.replaceChildren();
            const { data, error } = await apiRequest(
                '/server/api/posts/uploads/storage',
            );
            if (error) {
                summary.textContent = 'ストレージ情報の取得に失敗しました。';
                progress.style.width = '0%';
                return;
            }

            const payload = data?.data || data || {};
            const usedBytes = Math.max(0, Number(payload.used_bytes) || 0);
            const limitBytes = Math.max(1, Number(payload.limit_bytes) || 1);
            const percent = Math.min(
                100,
                Math.max(
                    0,
                    Number(payload.used_percent) ||
                        (usedBytes / limitBytes) * 100,
                ),
            );
            summary.textContent = `${formatStorageSize(usedBytes)} / ${formatStorageSize(limitBytes)}（${percent.toFixed(1)}% 使用）`;
            progress.style.width = `${percent}%`;

            const files = Array.isArray(payload.files) ? payload.files : [];
            if (files.length === 0) {
                const empty = document.createElement('p');
                empty.className = 'settings-help-text';
                empty.textContent = '保存済みファイルはありません。';
                fileList.appendChild(empty);
                return;
            }

            files.forEach((file) => {
                const item = document.createElement('article');
                item.className = 'settings-session-item settings-storage-file';
                const details = document.createElement('div');
                details.className = 'settings-session-details';
                const title = document.createElement('div');
                title.className = 'settings-session-title';
                title.textContent =
                    file.name || file.id || '名称不明のファイル';
                const meta = document.createElement('p');
                meta.className = 'settings-session-dates';
                const updatedAt = file.updatedAt
                    ? formatSecurityTimestamp(file.updatedAt)
                    : '日時不明';
                meta.textContent = `サイズ: ${formatStorageSize(file.size)} / 更新: ${updatedAt}`;
                details.append(title, meta);

                const actions = document.createElement('div');
                actions.className = 'settings-session-actions';
                const deleteButton = document.createElement('button');
                deleteButton.type = 'button';
                deleteButton.className = 'settings-session-revoke-button';
                deleteButton.textContent = '削除';
                deleteButton.addEventListener('click', async () => {
                    if (
                        !file.id ||
                        !(await showAppConfirm(
                            `ファイル「${file.name || file.id}」を削除しますか？\n投稿やプロフィールで使用中の場合、表示できなくなることがあります。`,
                        ))
                    )
                        return;
                    deleteButton.disabled = true;
                    const { error: deleteError } = await apiRequest(
                        '/server/api/posts/uploads',
                        {
                            method: 'DELETE',
                            body: { fileIds: [file.id] },
                        },
                    );
                    if (deleteError) {
                        deleteButton.disabled = false;
                        showAppAlert(
                            `ファイルの削除に失敗しました: ${deleteError.message || '不明なエラー'}`,
                        );
                        return;
                    }
                    await loadUserStorage();
                });
                actions.appendChild(deleteButton);
                item.append(details, actions);
                fileList.appendChild(item);
            });
        };

        document
            .getElementById('settings-storage-refresh-btn')
            ?.addEventListener('click', () => {
                void loadUserStorage();
            });

        // APIグループでも関数初期化後に選択するため、
        // 直接ハッシュアクセス時にTemporal Dead Zoneへ入らない。
        selectSettingsGroup(initialGroup);

        if (createBotTokenBtn) {
            createBotTokenBtn.addEventListener('click', async () => {
                const name = (botTokenNameInput?.value || '').trim();
                createBotTokenBtn.disabled = true;
                createBotTokenBtn.textContent = '生成中…';
                try {
                    const { data, error } = await apiRequest(
                        '/server/auth/bot-tokens',
                        {
                            method: 'POST',
                            body: { name: name || undefined },
                        },
                    );
                    if (error) {
                        showAppAlert(
                            `APIキーの生成に失敗しました: ${error.message}`,
                        );
                        return;
                    }
                    if (data?.token) {
                        if (botTokenNameInput) botTokenNameInput.value = '';
                        if (newlyCreatedValue)
                            newlyCreatedValue.value = data.token;
                        if (newlyCreatedBox) {
                            newlyCreatedBox.hidden = false;
                            newlyCreatedBox.scrollIntoView({
                                behavior: 'smooth',
                                block: 'nearest',
                            });
                        }
                        if (copyBotKeyBtn) copyBotKeyBtn.textContent = 'コピー';
                        await loadUserBotTokens();
                    }
                } finally {
                    createBotTokenBtn.disabled = false;
                    createBotTokenBtn.textContent = 'APIキーを生成';
                }
            });
        }

        if (copyBotKeyBtn) {
            copyBotKeyBtn.addEventListener('click', async () => {
                if (!newlyCreatedValue?.value) return;
                try {
                    await navigator.clipboard.writeText(
                        newlyCreatedValue.value,
                    );
                    copyBotKeyBtn.textContent = 'コピー完了！';
                    setTimeout(() => {
                        if (copyBotKeyBtn) copyBotKeyBtn.textContent = 'コピー';
                    }, 2000);
                } catch (_) {
                    newlyCreatedValue.select();
                    document.execCommand('copy');
                    copyBotKeyBtn.textContent = 'コピー完了！';
                    setTimeout(() => {
                        if (copyBotKeyBtn) copyBotKeyBtn.textContent = 'コピー';
                    }, 2000);
                }
            });
        }

        if (closeNewKeyBtn) {
            closeNewKeyBtn.addEventListener('click', () => {
                if (newlyCreatedBox) newlyCreatedBox.hidden = true;
                if (newlyCreatedValue) newlyCreatedValue.value = '';
            });
        }

        const iconInput = document.getElementById('setting-icon-input');
        const iconPreview = document.getElementById('setting-icon-preview');

        iconPreview.addEventListener('click', () => iconInput.click());
        iconInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file || !file.type.startsWith('image/')) return;
            setResetIconToDefault(false);
            const reader = new FileReader();
            reader.onload = (event) => {
                const img = new Image();
                img.onload = () => {
                    const MAX_DIMENSION = 300;
                    let { width, height } = img;
                    if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
                        if (width > height) {
                            height = Math.round(
                                (height * MAX_DIMENSION) / width,
                            );
                            width = MAX_DIMENSION;
                        } else {
                            width = Math.round(
                                (width * MAX_DIMENSION) / height,
                            );
                            height = MAX_DIMENSION;
                        }
                    }
                    const canvas = document.createElement('canvas');
                    canvas.width = width;
                    canvas.height = height;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, width, height);
                    setNewIconDataUrl(canvas.toDataURL(file.type));
                    iconPreview.src = getNewIconDataUrl();
                    requestSettingsSave(
                        document.getElementById('settings-form'),
                    );
                };
                img.src = event.target.result;
            };
            reader.readAsDataURL(file);
        });

        document
            .getElementById('reset-icon-btn')
            .addEventListener('click', () => {
                setResetIconToDefault(true);
                setNewIconDataUrl(null);
                iconInput.value = '';
                iconPreview.src = getUserIconUrl(getCurrentUser());
                requestSettingsSave(document.getElementById('settings-form'));
            });

        const headerInput = document.getElementById('setting-header-input');
        const headerPreview = document.getElementById('setting-header-preview');
        headerPreview.addEventListener('click', () => headerInput.click());
        headerInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file || !file.type.startsWith('image/')) return;
            setResetHeaderToDefault(false);
            const reader = new FileReader();
            reader.onload = (event) => {
                const img = new Image();
                img.onload = () => {
                    const maxWidth = 1500;
                    const maxHeight = 600;
                    const scale = Math.min(
                        1,
                        maxWidth / img.width,
                        maxHeight / img.height,
                    );
                    const width = Math.max(1, Math.round(img.width * scale));
                    const height = Math.max(1, Math.round(img.height * scale));
                    const canvas = document.createElement('canvas');
                    canvas.width = width;
                    canvas.height = height;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, width, height);
                    setNewHeaderDataUrl(canvas.toDataURL(file.type));
                    const previewImage = document.createElement('img');
                    previewImage.src = getNewHeaderDataUrl();
                    previewImage.alt = 'header image preview';
                    headerPreview.replaceChildren(previewImage);
                    headerPreview.classList.remove('is-empty');
                    requestSettingsSave(
                        document.getElementById('settings-form'),
                    );
                };
                img.src = event.target.result;
            };
            reader.readAsDataURL(file);
        });
        document
            .getElementById('reset-header-btn')
            .addEventListener('click', () => {
                setResetHeaderToDefault(true);
                setNewHeaderDataUrl(null);
                headerInput.value = '';
                headerPreview.replaceChildren(
                    Object.assign(document.createElement('span'), {
                        textContent: 'ヘッダー画像を選択',
                    }),
                );
                headerPreview.classList.add('is-empty');
                requestSettingsSave(document.getElementById('settings-form'));
            });

        const settingsForm = document.getElementById('settings-form');
        settingsForm.addEventListener('submit', (event) =>
            event.preventDefault(),
        );
        settingsForm
            .querySelectorAll(
                'select, input[type="checkbox"], input[type="color"]',
            )
            .forEach((control) => {
                control.addEventListener('change', async () => {
                    if (control.id === 'setting-theme')
                        applyInterfaceTheme(control.value);
                    if (
                        control.id === 'setting-reject-unknown-login' &&
                        control.checked
                    ) {
                        const { error } = await apiRequest(
                            '/server/auth/login-security/trust-current-ip',
                            { method: 'POST' },
                        );
                        if (error) {
                            console.error(
                                '現在のIPアドレスを信頼済みにできませんでした:',
                                error,
                            );
                            control.checked = false;
                            showAppAlert(
                                '現在の端末を信頼済みにできなかったため、この設定は有効化されませんでした。',
                            );
                        }
                    }
                    requestSettingsSave(settingsForm);
                });
            });
        settingsForm
            .querySelectorAll('input[type="text"], textarea')
            .forEach((control) => {
                control.addEventListener('blur', () =>
                    requestSettingsSave(settingsForm),
                );
            });
        settingsForm.addEventListener('keydown', (event) => {
            if (
                event.key === 'Enter' &&
                event.target.matches('input[type="text"]')
            ) {
                event.preventDefault();
                event.target.blur();
            }
        });
        document
            .getElementById('push-notification-action')
            .addEventListener('click', togglePushSubscription);
        document
            .getElementById('settings-account-switcher-btn')
            .addEventListener('click', openAccountSwitcherModal);
        document
            .getElementById('settings-logout-btn')
            .addEventListener('click', (e) => {
                handleLogout();
            });

        showLoading(false);
    }

    function formatModerationDate(value) {
        if (!value) return '日時不明';
        const date = new Date(value);
        return Number.isNaN(date.getTime())
            ? '日時不明'
            : date.toLocaleString('ja-JP');
    }

    function moderationTargetLabel(kind) {
        return (
            { user: 'ユーザー', post: 'ポスト', dm: 'DM' }[kind] || 'コンテンツ'
        );
    }

    function moderationEvidenceText(value) {
        if (typeof value === 'string') return escapeHTML(value);
        try {
            return escapeHTML(JSON.stringify(value, null, 2));
        } catch (_) {
            return '表示できません';
        }
    }

    function renderModerationSubject(user) {
        if (!user)
            return '<p class="moderation-help-text">対象ユーザーの証跡はありません。</p>';
        return `<div class="moderation-content-evidence"><strong>${escapeHTML(user.name || '名称未設定')}</strong><br><span class="moderation-help-text">@${escapeHTML(user.scid || user.handle || String(user.id))}</span></div>`;
    }

    async function showAdminReportsScreen() {
        DOM.pageHeader.innerHTML = `
            <div class="header-with-back-button">
                <button class="header-back-btn" data-action="history-back">${ICONS.back}</button>
                <h2 id="page-title">リクエスト</h2>
            </div>`;
        showScreen('admin-reports-screen');
        const contentDiv = document.getElementById('admin-reports-content');
        contentDiv.innerHTML =
            '<div class="admin-reports-container"><div class="spinner"></div></div>';
        try {
            const { data, error } = await apiRequest(
                '/server/api/reports/assigned',
            );
            if (error) throw error;
            const reports = Array.isArray(data?.reports) ? data.reports : [];
            if (reports.length === 0) {
                contentDiv.innerHTML =
                    '<div class="admin-reports-container"><p class="moderation-help-text">現在、あなたに割り当てられているリクエストはありません。</p></div>';
                return;
            }
            contentDiv.innerHTML = `
                <div class="admin-reports-container">
                    <div class="admin-reports-list">
                        ${reports
                            .map(
                                (report) => `
                            <button type="button" class="moderation-report-card" data-action="open-admin-report" data-report-id="${Number(report.id)}">
                                <strong>${report.assignment_type === 'freeze_appeal' ? '凍結異議申し立て' : report.assignment_type === 'verification_application' ? '認証申請' : `${moderationTargetLabel(report.target_kind)}の報告`}</strong>
                                <div class="moderation-report-meta">
                                    <span>割当: ${escapeHTML(formatModerationDate(report.assigned_at))}</span>
                                    <span>リクエストID: ${Number(report.id)}</span>
                                </div>
                                <p>${escapeHTML(report.description || '説明は添付されていません。')}</p>
                            </button>
                        `,
                            )
                            .join('')}
                    </div>
                </div>`;
        } catch (error) {
            console.error('リクエスト一覧の取得に失敗:', error);
            contentDiv.innerHTML =
                '<div class="admin-reports-container"><p class="error-message">リクエスト一覧の取得に失敗しました。</p></div>';
        } finally {
            showLoading(false);
        }
    }

    async function showAdminReportDetailScreen(reportId) {
        const normalizedReportId = Number(reportId);
        if (!Number.isInteger(normalizedReportId) || normalizedReportId < 1) {
            window.location.hash = '#admin/reports';
            return;
        }
        DOM.pageHeader.innerHTML = `
            <div class="header-with-back-button">
                <button class="header-back-btn" data-action="history-back">${ICONS.back}</button>
                <h2 id="page-title">報告を確認</h2>
            </div>`;
        showScreen('admin-reports-screen');
        const contentDiv = document.getElementById('admin-reports-content');
        contentDiv.innerHTML =
            '<div class="admin-reports-container"><div class="spinner"></div></div>';
        try {
            const { data, error } = await apiRequest(
                `/server/api/reports/${normalizedReportId}`,
            );
            if (error) throw error;
            const report = data?.report;
            if (!report) throw new Error('報告が見つかりません');
            const snapshot = report.target_snapshot || {};
            if (report.assignment_type === 'verification_application') {
                DOM.pageHeader.querySelector('#page-title').textContent =
                    '認証申請を確認';
                contentDiv.innerHTML = `
                    <div class="moderation-review-layout">
                        <section class="moderation-review-section">
                            <h3>申請者</h3>
                            ${renderModerationSubject(snapshot.subjectUser)}
                        </section>
                        <section class="moderation-review-section">
                            <h3>判断</h3>
                            <p class="moderation-help-text">承認すると、申請者のプロフィールに認証バッジを付与します。拒否した場合、認証状態は変更されません。</p>
                            <div class="moderation-form-actions">
                                <button type="button" class="moderation-submit-button" data-verification-decision="approved">承認して認証する</button>
                                <button type="button" class="delete-btn" data-verification-decision="rejected">拒否する</button>
                            </div>
                            <p id="verification-decision-error" class="login-modal-message login-modal-error hidden" role="alert"></p>
                        </section>
                    </div>`;
                document
                    .querySelectorAll('[data-verification-decision]')
                    .forEach((button) => {
                        button.addEventListener('click', async () => {
                            const decision =
                                button.dataset.verificationDecision;
                            if (
                                !(await showAppConfirm(
                                    decision === 'approved'
                                        ? 'この認証申請を承認し、認証バッジを付与しますか？'
                                        : 'この認証申請を拒否しますか？',
                                ))
                            )
                                return;
                            const errorElement = document.getElementById(
                                'verification-decision-error',
                            );
                            document
                                .querySelectorAll(
                                    '[data-verification-decision]',
                                )
                                .forEach((item) => {
                                    item.disabled = true;
                                });
                            errorElement?.classList.add('hidden');
                            const { error: decisionError } = await apiRequest(
                                `/server/api/reports/${Number(report.id)}/verification-decision`,
                                {
                                    method: 'POST',
                                    body: { decision },
                                },
                            );
                            if (decisionError) {
                                document
                                    .querySelectorAll(
                                        '[data-verification-decision]',
                                    )
                                    .forEach((item) => {
                                        item.disabled = false;
                                    });
                                if (errorElement) {
                                    errorElement.textContent =
                                        decisionError.message ||
                                        '認証申請を処理できませんでした。';
                                    errorElement.classList.remove('hidden');
                                }
                                return;
                            }
                            await showAppAlert(
                                decision === 'approved'
                                    ? '認証申請を承認しました。'
                                    : '認証申請を拒否しました。',
                            );
                            window.location.hash = '#admin/reports';
                        });
                    });
                return;
            }
            if (report.assignment_type === 'freeze_appeal') {
                DOM.pageHeader.querySelector('#page-title').textContent =
                    '異議申し立てを確認';
                contentDiv.innerHTML = `
                    <div class="moderation-review-layout">
                        <section class="moderation-review-section">
                            <h3>申立対象のアカウント</h3>
                            ${renderModerationSubject(snapshot.subjectUser)}
                        </section>
                        <section class="moderation-review-section">
                            <h3>現在の凍結理由</h3>
                            <div class="moderation-content-evidence">${escapeHTML(snapshot.freezeReason || '理由は記録されていません。')}</div>
                        </section>
                        <section class="moderation-review-section">
                            <h3>異議申し立ての説明</h3>
                            <div class="moderation-content-evidence">${escapeHTML(report.description || '説明は添付されていません。')}</div>
                        </section>
                        <section class="moderation-review-section">
                            <h3>判断</h3>
                            <p class="moderation-help-text">承認すると直ちにアカウントの凍結を解除します。拒否した場合、凍結状態は維持されます。</p>
                            <div class="moderation-form-actions" id="appeal-decision-actions">
                                <button type="button" class="moderation-submit-button" data-appeal-decision="approved">承認して凍結を解除</button>
                                <button type="button" class="delete-btn" data-appeal-decision="rejected">拒否する</button>
                            </div>
                            <p id="appeal-decision-error" class="login-modal-message login-modal-error hidden" role="alert"></p>
                        </section>
                    </div>`;
                document
                    .querySelectorAll('[data-appeal-decision]')
                    .forEach((button) => {
                        button.addEventListener('click', async () => {
                            const decision = button.dataset.appealDecision;
                            if (
                                !(await showAppConfirm(
                                    decision === 'approved'
                                        ? 'この異議申し立てを承認し、アカウントの凍結を解除しますか？'
                                        : 'この異議申し立てを拒否しますか？',
                                ))
                            )
                                return;
                            const errorElement = document.getElementById(
                                'appeal-decision-error',
                            );
                            document
                                .querySelectorAll('[data-appeal-decision]')
                                .forEach((item) => {
                                    item.disabled = true;
                                });
                            errorElement?.classList.add('hidden');
                            const { error: decisionError } = await apiRequest(
                                `/server/api/reports/${Number(report.id)}/appeal-decision`,
                                {
                                    method: 'POST',
                                    body: { decision },
                                },
                            );
                            if (decisionError) {
                                document
                                    .querySelectorAll('[data-appeal-decision]')
                                    .forEach((item) => {
                                        item.disabled = false;
                                    });
                                if (errorElement) {
                                    errorElement.textContent =
                                        decisionError.message ||
                                        '異議申し立てを処理できませんでした。';
                                    errorElement.classList.remove('hidden');
                                }
                                return;
                            }
                            await showAppAlert(
                                decision === 'approved'
                                    ? '異議申し立てを承認し、凍結を解除しました。'
                                    : '異議申し立てを拒否しました。',
                            );
                            window.location.hash = '#admin/reports';
                        });
                    });
                return;
            }
            const targetUsers = snapshot.subjectUser
                ? [snapshot.subjectUser]
                : snapshot.dm?.members || [];
            const selectableUsers = targetUsers.filter((user) =>
                Number.isInteger(Number(user?.id)),
            );
            const targetOptions = selectableUsers
                .map(
                    (user) =>
                        `<option value="${Number(user.id)}">${escapeHTML(user.name || `@${user.id}`)} (@${escapeHTML(user.scid || user.handle || user.id)})</option>`,
                )
                .join('');
            const dmEvidence =
                (snapshot.dm?.recentMessages || [])
                    .map(
                        (message) =>
                            `<div class="moderation-message-evidence">${moderationEvidenceText(message?.content || (message?.e2e ? '🔒 エンドツーエンド暗号化されたメッセージ' : message))}</div>`,
                    )
                    .join('') || 'メッセージ証跡はありません。';
            const evidence =
                report.target_kind === 'post'
                    ? `<div class="moderation-review-section"><h3>報告されたポスト</h3>${renderModerationSubject(snapshot.subjectUser)}<div class="moderation-content-evidence">${moderationEvidenceText(snapshot.post?.content || '')}</div></div>`
                    : report.target_kind === 'dm_message'
                      ? `<div class="moderation-review-section"><h3>報告されたDMメッセージ</h3>${renderModerationSubject(snapshot.subjectUser)}<div class="moderation-content-evidence">${moderationEvidenceText(snapshot.message?.content || (snapshot.message?.e2e ? '🔒 エンドツーエンド暗号化されたメッセージ' : '本文は記録されていません。'))}</div><p class="moderation-help-text">会話の前後関係として、サーバーに保存された直近${(snapshot.dm?.recentMessages || []).length}件のメッセージを表示します。</p><div class="moderation-content-evidence">${dmEvidence}</div></div>`
                      : report.target_kind === 'dm'
                        ? `<div class="moderation-review-section"><h3>報告されたDM</h3><p class="moderation-help-text">サーバーに保存された直近${(snapshot.dm?.recentMessages || []).length}件のメッセージです。エンドツーエンド暗号化された本文は暗号文のまま表示されます。</p><div class="moderation-content-evidence">${dmEvidence}</div></div>`
                        : `<div class="moderation-review-section"><h3>報告されたユーザー</h3>${renderModerationSubject(snapshot.subjectUser)}</div>`;
            contentDiv.innerHTML = `
                <div class="moderation-review-layout">
                    <section class="moderation-review-section">
                        <h3>報告理由</h3>
                        <div class="moderation-content-evidence">${escapeHTML(report.description || '説明は添付されていません。')}</div>
                    </section>
                    ${evidence}
                    <section class="moderation-review-section">
                        <h3>対応</h3>
                        <p class="moderation-help-text">報告者の情報は表示されません。何も選択せずに完了すると、対応なしとして報告者へ通知します。</p>
                        <form id="moderation-resolution-form" data-report-id="${Number(report.id)}" data-target-kind="${escapeHTML(report.target_kind)}">
                            ${selectableUsers.length > 0 ? `<div class="moderation-action-field"><label for="moderation-target-user">対応対象ユーザー</label><select id="moderation-target-user" class="moderation-target-select"><option value="">選択してください</option>${targetOptions}</select></div>` : ''}
                            <div class="moderation-action-grid">
                                ${report.target_kind === 'post' ? '<label><input id="moderation-delete-post" type="checkbox"> 該当ポストを削除</label>' : ''}
                                <label><input id="moderation-search-exclude" type="checkbox"> 検索から除外</label>
                                <label><input id="moderation-freeze" type="checkbox"> アカウントを凍結</label>
                            </div>
                            <div class="moderation-action-field"><label for="moderation-freeze-reason">凍結理由</label><input id="moderation-freeze-reason" class="moderation-target-select" type="text" maxlength="2000" placeholder="凍結する場合のみ入力"></div>
                            <div class="moderation-action-field"><label for="moderation-notice">対象ユーザーへの通知</label><textarea id="moderation-notice" class="moderation-textarea" maxlength="2000" rows="4" placeholder="任意の通知本文"></textarea></div>
                            <div class="moderation-form-actions"><button type="submit" class="moderation-submit-button">対応を完了する</button></div>
                            <p id="moderation-resolution-error" class="login-modal-message login-modal-error hidden" role="alert"></p>
                        </form>
                    </section>
                </div>`;
            const form = document.getElementById('moderation-resolution-form');
            form?.addEventListener('submit', async (event) => {
                event.preventDefault();
                const errorElement = document.getElementById(
                    'moderation-resolution-error',
                );
                const targetUserId =
                    document.getElementById('moderation-target-user')?.value ||
                    null;
                const actions = {
                    deletePost: Boolean(
                        document.getElementById('moderation-delete-post')
                            ?.checked,
                    ),
                    searchExclude: Boolean(
                        document.getElementById('moderation-search-exclude')
                            ?.checked,
                    ),
                    freeze: Boolean(
                        document.getElementById('moderation-freeze')?.checked,
                    ),
                    freezeReason:
                        document.getElementById('moderation-freeze-reason')
                            ?.value || '',
                    notice:
                        document.getElementById('moderation-notice')?.value ||
                        '',
                    targetUserId: targetUserId ? Number(targetUserId) : null,
                };
                const requiresTarget =
                    actions.searchExclude ||
                    actions.freeze ||
                    actions.notice.trim();
                if (requiresTarget && !actions.targetUserId) {
                    errorElement.textContent =
                        '対応対象ユーザーを選択してください。';
                    errorElement.classList.remove('hidden');
                    return;
                }
                const submit = form.querySelector('button[type="submit"]');
                submit.disabled = true;
                errorElement.classList.add('hidden');
                const { error: resolveError } = await apiRequest(
                    `/server/api/reports/${Number(report.id)}/resolve`,
                    {
                        method: 'POST',
                        body: { actions },
                    },
                );
                submit.disabled = false;
                if (resolveError) {
                    errorElement.textContent =
                        resolveError.message || '対応を完了できませんでした。';
                    errorElement.classList.remove('hidden');
                    return;
                }
                await showAppAlert('報告への対応を完了しました。');
                window.location.hash = '#admin/reports';
            });
        } catch (error) {
            console.error('報告詳細の取得に失敗:', error);
            contentDiv.innerHTML =
                '<div class="admin-reports-container"><p class="error-message">報告詳細の取得に失敗しました。</p></div>';
        } finally {
            showLoading(false);
        }
    }

    async function showAdminLogsScreen() {
        DOM.pageHeader.innerHTML = `
	            <div class="header-with-back-button">
	                <button class="header-back-btn" data-action="history-back">${ICONS.back}</button>
	                <h2 id="page-title">アクセスログ</h2>
	            </div>`;
        showScreen('admin-logs-screen');
        const contentDiv = document.getElementById('admin-logs-content');
        contentDiv.innerHTML = ''; // 表示前にクリア

        setIsLoadingMore(false);
        const LOGS_PER_PAGE = 30;
        let currentPage = 0;
        let hasMore = true;

        // 無限スクロールのトリガー要素
        const trigger = document.createElement('div');
        trigger.className = 'load-more-trigger';
        contentDiv.appendChild(trigger);

        const loadMoreLogs = async () => {
            if (getIsLoadingMore() || !hasMore) return;
            setIsLoadingMore(true);
            trigger.innerHTML = '<div class="spinner"></div>';

            const offset = currentPage * LOGS_PER_PAGE;
            const { data, error } = await api.rpc('get_logs_with_masked_ip', {
                p_limit: LOGS_PER_PAGE,
                p_offset: offset,
            });

            if (error) {
                console.error('ログの取得に失敗:', error);
                trigger.innerHTML = `<p class="error-message">${escapeHTML(error.message)}</p>`;
                hasMore = false;
                setIsLoadingMore(false);
                return;
            }

            if (data && data.length > 0) {
                data.forEach((log) => {
                    const logItem = document.createElement('div');
                    logItem.className = 'widget-item'; // 通知と似たスタイルを流用
                    logItem.style.cssText =
                        'display: flex; flex-direction: column; gap: 0.25rem;';

                    logItem.innerHTML = `
	                        <div>
	                            <strong>SCID:</strong> ${escapeHTML(log.scratch_id)} (#${log.nyaitter_id})
	                        </div>
	                        <div style="font-size: 0.9rem; color: var(--secondary-text-color);">
	                            ${new Date(log.log_time).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}
	                        </div>
	                        <div style="font-size: 0.8rem; color: var(--secondary-text-color); font-family: monospace; word-break: break-all;">
	                            識別子: ${log.masked_ip_uuid}
	                        </div>
	                    `;
                    // トリガー要素の直前に新しいログアイテムを挿入
                    contentDiv.insertBefore(logItem, trigger);
                });
                currentPage++;
            }

            if (!data || data.length < LOGS_PER_PAGE) {
                hasMore = false;
                trigger.innerHTML =
                    contentDiv.children.length > 1
                        ? 'すべてのログを読み込みました'
                        : 'ログはまだありません。';
                if (getPostLoadObserver()) getPostLoadObserver().disconnect();
            } else {
                trigger.innerHTML = '';
            }
            setIsLoadingMore(false);
        };

        // IntersectionObserverを設定して無限スクロールを実装
        setPostLoadObserver(
            new IntersectionObserver(
                (entries) => {
                    if (entries[0].isIntersecting) {
                        loadMoreLogs();
                    }
                },
                { rootMargin: '200px' },
            ),
        );

        getPostLoadObserver().observe(trigger);
        showLoading(false); // 初回のローディング表示を解除
    }

    async function fetchOptimizedPostPage(
        type,
        options,
        page,
        beforeCursor = null,
    ) {
        const params = new URLSearchParams({
            limit: String(POSTS_PER_PAGE),
            offset: String(page * POSTS_PER_PAGE),
        });
        if (beforeCursor != null) {
            params.set('before_id', String(beforeCursor));
            params.delete('offset');
        }
        let showPinPost = false;

        if (type === 'timeline') {
            if (options.tab === 'foryou') {
                params.set('mode', 'recommended');
            } else {
                params.set('mode', 'timeline');
                params.set('tab', options.tab || 'following');
            }
        } else if (type === 'search') {
            params.set('mode', 'search');
            params.set('q', options.query || '');
        } else if (type === 'profile_posts') {
            params.set('mode', 'profile');
            params.set('user_id', String(options.userId || ''));
            params.set('sub_type', options.subType || 'all');
            if (
                options.pinId &&
                page === 0 &&
                options.subType === 'posts_only'
            ) {
                params.set('pin_id', String(options.pinId));
                showPinPost = true;
            }
        } else if (type === 'likes' || type === 'stars') {
            const from = page * POSTS_PER_PAGE;
            if (options.userId) {
                const { data, error } = await apiRequest(
                    `/server/api/users/${encodeURIComponent(options.userId)}/${type}?limit=${POSTS_PER_PAGE}&offset=${from}`,
                );
                if (error) throw error;
                return {
                    posts: data.posts || [],
                    hasMore: !!data.has_more,
                    nextCursor: data.next_cursor ?? null,
                    showPinPost: false,
                    context: null,
                };
            }
            const ids = [...(options.ids || [])].reverse();
            const pageIds = ids.slice(from, from + POSTS_PER_PAGE);
            params.set('mode', 'ids');
            params.set('ids', pageIds.join(','));
            params.set('offset', '0');
            const { data, error } = await apiRequest(
                `/server/api/posts/page?${params.toString()}`,
            );
            if (error) throw error;
            return {
                posts: data.posts || [],
                hasMore: ids.length > from + POSTS_PER_PAGE,
                nextCursor: null,
                showPinPost: false,
                context: data.context || null,
            };
        } else {
            return null;
        }

        const { data, error } = await apiRequest(
            `/server/api/posts/page?${params.toString()}`,
        );
        if (error) throw error;
        return {
            posts: data.posts || [],
            hasMore: !!data.has_more,
            nextCursor: data.next_cursor ?? null,
            showPinPost,
            context: data.context || null,
        };
    }

    async function loadPostsWithPagination(container, type, options = {}) {
        let localPostLoadObserver;
        const postPageCache = options.pageCache || null;
        setCurrentPagination({ page: 0, hasMore: true, type, options });

        const trigger = document.createElement('div');
        trigger.className = 'load-more-trigger';
        container.appendChild(trigger);

        const loadMore = async () => {
            if (getIsLoadingMore() || !getCurrentPagination().hasMore) return;

            const currentTrigger =
                container.querySelector('.load-more-trigger');
            if (!currentTrigger) {
                if (localPostLoadObserver) localPostLoadObserver.disconnect();
                return;
            }

            setIsLoadingMore(true);
            currentTrigger.innerHTML = '<div class="spinner"></div>';

            let posterror = null;

            load_btn.classList.add('hide');

            try {
                const pageNumber = getCurrentPagination().page;
                let optimizedPage = postPageCache?.pages.get(pageNumber);
                if (!optimizedPage) {
                    const previousPage =
                        pageNumber > 0
                            ? postPageCache?.pages.get(pageNumber - 1)
                            : null;
                    optimizedPage = await fetchOptimizedPostPage(
                        type,
                        options,
                        pageNumber,
                        previousPage?.nextCursor ?? null,
                    );
                    if (postPageCache && optimizedPage)
                        savePostPageCache(
                            postPageCache,
                            pageNumber,
                            optimizedPage,
                        );
                }
                let posts = optimizedPage?.posts || [];
                let hasMoreItems = optimizedPage?.hasMore ?? true;
                let showPinPost = optimizedPage?.showPinPost || false;
                const pageContext = optimizedPage?.context || null;
                let doprofile = false;

                if (!optimizedPage) {
                    if (
                        (type === 'timeline' && options.tab === 'foryou') ||
                        type === 'search'
                    ) {
                        const rpcName =
                            type === 'search'
                                ? 'search_posts'
                                : 'get_recommended_posts';
                        const rpcParams =
                            type === 'search'
                                ? {
                                      query: options.query,
                                      page_size: POSTS_PER_PAGE,
                                      page_num: getCurrentPagination().page,
                                  }
                                : {
                                      p_user_id: getCurrentUser()?.id || null,
                                      page_size: POSTS_PER_PAGE,
                                      page_num: getCurrentPagination().page,
                                  };

                        const { data: rpcResult, error } = await api
                            .rpc(rpcName, rpcParams)
                            .single();
                        if (error) throw error;

                        posts = rpcResult.posts || [];
                        hasMoreItems = rpcResult.has_next || false;
                    } else {
                        const from =
                            getCurrentPagination().page * POSTS_PER_PAGE;
                        const to = from + POSTS_PER_PAGE - 1;

                        let postIdsToFetch = [];
                        let idQuery;

                        if (type === 'timeline') {
                            idQuery = api.from('post_recent').select('id');
                            if (options.tab === 'following') {
                                if (getCurrentUser()?.follow?.length > 0) {
                                    idQuery = idQuery.in(
                                        'userid',
                                        getCurrentUser().follow,
                                    );
                                } else {
                                    hasMoreItems = false;
                                }
                            } else if (options.tab === 'announce') {
                                idQuery = api
                                    .from('post')
                                    .select('id')
                                    .eq('announcement', true)
                                    .is('reply_id', null)
                                    .order('time', { ascending: false });
                            }
                        } else if (type === 'profile_posts') {
                            doprofile = true;
                            if (!options.userId) {
                                hasMoreItems = false;
                            } else {
                                idQuery = api
                                    .from('post_profile')
                                    .select('id')
                                    .eq('userid', options.userId);
                                if (options.subType === 'posts_only') {
                                    idQuery = idQuery.is('reply_id', null);
                                    if (
                                        options.pinId &&
                                        getCurrentPagination().page === 0
                                    ) {
                                        showPinPost = true;
                                    }
                                } else if (options.subType === 'replies_only') {
                                    idQuery = idQuery.not(
                                        'reply_id',
                                        'is',
                                        null,
                                    );
                                }
                            }
                        } else if (type === 'likes' || type === 'stars') {
                            const idList = options.ids || [];
                            const reversedList = [...idList].reverse();
                            postIdsToFetch = reversedList.slice(from, to + 1);
                            if (postIdsToFetch.length < POSTS_PER_PAGE) {
                                hasMoreItems = false;
                            }
                        }

                        if (idQuery && hasMoreItems) {
                            const { data: idData, error: idError } =
                                await idQuery.range(from, to);
                            if (idError) throw idError;
                            postIdsToFetch = idData.map((p) => p.id);
                            if (
                                showPinPost &&
                                !postIdsToFetch.includes(options.pinId)
                            ) {
                                postIdsToFetch.push(options.pinId);
                            }
                            if (idData.length < POSTS_PER_PAGE) {
                                hasMoreItems = false;
                            }
                        }

                        if (postIdsToFetch.length > 0) {
                            const {
                                data: hydratedPosts,
                                error: hydratedError,
                            } = await api.rpc('get_hydrated_posts', {
                                p_post_ids: postIdsToFetch,
                                p_profile: doprofile,
                            });
                            if (hydratedError) throw hydratedError;
                            const idOrderMap = new Map(
                                postIdsToFetch.map((id, index) => [id, index]),
                            );
                            posts = hydratedPosts.sort(
                                (a, b) =>
                                    idOrderMap.get(a.id) - idOrderMap.get(b.id),
                            );
                        }
                    }
                }

                if (!container.querySelector('.load-more-trigger')) return;

                if (posts && posts.length > 0) {
                    for (const user of pageContext?.users || []) {
                        getAllUsersCache().set(user.id, user);
                    }
                    posts = filterBlockedPosts(posts);

                    // 投稿ページAPIは反応数・自分の反応状態をすでに含む。

                    const metricsPromise = Promise.resolve();

                    // 全投稿のcontent内のメンションをキャッシュ
                    await ensureMentionedUsersCached(
                        posts.map((post) => post.content),
                    );

                    if (showPinPost) {
                        const pinPost = posts.find(
                            (p) => p.id === options.pinId,
                        );
                        if (pinPost) {
                            const postEl = await renderPost(
                                pinPost,
                                pinPost.author,
                                {
                                    userCache: getAllUsersCache(),
                                    metricsPromise,
                                    isPinned: true,
                                    clampHeight: true,
                                },
                            );
                            if (postEl) currentTrigger.before(postEl);
                        }
                    }
                    // 投稿レンダリング
                    for (const post of posts) {
                        if (showPinPost && post.id === options.pinId) continue; // ピン留めポストはすでに表示済みのためスキップ
                        const postEl = await renderPost(post, post.author, {
                            userCache: getAllUsersCache(),
                            metricsPromise,
                            clampHeight: true,
                        });
                        if (postEl) currentTrigger.before(postEl);
                    }
                }

                getCurrentPagination().page++;
                getCurrentPagination().hasMore = hasMoreItems;
            } catch (error) {
                posterror = error;
                console.error('ポストの読み込みに失敗:', error);
                currentTrigger.innerText = 'ポストの読み込みに失敗しました。';
                getCurrentPagination().hasMore = false;
                if (localPostLoadObserver) localPostLoadObserver.disconnect();
                load_btn.remove();
            } finally {
                load_btn.classList.remove('hide');

                setIsLoadingMore(false);
                const finalTrigger =
                    container.querySelector('.load-more-trigger');
                if (!finalTrigger) return;

                if (!posterror) {
                    const emptyMessages = {
                        timeline: 'まだポストがありません。',
                        profile_posts: 'このユーザーはまだポストしていません。',
                        replies: 'まだ返信はありません。',
                        search: '該当するポストはありません。',
                        likes: 'いいねしたポストはありません。',
                        stars: 'お気に入りに登録したポストはありません。',
                    };
                    const emptyMessageKey =
                        options.subType === 'replies_only' ? 'replies' : type;

                    if (!getCurrentPagination().hasMore) {
                        load_btn.remove();
                        finalTrigger.innerText =
                            container.querySelectorAll('.post').length === 0
                                ? emptyMessages[emptyMessageKey] || ''
                                : 'すべてのポストを読み込みました';
                        if (localPostLoadObserver)
                            localPostLoadObserver.disconnect();
                    } else if (finalTrigger.innerHTML.includes('spinner')) {
                        finalTrigger.innerHTML = '';
                    }
                }
            }
        };

        localPostLoadObserver = new IntersectionObserver(
            (entries) => {
                if (entries[0].isIntersecting && !getIsLoadingMore()) {
                    loadMore();
                }
            },
            { rootMargin: '200px' },
        );

        const load_btn = document.createElement('button');
        load_btn.className = 'load-more-btn';
        load_btn.textContent = '更に読み込む';
        load_btn.addEventListener('click', loadMore);
        trigger.after(load_btn);

        await loadMore();
        if (getCurrentPagination().hasMore)
            localPostLoadObserver.observe(trigger);
    }

    async function loadUsersWithPagination(container, type, options = {}) {
        const userPageCache = options.pageCache || null;
        const pageSize = Number(options.pageSize) || POSTS_PER_PAGE;
        setCurrentPagination({ page: 0, hasMore: true, type, options });

        let trigger = container.querySelector('.load-more-trigger');
        if (trigger) trigger.remove();

        trigger = document.createElement('div');
        trigger.className = 'load-more-trigger';
        container.appendChild(trigger);

        const _contributors = await contributors;

        const renderUserCard = (u) => {
            const userCard = document.createElement('div');
            userCard.className = 'profile-card widget-item';

            const userLink = document.createElement('a');
            userLink.href = `#profile/${u.id}`;
            userLink.className = 'profile-link';
            userLink.style.cssText =
                'display:flex; align-items:center; gap:0.8rem; text-decoration:none; color:inherit;';

            const badgeHTML = u.admin
                ? ` <img src="icons/admin.png" class="admin-badge" title="NyaitterTeam">`
                : _contributors.includes(u.id)
                  ? ` <img src="icons/contributor.png" class="contributor-badge" title="開発協力者">`
                  : u.verify
                    ? ` <img src="icons/verify.png" class="verify-badge" title="認証済み">`
                    : '';

            userLink.innerHTML = `
	                <img src="${getUserIconUrl(u)}" style="width:48px; height:48px; border-radius:50%;" alt="${escapeHTML(u.name)}'s icon">
	                <div>
	                    <span class="name" style="font-weight:700;">${getEmoji(escapeHTML(u.name))}${badgeHTML}</span>
					<span class="id" style="color:var(--secondary-text-color);">${getNyaitterId(u)}</span>
	                    <p class="me" style="margin:0.2rem 0 0;">${getEmoji(escapeHTML(u.me || ''))}</p>
	                </div>`;

            userCard.appendChild(userLink);
            return userCard;
        };

        const loadMore = async () => {
            if (getIsLoadingMore() || !getCurrentPagination().hasMore) return;
            setIsLoadingMore(true);
            trigger.innerHTML = '<div class="spinner"></div>';

            const from = getCurrentPagination().page * pageSize;
            // 検索では1件多く取得して、次ページの有無を余分な通信なしで判断する。
            const to = from + pageSize - 1 + (type === 'search' ? 1 : 0);

            let users = [];
            let error = null;
            let hasMoreForPage = true;
            const pageNumber = getCurrentPagination().page;
            const cachedPage = userPageCache?.pages.get(pageNumber);

            if (cachedPage) {
                users = Array.isArray(cachedPage.users) ? cachedPage.users : [];
                hasMoreForPage = Boolean(cachedPage.hasMore);
            } else {
                const selectColumns =
                    'id, name, me, scid, icon_data, admin, verify';

                if (type === 'follows') {
                    if (options.userId) {
                        const result = await apiRequest(
                            `/server/api/users/${encodeURIComponent(options.userId)}/following?limit=${POSTS_PER_PAGE}&offset=${from}`,
                        );
                        users = Array.isArray(result.data?.following)
                            ? result.data.following
                            : [];
                        error = result.error;
                    } else {
                        const idsToFetch = (options.ids || []).slice(
                            from,
                            to + 1,
                        );
                        if (idsToFetch.length > 0) {
                            const result = await api
                                .from('user')
                                .select(selectColumns)
                                .in('id', idsToFetch);
                            users = result.data;
                            error = result.error;
                        }
                    }
                } else if (type === 'followers') {
                    const result = await apiRequest(
                        `/server/api/users/${encodeURIComponent(options.userId)}/followers?limit=${pageSize}&offset=${from}`,
                    );
                    users = Array.isArray(result.data?.followers)
                        ? result.data.followers
                        : [];
                    error = result.error;
                } else if (type === 'search') {
                    const result = await api
                        .from('user')
                        .select(selectColumns)
                        .or(options.filters || '')
                        .order('id', { ascending: true })
                        .range(from, to);
                    users = Array.isArray(result.data) ? result.data : [];
                    error = result.error;
                    hasMoreForPage = users.length > pageSize;
                    users = users.slice(0, pageSize);
                    if (typeof options.sortResults === 'function') {
                        users.sort(options.sortResults);
                    }
                }
                if (type !== 'search')
                    hasMoreForPage = users.length >= pageSize;
                if (!error && userPageCache)
                    savePostPageCache(userPageCache, pageNumber, {
                        users,
                        hasMore: hasMoreForPage,
                    });
            }

            if (
                typeof options.isCurrent === 'function' &&
                !options.isCurrent()
            ) {
                setIsLoadingMore(false);
                return;
            }

            if (error) {
                console.error(`${type}のユーザー読み込みに失敗:`, error);
                trigger.innerHTML = '読み込みに失敗しました。';
            } else {
                if (users && users.length > 0) {
                    users.forEach((u) =>
                        container.insertBefore(renderUserCard(u), trigger),
                    );
                    getCurrentPagination().page++;
                    if (!hasMoreForPage) {
                        getCurrentPagination().hasMore = false;
                    }
                } else {
                    getCurrentPagination().hasMore = false;
                }

                if (!getCurrentPagination().hasMore) {
                    const emptyMessages = {
                        follows: '誰もフォローしていません。',
                        followers: 'まだフォロワーがいません。',
                        search: 'ユーザーは見つかりませんでした。',
                    };
                    trigger.innerHTML =
                        container.querySelectorAll('.profile-card').length === 0
                            ? emptyMessages[type]
                            : 'すべてのユーザーを読み込みました';
                    if (getPostLoadObserver())
                        getPostLoadObserver().unobserve(trigger);
                } else {
                    trigger.innerHTML = '';
                }
            }
            setIsLoadingMore(false);
        };

        setPostLoadObserver(
            new IntersectionObserver(
                (entries) => {
                    if (entries[0].isIntersecting && !getIsLoadingMore()) {
                        loadMore();
                    }
                },
                { rootMargin: '200px' },
            ),
        );

        await loadMore();
        if (getCurrentPagination().hasMore)
            getPostLoadObserver().observe(trigger);
    }

    async function loadMediaGrid(container, options = {}) {
        setCurrentPagination({
            page: 0,
            hasMore: true,
            type: 'media',
            options,
        });

        // グリッド用のコンテナを作成
        const gridContainer = document.createElement('div');
        gridContainer.className = 'media-grid-container';
        container.appendChild(gridContainer);

        let trigger = container.querySelector('.load-more-trigger');
        if (trigger) trigger.remove();

        trigger = document.createElement('div');
        trigger.className = 'load-more-trigger';
        container.appendChild(trigger);

        const MEDIA_PER_PAGE = 15; // メディアタブ専用の表示数

        const loadMore = async () => {
            if (getIsLoadingMore() || !getCurrentPagination().hasMore) return;
            setIsLoadingMore(true);
            trigger.innerHTML = '<div class="spinner"></div>';

            const from = getCurrentPagination().page * MEDIA_PER_PAGE;
            const to = from + MEDIA_PER_PAGE - 1;

            const { data: mediaResponse, error } = await apiRequest(
                `/server/api/users/${encodeURIComponent(options.userId)}/media?limit=${MEDIA_PER_PAGE}&offset=${from}`,
            );
            const mediaItems = Array.isArray(mediaResponse?.media_items)
                ? mediaResponse.media_items
                : [];

            if (error) {
                console.error('メディアの読み込みに失敗:', error);
                trigger.innerHTML = '読み込みに失敗しました。';
            } else {
                if (mediaItems && mediaItems.length > 0) {
                    for (const item of mediaItems) {
                        const { data: publicUrlData } = api.storage
                            .from('nyaitter')
                            .getPublicUrl(item.file_id);

                        const itemLink = document.createElement('a');
                        itemLink.href = `#post/${item.post_id}`;
                        itemLink.className = 'media-grid-item';

                        if (item.file_type === 'image') {
                            itemLink.innerHTML = `<img src="${escapeHTML(publicUrlData.publicUrl)}" loading="lazy" alt="投稿メディア">`;
                        } else if (item.file_type === 'video') {
                            itemLink.innerHTML = `<video src="${escapeHTML(publicUrlData.publicUrl)}" muted playsinline loading="lazy"></video>`;
                        }
                        gridContainer.appendChild(itemLink);
                    }

                    getCurrentPagination().page++;
                    if (mediaItems.length < MEDIA_PER_PAGE) {
                        getCurrentPagination().hasMore = false;
                    }
                } else {
                    getCurrentPagination().hasMore = false;
                }

                if (!getCurrentPagination().hasMore) {
                    trigger.innerHTML = gridContainer.hasChildNodes()
                        ? ''
                        : 'メディアはありません。';
                    if (getPostLoadObserver())
                        getPostLoadObserver().unobserve(trigger);
                } else {
                    trigger.innerHTML = '';
                }
            }
            setIsLoadingMore(false);
        };

        setPostLoadObserver(
            new IntersectionObserver(
                (entries) => {
                    if (entries[0].isIntersecting && !getIsLoadingMore()) {
                        loadMore();
                    }
                },
                { rootMargin: '200px' },
            ),
        );

        await loadMore();
        if (getCurrentPagination().hasMore)
            getPostLoadObserver().observe(trigger);
    }

    async function switchTimelineTab(
        tab,
        { forceRefresh = false, resetScroll = false } = {},
    ) {
        if (tab === 'following' && !getCurrentUser()) return;
        if (resetScroll) {
            window.scrollTo({ left: 0, top: 0, behavior: 'auto' });
            saveScrollPosition(activeScrollRouteKey);
        }
        setIsLoadingMore(false); // 読み込み状態をリセット
        setCurrentTimelineTab(tab);
        document
            .querySelectorAll('.timeline-tab-button')
            .forEach((btn) =>
                btn.classList.toggle('active', btn.dataset.tab === tab),
            );

        if (getPostLoadObserver()) getPostLoadObserver().disconnect();
        DOM.timeline.innerHTML = '';
        await loadPostsWithPagination(DOM.timeline, 'timeline', {
            tab,
            pageCache: getTimelinePageCache(tab, { forceRefresh }),
        });
    }

    function requestSettingsSave(
        form = document.getElementById('settings-form'),
    ) {
        if (!getCurrentUser() || !form) return;
        if (getSettingsSaveInFlight()) {
            setSettingsSaveQueued(true);
            return;
        }
        void saveSettings(form);
    }

    async function saveSettings(form) {
        if (!getCurrentUser() || !form) return;
        if (!form.reportValidity()) {
            return;
        }

        setSettingsSaveInFlight(true);

        try {
            const updatedData = {
                name: form.querySelector('#setting-username').value.trim(),
                me: form.querySelector('#setting-me').value.trim(),
                settings: {
                    lock: form.querySelector('#setting-lock').checked,
                    show_like: form.querySelector('#setting-show-like').checked,
                    show_follow: form.querySelector('#setting-show-follow')
                        .checked,
                    show_follower: form.querySelector('#setting-show-follower')
                        .checked,
                    show_star: form.querySelector('#setting-show-star').checked,
                    show_scid: form.querySelector('#setting-show-scid').checked,
                    reject_unknown_login: form.querySelector(
                        '#setting-reject-unknown-login',
                    ).checked,
                    default_timeline_tab: form.querySelector(
                        '#setting-default-timeline',
                    ).value,
                    post_timestamp_format: normalizePostTimestampFormat(
                        form.querySelector('#setting-post-timestamp-format')
                            .value,
                    ),
                    emoji: form.querySelector('#setting-emoji-kind').value,
                    content_editor:
                        form.querySelector('#setting-content-editor').value ===
                        'nyaitter'
                            ? 'nyaitter'
                            : 'textarea',
                    theme: form.querySelector('#setting-theme').value,
                    color_theme: normalizeColorTheme(
                        form.querySelector('#setting-color-theme').value,
                    ),
                    custom_colors: getCustomColorsFromInputs(form),
                },
            };
            if (!updatedData.name) throw new Error('ユーザー名は必須です。');

            // data: URLはプレビュー用途に限定し、同一オリジンのアップロードAPIへFileとして送る。
            const previousStoredFileIds = new Set();
            const uploadedFileIds = [];
            const previousStoredIconId =
                typeof getCurrentUser().icon_data === 'string' &&
                !getCurrentUser().icon_data.startsWith('data:image')
                    ? getCurrentUser().icon_data
                    : null;
            const previousStoredHeaderId =
                typeof getCurrentUser().header_image === 'string' &&
                !getCurrentUser().header_image.startsWith('data:image')
                    ? getCurrentUser().header_image
                    : null;

            try {
                if (getResetIconToDefault()) {
                    updatedData.icon_data = null;
                    if (previousStoredIconId)
                        previousStoredFileIds.add(previousStoredIconId);
                } else if (getNewIconDataUrl()) {
                    const fileId = await uploadFileViaEdgeFunction(
                        imageDataUrlToFile(getNewIconDataUrl()),
                    );
                    uploadedFileIds.push(fileId);
                    updatedData.icon_data = fileId;
                    if (previousStoredIconId)
                        previousStoredFileIds.add(previousStoredIconId);
                }
                if (getResetHeaderToDefault()) {
                    updatedData.header_image = null;
                    if (previousStoredHeaderId)
                        previousStoredFileIds.add(previousStoredHeaderId);
                } else if (getNewHeaderDataUrl()) {
                    const fileId = await uploadFileViaEdgeFunction(
                        imageDataUrlToFile(getNewHeaderDataUrl()),
                    );
                    uploadedFileIds.push(fileId);
                    updatedData.header_image = fileId;
                    if (previousStoredHeaderId)
                        previousStoredFileIds.add(previousStoredHeaderId);
                }
            } catch (error) {
                if (uploadedFileIds.length > 0)
                    await deleteFilesViaEdgeFunction(uploadedFileIds);
                throw error;
            }

            let data;
            try {
                const response = await api
                    .from('user')
                    .update(updatedData)
                    .select()
                    .single();
                data = response.data;
                if (response.error) throw response.error;
            } catch (error) {
                if (uploadedFileIds.length > 0)
                    await deleteFilesViaEdgeFunction(uploadedFileIds);
                throw error;
            }
            if (previousStoredFileIds.size > 0) {
                await deleteFilesViaEdgeFunction([...previousStoredFileIds]);
            }

            setCurrentUser(data);
            updateAccountData(getCurrentUser());
            applyInterfaceTheme(getCurrentUser().settings?.theme || 'light');
            applyColorTheme(getCurrentUser().settings || {});
            refreshMarkdownContentEditors();
            await updateNavAndSidebars();
            setNewIconDataUrl(null);
            setResetIconToDefault(false);
            setNewHeaderDataUrl(null);
            setResetHeaderToDefault(false);
        } catch (error) {
            console.error('設定の自動保存に失敗:', error);
        } finally {
            setSettingsSaveInFlight(false);
            if (getSettingsSaveQueued()) {
                setSettingsSaveQueued(false);
                requestSettingsSave(form);
            }
        }
    }

    window.copyPost = async (postId, button) => {
        await navigator.clipboard.writeText(
            `${window.location.origin}/#post/${postId}`,
        );
        if (button) {
            button.innerText = `コピーしました!`;
        }
    };
    window.pinPost = async (postId) => {
        let cmessage, emessage;

        if (!getCurrentUser()) return showAppAlert('ログインが必要です。');
        if (!getCurrentUser().pin || getCurrentUser().pin !== postId) {
            cmessage = 'このポストをピン留めしますか?';
            emessage = 'ポストのピン留め';
        } else {
            cmessage = 'このポストのピン留めを解除しますか?';
            emessage = 'ポストのピン留めの解除';
        }
        if (!(await showAppConfirm(cmessage))) return;
        showLoading(true);
        try {
            const { data: pinId, error: fetchError } = await api.rpc(
                'handle_pin',
                { p_post_id: postId },
            );
            if (fetchError)
                throw new Error(
                    `ポストのピン留め処理に失敗: ${fetchError.message}`,
                );
            getCurrentUser().pin = pinId;
            invalidateTimelinePageCache();
            router();
        } catch (e) {
            console.error(e);
            showAppAlert(`${emessage}に失敗しました。`);
        } finally {
            showLoading(false);
        }
    };
    window.deletePost = async (postId) => {
        if (!getCurrentUser()) return showAppAlert('ログインが必要です。');
        if (!(await showAppConfirm('このポストを削除しますか?'))) return;
        showLoading(true);
        try {
            const { data: postData, error: fetchError } = await api
                .from('post')
                .select('attachments')
                .eq('id', postId)
                .single();
            if (fetchError)
                throw new Error(
                    `ポスト情報の取得に失敗: ${fetchError.message}`,
                );

            if (postData.attachments && postData.attachments.length > 0) {
                const fileIds = postData.attachments.map((file) => file.id);
                await deleteFilesViaEdgeFunction(fileIds);
            }

            const { error: deleteError } = await api
                .from('post')
                .delete()
                .eq('id', postId);
            if (deleteError) throw deleteError;

            invalidateTimelinePageCache();
            router();
        } catch (e) {
            console.error(e);
            showAppAlert('削除に失敗しました。');
        } finally {
            showLoading(false);
        }
    };
    window.handleReplyClick = (postId, username) => {
        if (!getCurrentUser()) return showAppAlert('ログインが必要です。');
        openPostModal({ id: postId, name: username });
    };
    window.handleLike = async (button, postId) => {
        if (!getCurrentUser()) return showAppAlert('ログインが必要です。');
        button.disabled = true;

        const countSpan = button.querySelector('span:not(.icon)');
        const currentCount = parseInt(countSpan.textContent);

        try {
            const { data, error } = await api.rpc('handle_like', {
                p_post_id: postId,
            });

            if (error) throw error;

            const isLiked = data.liked;
            getCurrentUser().like = data.updated_likes;
            invalidateTimelinePageCache();

            countSpan.textContent = isLiked
                ? currentCount + 1
                : currentCount - 1;
            button.classList.toggle('liked', isLiked);
        } catch (e) {
            console.error('いいね更新エラー:', e);
            showAppAlert('いいねの更新に失敗しました。');
        } finally {
            button.disabled = false;
        }
    };
    window.handleStar = async (button, postId) => {
        if (!getCurrentUser()) return showAppAlert('ログインが必要です。');
        button.disabled = true;

        const countSpan = button.querySelector('span:not(.icon)');
        const currentCount = parseInt(countSpan.textContent);

        try {
            const { data, error } = await api.rpc('handle_star', {
                p_post_id: postId,
            });

            if (error) throw error;

            const isStarred = data.starred;
            getCurrentUser().star = data.updated_stars;
            invalidateTimelinePageCache();

            countSpan.textContent = isStarred
                ? currentCount + 1
                : currentCount - 1;
            button.classList.toggle('starred', isStarred);
        } catch (e) {
            console.error('お気に入り更新エラー:', e);
            showAppAlert('お気に入りの更新に失敗しました。');
        } finally {
            button.disabled = false;
        }
    };
    window.handleShowMaskedPost = async (button) => {
        button.disabled = true;

        const postMain = button.parentElement;
        const postMaskTitle = postMain.querySelector('.post-mask-title');

        if (postMaskTitle) postMaskTitle.remove();
        button.remove();

        const postContent = postMain.querySelector('.post-content');
        const postAttach = postMain.querySelector('.attachments-container');

        if (postAttach) postAttach.classList.remove('hidden');
        if (postContent) postContent.classList.remove('hidden');
    };
    window.handleFollowToggle = async (targetUserId, button, isLock) => {
        if (!getCurrentUser()) return showAppAlert('ログインが必要です。');
        button.disabled = true;

        try {
            const { data, error } = await api.rpc('handle_follow', {
                p_target_id: targetUserId,
            });

            if (error) throw error;

            const isFollowing = data.following;
            getCurrentUser().follow = data.updated_follows;
            invalidateTimelinePageCache();

            updateFollowButtonState(button, isFollowing, isLock);

            // フォロワー数を再取得（既存RPC呼び出しを継続利用）
            const followerCountSpan = document.querySelector(
                '#follower-count strong',
            );
            if (followerCountSpan) {
                const { data: newCount, error: newCountError } = await api.rpc(
                    'get_follower_count',
                    {
                        target_user_id: targetUserId,
                    },
                );
                followerCountSpan.textContent = !newCountError ? newCount : '?';
            }
        } catch (e) {
            console.error('フォロー更新エラー:', e);
            showAppAlert('フォロー状態の更新に失敗しました。');
        } finally {
            button.disabled = false;
        }
    };

    async function openEditPostModal(postId) {
        showLoading(true);
        try {
            const { data: post, error } = await api
                .from('post')
                .select('content, mask,  attachments')
                .eq('id', postId)
                .single();
            if (error || !post)
                throw new Error('ポスト情報の取得に失敗しました。');

            let currentAttachments = post.attachments || [];
            let filesToDelete = new Set();
            let filesToAdd = [];

            const renderAttachments = () => {
                let existingAttachmentsHTML = '';
                currentAttachments.forEach((attachment, index) => {
                    if (filesToDelete.has(attachment.id)) return;
                    existingAttachmentsHTML += `
	                        <div class="file-preview-item">
	                            <span>${attachment.type === 'image' ? '🖼️' : '📎'} ${escapeHTML(attachment.name)}</span>
	                            <button class="file-preview-remove" data-id="${escapeHTML(String(attachment.id))}" data-type="existing">×</button>
	                        </div>`;
                });

                let newAttachmentsHTML = '';
                filesToAdd.forEach((file, index) => {
                    newAttachmentsHTML += `
	                        <div class="file-preview-item">
	                            <span>${file.type.startsWith('image/') ? '🖼️' : '📎'} ${escapeHTML(file.name)}</span>
	                            <button class="file-preview-remove" data-index="${index}" data-type="new">×</button>
	                        </div>`;
                });
                return existingAttachmentsHTML + newAttachmentsHTML;
            };

            const updatePreview = () => {
                const container = DOM.editPostModalContent.querySelector(
                    '.file-preview-container',
                );
                if (container) container.innerHTML = renderAttachments();
            };

            DOM.editPostModalContent.innerHTML = `
	                <div class="post-form" style="padding: 1rem;">
	                    <img src="${getUserIconUrl(getCurrentUser())}" class="user-icon" alt="your icon">
	                    <button class="modal-close-btn">×</button>
	                    <div class="form-content">
	                                                <div class="markdown-textarea-editor post-form-textarea"><textarea id="edit-post-textarea" class="markdown-content-editor" rows="5" maxlength="280" spellcheck="true" data-markdown-content-editor>${escapeHTML(String(post.content || ''))}</textarea><div class="markdown-editor-paint" aria-hidden="true"><div class="markdown-editor-placeholder"></div><div class="markdown-editor-preview hidden"></div><div class="markdown-editor-selection"></div><div class="markdown-editor-composition"></div><div class="markdown-editor-caret"></div></div></div>
                        <div class="file-preview-container" style="display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 1rem;">${renderAttachments()}</div>
	                        <div class="post-form-actions" style="padding-top: 1rem;">
	                            <button type="button" class="attachment-button float-left" title="ファイルを追加">${ICONS.attachment}</button>
	                            <button type="button" class="emoji-pic-button float-left" title="絵文字を選択">${ICONS.emoji}</button>
	                            <input type="file" id="edit-file-input" class="hidden" multiple>
	                            <div id="emoji-picker" class="hidden"></div>
	                            <button id="update-post-button" style="padding: 0.5rem 1.5rem; border-radius: 9999px; border: none; background-color: var(--primary-color); color: white; font-weight: 700; margin-left: auto;" class="float-right">保存</button>
	                            <button type="button" class="post-mask-button float-right ${post.mask ? 'active' : ''}" title="ワンクッション">${ICONS.mask}</button>
	                            <button type="button" class="post-lock-button float-right ${post.lock ? 'active' : ''}" title="プライベート" aria-pressed="${post.lock ? 'true' : 'false'}">${ICONS.lock}</button>
	                            <span class="float-clear"></span>
	                        </div>
	                    </div>
	                </div>
	            `;

            await emoji_picker_create(DOM.editPostModalContent);
            attachMarkdownContentEditor(
                DOM.editPostModalContent.querySelector('#edit-post-textarea'),
            );

            DOM.editPostModal.querySelector('#update-post-button').onclick =
                () =>
                    handleUpdatePost(
                        postId,
                        currentAttachments,
                        filesToAdd,
                        Array.from(filesToDelete),
                    );
            DOM.editPostModal.querySelector('.modal-close-btn').onclick = () =>
                DOM.editPostModal.classList.add('hidden');

            DOM.editPostModal.addEventListener('keydown', (e) => {
                if (e.ctrlKey && e.key === 'Enter') {
                    e.preventDefault();
                    DOM.editPostModal
                        .querySelector('#update-post-button')
                        .click();
                }
            });

            DOM.editPostModal.querySelector('.attachment-button').onclick =
                () => {
                    DOM.editPostModal.querySelector('#edit-file-input').click();
                };

            DOM.editPostModal.querySelector('#edit-file-input').onchange = (
                e,
            ) => {
                filesToAdd.push(...Array.from(e.target.files));
                updatePreview();
            };

            DOM.editPostModal.querySelector('.post-mask-button').onclick =
                () => {
                    DOM.editPostModal
                        .querySelector('.post-mask-button')
                        .classList.toggle('active');
                };
            DOM.editPostModal.querySelector('.post-lock-button').onclick = () =>
                handlePostLock(DOM.editPostModal);

            DOM.editPostModal.querySelector('.file-preview-container').onclick =
                (e) => {
                    if (e.target.classList.contains('file-preview-remove')) {
                        const type = e.target.dataset.type;
                        if (type === 'existing') {
                            filesToDelete.add(e.target.dataset.id);
                        } else if (type === 'new') {
                            const index = parseInt(e.target.dataset.index);
                            filesToAdd.splice(index, 1);
                        }
                        updatePreview();
                    }
                };

            DOM.editPostModal.classList.remove('hidden');
            DOM.editPostModal.querySelector('#edit-post-textarea').focus();
        } catch (e) {
            console.error(e);
            showAppAlert(e.message);
        } finally {
            showLoading(false);
        }
    }

    window.openDmManageModal = async function (dmId) {
        DOM.dmManageModalContent.innerHTML = '<div class="spinner"></div>';
        DOM.dmManageModal.classList.remove('hidden');
        DOM.dmManageModal.querySelector('.modal-close-btn').onclick = () =>
            DOM.dmManageModal.classList.add('hidden');

        try {
            const { data: dmPayload, error } = await apiRequest(
                `/server/api/dm/${encodeURIComponent(String(dmId))}`,
            );
            if (error) throw error;
            const dm = Array.isArray(dmPayload?.dm)
                ? dmPayload.dm[0]
                : dmPayload?.dm;
            if (!dm) throw new Error('DM情報の取得に失敗しました。');
            for (const member of dmPayload?.members || []) {
                getAllUsersCache().set(member.id, member);
            }

            const isHost = dm.host_id === getCurrentUser().id;
            const memberDetails = await Promise.all(
                (dm.member || []).map(
                    async (id) =>
                        getAllUsersCache().get(id) ||
                        (
                            await api
                                .from('user')
                                .select('id, name')
                                .eq('id', id)
                                .single()
                        ).data,
                ),
            );

            let html = `<div style="padding: 1.5rem; display: flex; flex-direction: column; gap: 1.5rem;"><h3>メッセージ管理</h3>`;

            if (isHost) {
                html += `
	                    <div>
	                        <label for="dm-title-input" style="font-weight: bold; display: block; margin-bottom: 0.5rem;">タイトル</label>
	                        <input type="text" id="dm-title-input" value="${escapeHTML(String(dm.title || '').slice(0, 200))}" style="width: 100%; padding: 0.8rem; border: 1px solid var(--border-color); border-radius: 8px;">
	                        <button id="save-dm-title-btn" style="margin-top: 0.5rem;">タイトルを保存</button>
	                    </div>
	                    <div>
	                        <h4 style="margin: 0 0 0.5rem 0;">メンバー (${dm.member.length})</h4>
	                        <div id="dm-member-list">
	                            ${memberDetails
                                    .map(
                                        (m) => `
	                                <div style="display: flex; justify-content: space-between; align-items: center; padding: 0.5rem 0;">
									<span>${getEmoji(escapeHTML(m.name))} (${getNyaitterId(m)}) ${m.id === dm.host_id ? '(ホスト)' : ''}</span>
	                                    <div id="dm-modal-btn">
	${m.id !== dm.host_id ? `<button class="sethost-member-btn" data-user-id="${escapeHTML(String(m.id))}" data-user-name="${escapeHTML(String(m.name || ''))}">管理者権限を譲渡</button>` : ''}
	                                        ${m.id !== dm.host_id ? `<button class="remove-member-btn" data-user-id="${escapeHTML(String(m.id))}" data-user-name="${escapeHTML(String(m.name || ''))}">削除</button>` : ''}
	                                    </div>
	                                </div>`,
                                    )
                                    .join('')}
	                        </div>
	                    </div>
	                    <div>
	                        <label for="dm-add-member-search" style="font-weight: bold; display: block; margin-bottom: 0.5rem;">メンバーを追加</label>
	                        <input type="text" id="dm-add-member-search" placeholder="ユーザー名またはIDで検索" style="width: 100%; padding: 0.8rem; border: 1px solid var(--border-color); border-radius: 8px;">
	                        <div id="dm-add-member-results" style="margin-top: 0.5rem; max-height: 150px; overflow-y: auto;"></div>
	                    </div>
	                    <button id="disband-dm-btn" style="align-self: flex-end;">DMを解散</button>
	                `;
            } else {
                html += `
	                    <p>このDMから退出しますか？<br>一度退出すると、再度招待されない限り参加できません。</p>
	                    <button id="leave-dm-btn" style="align-self: flex-end;">DMから退出</button>
	                `;
            }
            html += `</div>`;
            DOM.dmManageModalContent.innerHTML = html;

            // Event Listeners
            if (isHost) {
                document.getElementById('save-dm-title-btn').onclick = () =>
                    handleUpdateDmTitle(
                        dmId,
                        document.getElementById('dm-title-input').value,
                    );
                document.getElementById('disband-dm-btn').onclick = () =>
                    handleDisbandDm(dmId);

                document
                    .querySelectorAll('.remove-member-btn')
                    .forEach((btn) => {
                        const userId = parseInt(btn.dataset.userId);
                        const userName = btn.dataset.userName;
                        btn.onclick = () =>
                            handleRemoveDmMember(dmId, userId, userName);
                    });

                document
                    .querySelectorAll('.sethost-member-btn')
                    .forEach((btn) => {
                        const userId = parseInt(btn.dataset.userId);
                        const userName = btn.dataset.userName;
                        btn.onclick = () =>
                            handleSetHostDmMember(dmId, userId, userName);
                    });

                const searchInput = document.getElementById(
                    'dm-add-member-search',
                );
                const resultsContainer = document.getElementById(
                    'dm-add-member-results',
                );
                let searchTimeout;
                searchInput.addEventListener('input', () => {
                    clearTimeout(searchTimeout);
                    searchTimeout = setTimeout(async () => {
                        const query = searchInput.value.trim();
                        if (query.length < 2) {
                            resultsContainer.innerHTML = '';
                            return;
                        }

                        const { data: users } = await api
                            .from('user')
                            .select('id, name')
                            .or(
                                `name.ilike.%${query}%,id.eq.${parseInt(query) || 0}`,
                            )
                            .limit(5);
                        const nonMembers = users.filter(
                            (u) => !dm.member.includes(u.id),
                        );

                        resultsContainer.innerHTML =
                            nonMembers.length > 0
                                ? nonMembers
                                      .map(
                                          (u) =>
                                              `<div class="widget-item" style="cursor: pointer;" data-user-id="${escapeHTML(String(u.id))}"><strong>${getEmoji(escapeHTML(u.name))}</strong> (${getNyaitterId(u)})</div>`,
                                      )
                                      .join('')
                                : `<div class="widget-item">ユーザーが見つかりません。</div>`;
                    }, 300);
                });
                resultsContainer.addEventListener('click', (e) => {
                    const userDiv = e.target.closest('[data-user-id]');
                    if (userDiv) {
                        const userId = parseInt(userDiv.dataset.userId);
                        const userName =
                            userDiv.querySelector('strong').textContent;
                        handleAddDmMember(dmId, userId, userName);
                    }
                });
            } else {
                document.getElementById('leave-dm-btn').onclick = () =>
                    handleLeaveDm(dmId);
            }
        } catch (e) {
            DOM.dmManageModalContent.innerHTML = `<p style="padding: 1.5rem;">${escapeHTML(e.message)}</p>`;
            console.error(e);
        }
    };

    async function handleUpdateDmTitle(dmId, newTitle) {
        const { error } = await api
            .from('dm')
            .update({ title: newTitle.trim() })
            .eq('id', dmId);
        if (error) {
            showAppAlert('タイトルの更新に失敗しました。');
        } else {
            showAppAlert('タイトルを更新しました。');
            DOM.dmManageModal.classList.add('hidden');
            openDmManageModal(dmId); // モーダルを再描画
        }
    }

    async function handleRemoveDmMember(
        dmId,
        userIdToRemove,
        userNameToRemove,
    ) {
        if (
            !(await showAppConfirm(
                `${userNameToRemove}さんをDMから削除しますか?`,
            ))
        )
            return;

        showLoading(true);
        try {
            const { data: dm, error: fetchError } = await api
                .from('dm')
                .select('member')
                .eq('id', dmId)
                .single();
            if (fetchError) throw fetchError;

            const currentMembers = Array.isArray(dm?.member) ? dm.member : null;
            if (!currentMembers)
                throw new Error('DMのメンバー情報が取得できませんでした。');

            const normalizedUserIdToRemove = Number(userIdToRemove);
            if (!Number.isInteger(normalizedUserIdToRemove))
                throw new Error('削除対象のユーザーIDが不正です。');

            const updatedMembers = currentMembers.filter(
                (id) => Number(id) !== normalizedUserIdToRemove,
            );
            if (updatedMembers.length === currentMembers.length) {
                await showAppAlert('削除対象のユーザーは既にDMから退出しています。');
                return;
            }

            const { error } = await api
                .from('dm')
                .update({ member: updatedMembers })
                .eq('id', dmId);
            if (error) throw error;

            await sendSystemDmMessage(
                dmId,
                `@${getCurrentUser().id}さんが@${normalizedUserIdToRemove}さんを強制退出させました`,
            );
            void sendNotification(normalizedUserIdToRemove, 'dm_removed', {
                kind: 'dm',
                id: dmId,
            });
            await showAppAlert('メンバーを削除しました。');
            openDmManageModal(dmId); // モーダルを再描画
        } catch (error) {
            console.error('DMメンバーの削除に失敗しました:', error);
            await showAppAlert('メンバーの削除に失敗しました。');
        } finally {
            showLoading(false);
        }
    }

    async function handleSetHostDmMember(dmId, userIdToHost, userNameToHost) {
        if (
            !(await showAppConfirm(
                `${userNameToHost}さんに管理者権限を譲渡しますか?`,
            ))
        )
            return;

        // わんちゃん失敗するけど管理者権限無いとシステムメッセージ送れないので先に送信
        await sendSystemDmMessage(
            dmId,
            `@${getCurrentUser().id}さんが@${userIdToHost}さんに管理者権限を譲渡しました`,
        );

        const { error } = await api
            .from('dm')
            .update({ host_id: userIdToHost })
            .eq('id', dmId);
        if (error) {
            showAppAlert('権限の譲渡に失敗しました。');
        } else {
            void sendNotification(userIdToHost, 'dm_host_transfer', {
                kind: 'dm',
                id: dmId,
            });
            showAppAlert('権限を譲渡しました。');
            openDmManageModal(dmId); // モーダルを再描画
        }
    }

    async function handleAddDmMember(dmId, userIdToAdd, userNameToAdd) {
        if (!(await showAppConfirm(`${userNameToAdd}さんをDMに追加しますか？`)))
            return;

        const { data: dm } = await api
            .from('dm')
            .select('member')
            .eq('id', dmId)
            .single();
        if (dm.member.includes(userIdToAdd)) {
            showAppAlert('このユーザーは既にメンバーです。');
            return;
        }
        const updatedMembers = [...dm.member, userIdToAdd];

        const { error } = await api
            .from('dm')
            .update({ member: updatedMembers })
            .eq('id', dmId);
        if (error) {
            showAppAlert('メンバーの追加に失敗しました。');
        } else {
            await sendSystemDmMessage(
                dmId,
                `@${getCurrentUser().id}さんが@${userIdToAdd}さんを招待しました`,
            );
            void sendNotification(userIdToAdd, 'dm_invite', {
                kind: 'dm',
                id: dmId,
            });
            showAppAlert('メンバーを追加しました。');
            openDmManageModal(dmId); // モーダルを再描画
        }
    }

    async function handleLeaveDm(dmId) {
        if (!(await showAppConfirm('本当にこのDMから退出しますか？'))) return;
        showLoading(true);

        try {
            // 退出したことをシステムメッセージとして記録（これはメンバー権限で実行可能）
            await sendSystemDmMessage(
                dmId,
                `@${getCurrentUser().id}さんが退出しました`,
            );

            // 新しいDB関数を呼び出す
            const { error } = await api.rpc('leave_dm', {
                dm_id_to_leave: dmId,
                user_id_to_leave: getCurrentUser().id,
            });

            if (error) throw error;

            invalidateDmCaches();
            showAppAlert('DMから退出しました。');
            DOM.dmManageModal.classList.add('hidden');

            window.location.hash = '#dm';
            await showDmScreen();
        } catch (e) {
            console.error('DMからの退出に失敗しました:', e);
            showAppAlert('DMからの退出に失敗しました。');
        } finally {
            showLoading(false);
        }
    }

    async function handleDisbandDm(dmId) {
        if (
            !(await showAppConfirm(
                '本当にこのDMを解散しますか？この操作は取り消せません。',
            ))
        )
            return;
        showLoading(true);
        try {
            // 添付ファイルを全て削除
            const { data: dm, error: fetchError } = await api
                .from('dm')
                .select('post')
                .eq('id', dmId)
                .single();
            if (fetchError) throw fetchError;

            const fileIdsToDelete = (dm.post || [])
                .flatMap((msg) => msg.attachments || [])
                .map((att) => att.id);

            if (fileIdsToDelete.length > 0) {
                await deleteFilesViaEdgeFunction(fileIdsToDelete);
            }

            // DMを削除
            const { error } = await api.from('dm').delete().eq('id', dmId);
            if (error) throw error;

            invalidateDmCaches();
            showAppAlert('DMを解散しました。');
            DOM.dmManageModal.classList.add('hidden');
            window.location.hash = '#dm';
            await showDmScreen();
        } catch (e) {
            console.error(e);
            showAppAlert('DMの解散に失敗しました。');
        } finally {
            showLoading(false);
        }
    }

    async function sendSystemDmMessage(dmId, content) {
        const mentionRegex = /@(\d+)/g;
        const mentionedIds = new Set();
        for (const match of content.matchAll(/@(\d+)/g)) {
            mentionedIds.add(parseInt(match[1]));
        }

        const newIdsToFetch = [...mentionedIds].filter(
            (id) => !getAllUsersCache().has(id),
        );
        if (newIdsToFetch.length > 0) {
            const { data: newUsers } = await api
                .from('user')
                .select('id, name, scid, icon_data')
                .in('id', newIdsToFetch);
            if (newUsers)
                newUsers.forEach((u) => getAllUsersCache().set(u.id, u));
        }

        const message = {
            id: crypto.randomUUID(),
            created_at: new Date().toISOString(),
            type: 'system',
            content: content,
        };
        await api.rpc('append_to_dm_post', {
            dm_id_in: dmId,
            new_message_in: message,
        });
    }

    async function handleUpdatePost(
        postId,
        originalAttachments,
        filesToAdd,
        filesToDeleteIds,
    ) {
        const newContent = getMarkdownEditorValue(
            DOM.editPostModal.querySelector('#edit-post-textarea'),
        ).trim();
        const maskActive = DOM.editPostModal
            .querySelector('.post-mask-button')
            .classList.contains('active');
        const lockActive = DOM.editPostModal
            .querySelector('.post-lock-button')
            .classList.contains('active');
        const editPostTextarea = DOM.editPostModal.querySelector(
            '#edit-post-textarea',
        );
        if (!newContent)
            return showAppAlert(
                '内容を入力するか、ファイルを添付してください。',
            );

        const button = DOM.editPostModal.querySelector('#update-post-button');
        button.disabled = true;
        button.textContent = '保存中...';
        showLoading(true);

        try {
            if (filesToDeleteIds.length > 0) {
                await deleteFilesViaEdgeFunction(filesToDeleteIds);
            }

            let newUploadedAttachments = [];
            if (filesToAdd.length > 0) {
                for (const file of filesToAdd) {
                    const fileId = await uploadFileViaEdgeFunction(file);
                    const fileType = file.type.startsWith('image/')
                        ? 'image'
                        : file.type.startsWith('video/')
                          ? 'video'
                          : file.type.startsWith('audio/')
                            ? 'audio'
                            : 'file';
                    newUploadedAttachments.push({
                        type: fileType,
                        id: fileId,
                        name: file.name,
                    });
                }
            }

            let finalAttachments = originalAttachments.filter(
                (att) => !filesToDeleteIds.includes(att.id),
            );
            finalAttachments.push(...newUploadedAttachments);

            const { error: postUpdateError } = await api
                .from('post')
                .update({
                    content: newContent,
                    attachments:
                        finalAttachments.length > 0 ? finalAttachments : null,
                    mask: maskActive,
                    lock: lockActive,
                })

                .eq('id', postId);
            if (postUpdateError) throw postUpdateError;

            DOM.editPostModal.classList.add('hidden');
            invalidateTimelinePageCache();
            router(); // 画面を再描画して変更を反映
        } catch (e) {
            console.error(e);
            showAppAlert('ポストの更新に失敗しました。');
        } finally {
            button.disabled = false;
            button.textContent = '保存';
            showLoading(false);
        }
    }

    // ============================================
    // DM E2E暗号化（テキストのみ）
    // スキーム: ECDH(P-256) + HKDF-SHA256 + AES-256-GCM
    // 秘密鍵は端末の localStorage にのみ保存し、サーバーには公開鍵だけを登録する。
    // ============================================

    // 複数デバイスでのDM利用を優先するため、E2E暗号化は一時的に停止する。
    // 既存の暗号化メッセージは、端末に残る鍵で閲覧できるよう復号処理だけ保持する。
    const DM_E2E_ENABLED = false;
    const DM_E2E_INFO_PREFIX = 'nyaitter-dm-v1';
    const DM_E2E_KEY_STORAGE_PREFIX = 'nyaitter_dm_key_';

    function dmE2EBytesToBase64url(bytes) {
        let binary = '';
        for (let i = 0; i < bytes.length; i++)
            binary += String.fromCharCode(bytes[i]);
        return btoa(binary)
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/g, '');
    }

    function dmE2EBase64urlToBytes(str) {
        const base64 = String(str).replace(/-/g, '+').replace(/_/g, '/');
        const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
        const binary = atob(padded);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
    }

    async function dmE2EExportPublicKey(cryptoKey) {
        const jwk = await crypto.subtle.exportKey('jwk', cryptoKey);
        const point = new Uint8Array(65);
        point[0] = 0x04;
        point.set(dmE2EBase64urlToBytes(jwk.x), 1);
        point.set(dmE2EBase64urlToBytes(jwk.y), 33);
        return dmE2EBytesToBase64url(point);
    }

    async function dmE2EImportPublicKey(b64) {
        const raw = dmE2EBase64urlToBytes(b64);
        if (raw.length !== 65 || raw[0] !== 0x04) {
            throw new Error('Invalid P-256 public key');
        }
        return crypto.subtle.importKey(
            'raw',
            raw,
            { name: 'ECDH', namedCurve: 'P-256' },
            true,
            [],
        );
    }

    async function dmE2EGenerateKeyPair() {
        const keyPair = await crypto.subtle.generateKey(
            { name: 'ECDH', namedCurve: 'P-256' },
            true,
            ['deriveBits'],
        );
        return {
            privateKey: keyPair.privateKey,
            publicKeyB64: await dmE2EExportPublicKey(keyPair.publicKey),
            privateJwk: await crypto.subtle.exportKey(
                'jwk',
                keyPair.privateKey,
            ),
        };
    }

    async function dmE2ELoadStoredKey(userId) {
        if (!userId) return null;
        let data;
        try {
            data = JSON.parse(
                localStorage.getItem(DM_E2E_KEY_STORAGE_PREFIX + userId) ||
                    'null',
            );
        } catch (_) {
            return null;
        }
        if (!data || !data.priv || !data.pub) return null;
        const privateKey = await crypto.subtle.importKey(
            'jwk',
            data.priv,
            { name: 'ECDH', namedCurve: 'P-256' },
            true,
            ['deriveBits'],
        );
        return { privateKey, publicKeyB64: data.pub };
    }

    async function dmE2EEnsureKeyPairRegistered(userId) {
        if (!userId || !crypto?.subtle) return null;
        try {
            let stored = await dmE2ELoadStoredKey(userId);
            if (!stored) {
                const pair = await dmE2EGenerateKeyPair();
                stored = {
                    privateKey: pair.privateKey,
                    publicKeyB64: pair.publicKeyB64,
                };
                localStorage.setItem(
                    DM_E2E_KEY_STORAGE_PREFIX + userId,
                    JSON.stringify({
                        priv: pair.privateJwk,
                        pub: pair.publicKeyB64,
                    }),
                );
            }
            if (
                getDmE2ERegisteredUsers() &&
                getDmE2ERegisteredUsers().has(userId)
            )
                return stored;
            const { error } = await apiRequest('/server/api/dm/keys', {
                method: 'POST',
                body: { public_key: stored.publicKeyB64 },
            });
            if (!error) {
                if (!getDmE2ERegisteredUsers())
                    setDmE2ERegisteredUsers(new Set());
                getDmE2ERegisteredUsers().add(userId);
            }
            return stored;
        } catch (e) {
            console.warn('[dm-e2e] 鍵の準備に失敗:', e);
            return null;
        }
    }

    async function dmE2EGetPublicKeys(memberIds) {
        const ids = [
            ...new Set(
                memberIds.map(Number).filter((n) => Number.isInteger(n)),
            ),
        ];
        const missing = ids.filter((id) => !getDmE2EPublicKeyCache().has(id));
        if (missing.length > 0) {
            const { data, error } = await apiRequest(
                `/server/api/dm/keys?user_ids=${encodeURIComponent(missing.join(','))}`,
            );
            if (!error && data && data.keys) {
                for (const [id, pub] of Object.entries(data.keys)) {
                    getDmE2EPublicKeyCache().set(Number(id), pub);
                }
            }
        }
        const result = new Map();
        for (const id of ids) {
            const pub = getDmE2EPublicKeyCache().get(id);
            if (pub) result.set(id, pub);
        }
        return result;
    }

    async function dmE2EDeriveAesKey(sharedSecret, senderId, recipientId) {
        const baseKey = await crypto.subtle.importKey(
            'raw',
            sharedSecret,
            { name: 'HKDF' },
            false,
            ['deriveKey'],
        );
        return crypto.subtle.deriveKey(
            {
                name: 'HKDF',
                hash: 'SHA-256',
                salt: new Uint8Array(0),
                info: new TextEncoder().encode(
                    `${DM_E2E_INFO_PREFIX}:${senderId}:${recipientId}`,
                ),
            },
            baseKey,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt'],
        );
    }

    /**
     * 全メンバーの公開鍵が揃っているときだけ暗号化する。
     * 鍵が足りない場合は null を返し、呼び出し側は平文（レガシー）で送信する。
     */
    async function dmE2EEncryptContent(content, memberIds, senderId) {
        if (!content || !memberIds || memberIds.length === 0) return null;
        const memberSet = [...new Set(memberIds.map(Number))];
        const publicKeys = await dmE2EGetPublicKeys(memberSet);
        if (memberSet.length !== publicKeys.size) return null;
        const own = await dmE2ELoadStoredKey(senderId);
        if (!own) return null;

        const ephemeral = await crypto.subtle.generateKey(
            { name: 'ECDH', namedCurve: 'P-256' },
            true,
            ['deriveBits'],
        );
        const ephPubB64 = await dmE2EExportPublicKey(ephemeral.publicKey);
        const plaintext = new TextEncoder().encode(content);

        const ct = {};
        for (const memberId of memberSet) {
            try {
                const recipientPub = await dmE2EImportPublicKey(
                    publicKeys.get(memberId),
                );
                const shared = await crypto.subtle.deriveBits(
                    { name: 'ECDH', public: recipientPub },
                    ephemeral.privateKey,
                    256,
                );
                const aesKey = await dmE2EDeriveAesKey(
                    shared,
                    senderId,
                    memberId,
                );
                const iv = crypto.getRandomValues(new Uint8Array(12));
                const ciphertext = await crypto.subtle.encrypt(
                    { name: 'AES-GCM', iv },
                    aesKey,
                    plaintext,
                );
                ct[String(memberId)] = {
                    iv: dmE2EBytesToBase64url(iv),
                    data: dmE2EBytesToBase64url(new Uint8Array(ciphertext)),
                };
            } catch (e) {
                console.warn(
                    '[dm-e2e] メッセージ暗号化に失敗（平文にフォールバック）:',
                    e,
                );
                return null;
            }
        }
        return { v: 1, eph: ephPubB64, ct };
    }

    /**
     * E2Eメッセージを復号する。平文メッセージはそのまま content を返す。
     */
    async function dmE2EDecryptMessage(msg, userId) {
        if (!msg || !msg.e2e) return msg?.content || '';
        try {
            const entry = msg.e2e.ct && msg.e2e.ct[String(userId)];
            if (!entry) throw new Error('この端末向けの暗号文がありません');
            const own = await dmE2ELoadStoredKey(userId);
            if (!own) throw new Error('秘密鍵がありません');
            const ephPub = await dmE2EImportPublicKey(msg.e2e.eph);
            const shared = await crypto.subtle.deriveBits(
                { name: 'ECDH', public: ephPub },
                own.privateKey,
                256,
            );
            const aesKey = await dmE2EDeriveAesKey(shared, msg.userid, userId);
            const iv = dmE2EBase64urlToBytes(entry.iv);
            const data = dmE2EBase64urlToBytes(entry.data);
            const plaintext = await crypto.subtle.decrypt(
                { name: 'AES-GCM', iv },
                aesKey,
                data,
            );
            return new TextDecoder().decode(plaintext);
        } catch (e) {
            console.warn('[dm-e2e] 復号に失敗:', e);
            return '🔒 このメッセージは復号できません';
        }
    }

    async function handleDmButtonClick(targetUserId) {
        if (!getCurrentUser()) return;
        const normalizedTargetUserId = Number(targetUserId);
        if (
            !Number.isInteger(normalizedTargetUserId) ||
            normalizedTargetUserId === getCurrentUser().id
        )
            return;

        showLoading(true);
        try {
            const { data: targetPayload, error: targetError } =
                await apiRequest(
                    `/server/api/users/${encodeURIComponent(normalizedTargetUserId)}`,
                );
            if (targetError || !targetPayload?.user) {
                throw (
                    targetError ||
                    new Error('DM相手のユーザー情報を取得できませんでした。')
                );
            }
            const targetUser = targetPayload.user;
            if (
                !(await showAppConfirm(
                    `${targetUser.name}さんとのDMを開始しますか？`,
                ))
            )
                return;

            const members = [getCurrentUser().id, normalizedTargetUserId].sort(
                (a, b) => a - b,
            );
            const { data: result, error: createError } = await apiRequest(
                '/server/api/dm',
                {
                    method: 'POST',
                    body: {
                        member: members,
                        title: `${getCurrentUser().name}, ${targetUser.name}`,
                    },
                },
            );
            if (createError || !result?.dm?.id) {
                throw createError || new Error('DMの作成結果が不正です。');
            }

            if (result.created) {
                void sendNotification(normalizedTargetUserId, 'dm_invite', {
                    kind: 'dm',
                    id: result.dm.id,
                });
            }
            invalidateDmCaches();
            window.location.hash = `#dm/${result.dm.id}`;
            await router();
        } catch (error) {
            console.error('DMの作成に失敗しました:', error);
            showAppAlert(`DMの作成に失敗しました: ${error.message}`);
        } finally {
            showLoading(false);
        }
    }

    async function openDmEditModal(dmId, messageId) {
        showLoading(true);
        try {
            const { data: dm, error: fetchError } = await api
                .from('dm')
                .select('post')
                .eq('id', dmId)
                .single();
            if (fetchError || !dm)
                throw new Error('DM情報が取得できませんでした。');

            const message = (dm.post || []).find((m) => m.id === messageId);
            if (!message) throw new Error('メッセージが見つかりませんでした。');
            const messagePlaintext = await dmE2EDecryptMessage(
                message,
                getCurrentUser().id,
            );
            if (
                message.e2e &&
                messagePlaintext === '🔒 このメッセージは復号できません'
            ) {
                throw new Error(
                    'この端末では復号できない以前の暗号化DMは編集できません。',
                );
            }

            let currentAttachments = message.attachments || [];
            let filesToDelete = new Set();
            let filesToAdd = [];

            const renderAttachments = () => {
                let existingHTML = currentAttachments
                    .filter((att) => !filesToDelete.has(att.id))
                    .map(
                        (att, index) => `
	                        <div class="file-preview-item">
	                            <span>${att.type.startsWith('image') ? '🖼️' : '📎'} ${escapeHTML(att.name)}</span>
	                            <button class="file-preview-remove" data-id="${escapeHTML(String(att.id))}" data-type="existing">×</button>
	                        </div>`,
                    )
                    .join('');

                let newHTML = filesToAdd
                    .map(
                        (file, index) => `
	                        <div class="file-preview-item">
	                            <span>${file.type.startsWith('image') ? '🖼️' : '📎'} ${escapeHTML(file.name)}</span>
	                            <button class="file-preview-remove" data-index="${index}" data-type="new">×</button>
	                        </div>`,
                    )
                    .join('');
                return existingHTML + newHTML;
            };

            const updatePreview = () => {
                const container = DOM.editDmMessageModalContent.querySelector(
                    '.file-preview-container',
                );
                if (container) container.innerHTML = renderAttachments();
            };

            DOM.editDmMessageModalContent.innerHTML = `
	                <div class="post-form" style="padding: 1rem;">
	                    <button class="modal-close-btn">×</button>
	                    <div class="form-content">
	                                                <div class="markdown-textarea-editor dm-content-editor" style="min-height: 100px; font-size: 1rem;"><textarea id="edit-dm-textarea" class="markdown-content-editor" rows="5" spellcheck="true" data-markdown-content-editor>${escapeHTML(String(messagePlaintext))}</textarea><div class="markdown-editor-paint" aria-hidden="true"><div class="markdown-editor-placeholder"></div><div class="markdown-editor-preview hidden"></div><div class="markdown-editor-selection"></div><div class="markdown-editor-composition"></div><div class="markdown-editor-caret"></div></div></div>
                        <div class="file-preview-container" style="display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 1rem;"></div>
	                        <div class="post-form-actions" style="padding-top: 1rem;">
	                            <button type="button" class="attachment-button float-left" title="ファイルを追加">${ICONS.attachment}</button>
	                            <button type="button" class="emoji-pic-button float-left" title="絵文字を選択">${ICONS.emoji}</button>
	                            <input type="file" id="edit-dm-file-input" class="hidden" multiple>
	                            <div id="emoji-picker" class="hidden"></div>
	                            <button id="update-dm-message-button" style="padding: 0.5rem 1.5rem; border-radius: 9999px; border: none; background-color: var(--primary-color); color: white; font-weight: 700; margin-left: auto;" class="float-right">保存</button>
	                            <span class="float-clear"></span>
	                        </div>
	                    </div>
	                </div>`;

            await emoji_picker_create(DOM.editDmMessageModalContent);
            attachMarkdownContentEditor(
                DOM.editDmMessageModalContent.querySelector(
                    '#edit-dm-textarea',
                ),
            );

            updatePreview();

            DOM.editDmMessageModal.querySelector(
                '#update-dm-message-button',
            ).onclick = () =>
                handleUpdateDmMessage(
                    dmId,
                    messageId,
                    currentAttachments,
                    filesToAdd,
                    Array.from(filesToDelete),
                );
            DOM.editDmMessageModal.querySelector('.attachment-button').onclick =
                () =>
                    DOM.editDmMessageModal
                        .querySelector('#edit-dm-file-input')
                        .click();

            DOM.editDmMessageModal.querySelector(
                '#edit-dm-file-input',
            ).onchange = (e) => {
                filesToAdd.push(...Array.from(e.target.files));
                updatePreview();
            };

            DOM.editDmMessageModal.querySelector(
                '.file-preview-container',
            ).onclick = (e) => {
                if (e.target.classList.contains('file-preview-remove')) {
                    const type = e.target.dataset.type;
                    if (type === 'existing') {
                        filesToDelete.add(e.target.dataset.id);
                    } else if (type === 'new') {
                        const index = parseInt(e.target.dataset.index);
                        filesToAdd.splice(index, 1);
                    }
                    updatePreview();
                }
            };

            DOM.editDmMessageModal.classList.remove('hidden');
            DOM.editDmMessageModal.querySelector('.modal-close-btn').onclick =
                () => DOM.editDmMessageModal.classList.add('hidden');
        } catch (e) {
            showAppAlert(e.message);
        } finally {
            showLoading(false);
        }
    }

    async function handleUpdateDmMessage(
        dmId,
        messageId,
        originalAttachments,
        filesToAdd,
        filesToDeleteIds,
    ) {
        const newContent = getMarkdownEditorValue(
            DOM.editDmMessageModal.querySelector('#edit-dm-textarea'),
        ).trim();
        const button = DOM.editDmMessageModal.querySelector(
            '#update-dm-message-button',
        );
        button.disabled = true;
        button.textContent = '保存中...';
        showLoading(true);

        try {
            // ファイルの削除
            if (filesToDeleteIds.length > 0) {
                await deleteFilesViaEdgeFunction(filesToDeleteIds);
            }

            // ファイルのアップロード
            let newUploadedAttachments = [];
            if (filesToAdd.length > 0) {
                for (const file of filesToAdd) {
                    const fileId = await uploadFileViaEdgeFunction(file);
                    const fileType = file.type.startsWith('image/')
                        ? 'image'
                        : file.type.startsWith('video/')
                          ? 'video'
                          : file.type.startsWith('audio/')
                            ? 'audio'
                            : 'file';
                    newUploadedAttachments.push({
                        type: fileType,
                        id: fileId,
                        name: file.name,
                    });
                }
            }

            const finalAttachments = originalAttachments.filter(
                (att) => !filesToDeleteIds.includes(att.id),
            );
            finalAttachments.push(...newUploadedAttachments);

            // DMのpost配列を更新
            const { data: dm, error: fetchError } = await api
                .from('dm')
                .select('post')
                .eq('id', dmId)
                .single();
            if (fetchError) throw fetchError;

            const postArray = dm.post || [];
            const messageIndex = postArray.findIndex((m) => m.id === messageId);
            if (messageIndex === -1)
                throw new Error('更新対象のメッセージが見つかりません。');

            const targetMessage = postArray[messageIndex];
            // 以前の暗号化DMを編集した場合も、以後は平文メッセージとして保存する。
            delete targetMessage.e2e;
            targetMessage.content = newContent;
            targetMessage.attachments = finalAttachments;

            const { error: updateError } = await api
                .from('dm')
                .update({ post: postArray })
                .eq('id', dmId);
            if (updateError) throw updateError;

            DOM.editDmMessageModal.classList.add('hidden');
            // 画面を再描画して変更を反映
            const messageContainer = document.querySelector(
                `.dm-message-container[data-message-id="${messageId}"]`,
            );
            if (messageContainer) {
                messageContainer.outerHTML = await renderDmMessage(
                    postArray[messageIndex],
                    dmId,
                );
                initializeDmMessageClamps(
                    document.querySelector('.dm-conversation-view'),
                );
            }
        } catch (e) {
            console.error(e);
            showAppAlert('メッセージの更新に失敗しました。');
        } finally {
            button.disabled = false;
            button.textContent = '保存';
            showLoading(false);
        }
    }

    async function handleDeleteDmMessage(dmId, messageId) {
        if (!(await showAppConfirm('このメッセージを削除しますか?'))) return;
        showLoading(true);
        try {
            const { data: dm, error: fetchError } = await api
                .from('dm')
                .select('post')
                .eq('id', dmId)
                .single();
            if (fetchError) throw fetchError;

            const postArray = dm.post || [];
            const messageToDelete = postArray.find((m) => m.id === messageId);
            const updatedPostArray = postArray.filter(
                (m) => m.id !== messageId,
            );

            // 添付ファイルをストレージから削除
            if (messageToDelete && messageToDelete.attachments?.length > 0) {
                const fileIds = messageToDelete.attachments.map(
                    (att) => att.id,
                );
                await deleteFilesViaEdgeFunction(fileIds);
            }

            // DMのpost配列を更新
            const { error: updateError } = await api
                .from('dm')
                .update({ post: updatedPostArray })
                .eq('id', dmId);
            if (updateError) throw updateError;

            // DOMからメッセージを削除
            document
                .querySelector(
                    `.dm-message-container[data-message-id="${messageId}"]`,
                )
                ?.remove();
        } catch (e) {
            console.error(e);
            showAppAlert('メッセージの削除に失敗しました。');
        } finally {
            showLoading(false);
        }
    }

    window.openCreateDmModal = function () {
        DOM.createDmModalContent.innerHTML = `
	            <div style="padding: 1.5rem;">
	                <h3>新しいメッセージ</h3>
	                <p>ユーザーを検索してDMを開始します。</p>
	                <input type="text" id="dm-user-search" placeholder="ユーザー名またはIDで検索" style="width: 100%; padding: 0.8rem; border: 1px solid var(--border-color); border-radius: 8px;">
	                <div id="dm-user-search-results" style="margin-top: 1rem; max-height: 200px; overflow-y: auto;"></div>
	            </div>
	        `;

        const searchInput =
            DOM.createDmModalContent.querySelector('#dm-user-search');
        const resultsContainer = DOM.createDmModalContent.querySelector(
            '#dm-user-search-results',
        );

        let searchTimeout;
        searchInput.addEventListener('input', () => {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(async () => {
                const query = searchInput.value.trim();
                if (query.length < 2) {
                    resultsContainer.innerHTML = '';
                    return;
                }
                const numericId = /^\d+$/.test(query)
                    ? parseInt(query, 10)
                    : null;
                const orFilter =
                    numericId !== null
                        ? `name.ilike.%${query}%,id.eq.${numericId}`
                        : `name.ilike.%${query}%`;
                const { data: users, error } = await api
                    .from('user')
                    .select('id, name, scid')
                    .or(orFilter)
                    .neq('id', getCurrentUser().id)
                    .limit(5);

                if (users && users.length > 0) {
                    resultsContainer.innerHTML = users
                        .map(
                            (u) => `
	                        <div class="widget-item" style="cursor: pointer;" data-user-id="${escapeHTML(String(u.id))}" data-user-name="${escapeHTML(String(u.name || ''))}">
							<strong>${getEmoji(escapeHTML(u.name))}</strong> (${getNyaitterId(u)})
	                        </div>
	                    `,
                        )
                        .join('');
                } else {
                    resultsContainer.innerHTML = `<div class="widget-item">ユーザーが見つかりません。</div>`;
                }
            }, 300);
        });

        resultsContainer.addEventListener('click', (e) => {
            const userDiv = e.target.closest('[data-user-id]');
            if (userDiv) {
                const targetUserId = parseInt(userDiv.dataset.userId);
                DOM.createDmModal.classList.add('hidden');
                handleDmButtonClick(targetUserId);
            }
        });

        DOM.createDmModal.classList.remove('hidden');
        DOM.createDmModal.querySelector('.modal-close-btn').onclick = () => {
            DOM.createDmModal.classList.add('hidden');
        };
    };

    async function sendDmMessage(dmId, files = []) {
        const input = document.getElementById('dm-message-input');
        const content = getMarkdownEditorValue(input).trim();
        if (!content && files.length === 0) return;
        if (content.length > 2000) {
            showAppAlert('DMの内容は2000文字以下にしてください。');
            return;
        }

        const sendButton = document.getElementById('send-dm-btn');
        input.disabled = true;
        sendButton.disabled = true;

        try {
            const mentionedIds = new Set();
            for (const match of content.matchAll(/@(\d+)/g)) {
                mentionedIds.add(parseInt(match[1]));
            }

            const newIdsToFetch = [...mentionedIds].filter(
                (id) => !getAllUsersCache().has(id),
            );
            if (newIdsToFetch.length > 0) {
                const { data: newUsers } = await api
                    .from('user')
                    .select('id, name, scid, icon_data')
                    .in('id', newIdsToFetch);
                if (newUsers)
                    newUsers.forEach((u) => getAllUsersCache().set(u.id, u));
            }

            let attachmentsData = [];
            if (files.length > 0) {
                showLoading(true);
                for (const file of files) {
                    const fileId = await uploadFileViaEdgeFunction(file);
                    const fileType = file.type.startsWith('image/')
                        ? 'image'
                        : file.type.startsWith('video/')
                          ? 'video'
                          : file.type.startsWith('audio/')
                            ? 'audio'
                            : 'file';
                    attachmentsData.push({
                        type: fileType,
                        id: fileId,
                        name: file.name,
                    });
                }
                showLoading(false);
            }

            const message = {
                id: crypto.randomUUID(),
                created_at: new Date().toISOString(),
                userid: getCurrentUser().id,
                content: content,
                attachments: attachmentsData,
                read: [getCurrentUser().id],
            };

            const { error } = await api.rpc('append_to_dm_post', {
                dm_id_in: dmId,
                new_message_in: message,
            });

            if (error) {
                throw error;
            } else {
                invalidateDmCaches(dmId);
                setMarkdownEditorValue(input, '');
                const view = document.querySelector('.dm-conversation-view');
                if (view) {
                    const msgHTML = await renderDmMessage(message, dmId);
                    view.insertAdjacentHTML('afterbegin', msgHTML);
                    initializeDmMessageClamps(view);
                    setLastRenderedMessageId(message.id);
                    view.scrollTop = view.scrollHeight;
                }
            }
        } catch (error) {
            showAppAlert('メッセージの送信に失敗しました。');
            console.error(error);
        } finally {
            input.disabled = false;
            sendButton.disabled = false;
            input.focus();
        }
    }

    function closeReportModal() {
        const modal = document.getElementById('report-modal');
        modal?.classList.add('hidden');
    }

    function openReportModal({ targetKind, targetId, targetLabel }) {
        if (!getCurrentUser()) {
            openLoginModal();
            return;
        }
        const modal = document.getElementById('report-modal');
        const form = document.getElementById('report-form');
        const description = document.getElementById('report-description');
        const target = document.getElementById('report-modal-target');
        const errorElement = document.getElementById('report-modal-error');
        if (!modal || !form || !description || !target) return;

        form.reset();
        errorElement?.classList.add('hidden');
        target.textContent = `${targetLabel} を報告します。`;
        modal.classList.remove('hidden');
        description.focus();

        modal.querySelector('.modal-close-btn').onclick = closeReportModal;
        modal.querySelector('[data-action="close-report-modal"]').onclick =
            closeReportModal;
        modal.onclick = (event) => {
            if (event.target === modal) closeReportModal();
        };
        form.onsubmit = async (event) => {
            event.preventDefault();
            const submit = form.querySelector('button[type="submit"]');
            submit.disabled = true;
            errorElement?.classList.add('hidden');
            const { error } = await apiRequest('/server/api/reports', {
                method: 'POST',
                body: {
                    target_kind: targetKind,
                    target_id:
                        targetKind === 'dm'
                            ? String(targetId)
                            : Number(targetId),
                    description: description.value,
                },
            });
            submit.disabled = false;
            if (error) {
                if (errorElement) {
                    errorElement.textContent =
                        error.message ||
                        String(error) ||
                        '報告を送信できませんでした。';
                    errorElement.classList.remove('hidden');
                }
                return;
            }
            closeReportModal();
            await showAppAlert(
                '報告を送信しました。ご協力ありがとうございます。',
            );
        };
    }

    function openProfileMenu(targetUser) {
        document.getElementById('profile-menu')?.remove();

        const menu = document.createElement('div');
        menu.id = 'profile-menu';
        menu.className = 'post-menu is-visible';

        // ブロック/ブロック解除
        if (getCurrentUser().id !== targetUser.id) {
            const isBlocked =
                Array.isArray(getCurrentUser().block) &&
                getCurrentUser().block.includes(targetUser.id);
            const blockBtn = document.createElement('button');
            blockBtn.textContent = isBlocked ? 'ブロック解除' : 'ブロック';
            blockBtn.onclick = async () => {
                blockBtn.disabled = true;
                let updatedBlock = isBlocked
                    ? getCurrentUser().block.filter(
                          (id) => id !== targetUser.id,
                      )
                    : [...(getCurrentUser().block || []), targetUser.id];
                const { data: updatePayload, error } = await apiRequest(
                    '/server/api/users/me',
                    {
                        method: 'PUT',
                        body: { block: updatedBlock },
                    },
                );
                if (!error) {
                    setCurrentUser(
                        updatePayload?.user || {
                            ...currentUser,
                            block: updatedBlock,
                        },
                    );
                    updateAccountData(getCurrentUser());
                    // ブロック状態の変更後は、以前の閲覧権限で保存された投稿・DM・
                    // プロフィールを再利用しない。
                    invalidateTimelinePageCache();
                    invalidateDmCaches();
                    getPublicProfileCache().clear();
                    menu.remove();
                    // 同じプロフィールを再描画する場合も、現在位置を保存・復元する
                    // 共通ルーターを通す。
                    await router();
                } else {
                    showAppAlert('ブロック操作に失敗しました');
                    blockBtn.disabled = false;
                }
            };
            menu.appendChild(blockBtn);

            const reportBtn = document.createElement('button');
            reportBtn.className = 'report-btn';
            reportBtn.textContent = '報告する';
            reportBtn.onclick = () => {
                openReportModal({
                    targetKind: 'user',
                    targetId: targetUser.id,
                    targetLabel: `ユーザー @${targetUser.scid || targetUser.id}`,
                });
                menu.remove();
            };
            menu.appendChild(reportBtn);
        }

        // NyaitterTeamのみのメニュー
        if (getCurrentUser().admin) {
            const verifyBtn = document.createElement('button');
            verifyBtn.textContent = targetUser.verify
                ? '認証を取り消す'
                : 'このユーザーを認証';
            verifyBtn.onclick = () => adminToggleVerify(targetUser);

            const sendNoticeBtn = document.createElement('button');
            sendNoticeBtn.textContent = '通知を送信';
            sendNoticeBtn.onclick = () => adminSendNotice(targetUser.id);

            const shadowBtn = document.createElement('button');
            shadowBtn.textContent = targetUser.shadow
                ? '検索除外を解除'
                : '検索除外';
            shadowBtn.className = 'delete-btn';
            shadowBtn.onclick = () => adminToggleShadow(targetUser);

            const freezeBtn = document.createElement('button');
            const isFrozen =
                targetUser.account_state === 'frozen' ||
                Boolean(targetUser.freeze);
            freezeBtn.textContent = isFrozen
                ? '凍結を解除'
                : 'アカウントを凍結';
            freezeBtn.className = isFrozen ? '' : 'delete-btn';
            freezeBtn.onclick = () =>
                isFrozen
                    ? adminUnfreezeAccount(targetUser.id)
                    : adminFreezeAccount(targetUser.id);

            menu.appendChild(verifyBtn);
            menu.appendChild(sendNoticeBtn);
            menu.appendChild(shadowBtn);
            menu.appendChild(freezeBtn);
        }

        menu.style.top = `auto`;
        menu.style.right = 'auto';
        menu.style.transform = 'translateY(3rem)';
        const acts = document.getElementById('profile-actions');
        acts.appendChild(menu);

        setTimeout(() => {
            document.addEventListener('click', () => menu.remove(), {
                once: true,
            });
        }, 0);
    }

    async function adminToggleVerify(targetUser) {
        const newVerifyStatus = !targetUser.verify;
        const actionText = newVerifyStatus ? '認証' : '認証の取り消し';

        if (
            await showAppConfirm(
                `本当にこのユーザーの${actionText}を行いますか?`,
            )
        ) {
            const { error } = await api
                .from('user')
                .update({ verify: newVerifyStatus })
                .eq('id', targetUser.id);

            if (error) {
                showAppAlert(`${actionText}に失敗しました: ${error.message}`);
            } else {
                await showAppAlert(
                    `ユーザーの${actionText}が完了しました。\nページをリロードします。`,
                );
                window.location.reload();
            }
        }
    }

    async function adminSendNotice(targetUserId) {
        if (
            !(await showAppConfirm(
                'このユーザーへ管理者からのお知らせ通知を送信しますか？',
            ))
        )
            return;
        await sendNotification(targetUserId, 'admin_notice', {
            kind: 'route',
            value: '#notifications',
        });
        showAppAlert('通知を送信しました。');
    }

    async function adminToggleShadow(targetUser) {
        const newShadowStatus = !targetUser.shadow;
        const actionText = newShadowStatus ? '有効' : '無効';

        if (
            await showAppConfirm(
                `本当にこのユーザーの検索除外を${actionText}にしますか?`,
            )
        ) {
            const { error } = await api.rpc('admin_set_status', {
                p_id: targetUser.id,
                p_shadow: newShadowStatus,
            });

            if (error) {
                showAppAlert(`${actionText}に失敗しました: ${error.message}`);
            } else {
                await showAppAlert(
                    `ユーザーの検索除外の${actionText}化が完了しました。\nページをリロードします。`,
                );
                window.location.reload();
            }
        }
    }

    async function adminFreezeAccount(targetUserId) {
        const reason = await showAppPrompt(
            'アカウントの凍結理由を入力してください (必須):',
        );
        if (reason && reason.trim()) {
            if (
                await showAppConfirm(
                    `本当にこのユーザーを凍結しますか？\n理由: ${reason}`,
                )
            ) {
                const { error } = await api
                    .from('user')
                    .update({ freeze: reason.trim() })
                    .eq('id', targetUserId);
                if (error) {
                    showAppAlert(`凍結に失敗しました: ${error.message}`);
                } else {
                    await showAppAlert(
                        'アカウントを凍結しました。\nページをリロードします。',
                    );
                    window.location.reload();
                }
            }
        } else {
            showAppAlert('凍結理由の入力は必須です。');
        }
    }

    async function adminUnfreezeAccount(targetUserId) {
        if (!(await showAppConfirm('このユーザーの凍結を解除しますか？')))
            return;

        const { error } = await api
            .from('user')
            .update({ freeze: null })
            .eq('id', targetUserId);
        if (error) {
            showAppAlert(`凍結解除に失敗しました: ${error.message}`);
            return;
        }

        await showAppAlert('凍結を解除しました。ページをリロードします。');
        window.location.reload();
    }

    function markRealtimeSummaryFresh() {
        if (!getCurrentUser()) return;
        getCurrentUser().nav_summary_fetched_recently = true;
        if (getRealtimeSummaryFreshTimer())
            clearTimeout(getRealtimeSummaryFreshTimer());
        setRealtimeSummaryFreshTimer(
            setTimeout(() => {
                if (getCurrentUser())
                    getCurrentUser().nav_summary_fetched_recently = false;
            }, 10000),
        );
    }

    async function refreshNavSummaryFallback() {
        if (!getCurrentUser()) return;
        const { data: summary, error } = await apiRequest(
            '/server/api/ui/summary',
        );
        if (error || !summary || !getCurrentUser()) return;
        getCurrentUser().notification_unread_count = Number(
            summary.notification_unread_count || 0,
        );
        getCurrentUser().unreadDmTotal = Number(summary.dm_unread_count || 0);
        markRealtimeSummaryFresh();
        await updateNavAndSidebars();
    }

    function clearRealtimeTimers() {
        if (getRealtimeReconnectTimer())
            clearTimeout(getRealtimeReconnectTimer());
        if (getRealtimePingTimer()) clearInterval(getRealtimePingTimer());
        setRealtimeReconnectTimer(null);
        setRealtimePingTimer(null);
    }

    function stopRealtimeConnection() {
        setRealtimeShouldReconnect(false);
        clearRealtimeTimers();
        const socket = getRealtimeChannel();
        setRealtimeChannel(null);
        setRealtimeAuthKey(null);
        if (
            socket &&
            (socket.readyState === WebSocket.OPEN ||
                socket.readyState === WebSocket.CONNECTING)
        ) {
            socket.close(1000, 'Session changed');
        }
    }

    function scheduleRealtimeReconnect() {
        if (
            !getRealtimeShouldReconnect() ||
            !getCurrentUser() ||
            getRealtimeReconnectTimer()
        )
            return;
        const delay = Math.min(
            30000,
            1000 * 2 ** getRealtimeReconnectAttempts(),
        );
        setRealtimeReconnectAttempts(
            Math.min(getRealtimeReconnectAttempts() + 1, 5),
        );
        setRealtimeReconnectTimer(
            setTimeout(() => {
                setRealtimeReconnectTimer(null);
                connectRealtimeSocket();
            }, delay),
        );
    }

    function handleRealtimeEvent(event) {
        if (!getCurrentUser() || !event || typeof event.type !== 'string')
            return;
        if (event.type === 'notification_new') {
            const notification = event.notification;
            const normalizedNotification = normalizeStructuredNotification(
                event.notification,
            );
            if (
                normalizedNotification &&
                Array.isArray(getCurrentUser().notice)
            ) {
                const exists = getCurrentUser().notice.some(
                    (entry) =>
                        Number(entry.id) === Number(normalizedNotification.id),
                );
                if (!exists)
                    getCurrentUser().notice.unshift(normalizedNotification);
            }
            getCurrentUser().notification_unread_count = Number(
                event.unread_count ||
                    getCurrentUser().notification_unread_count ||
                    0,
            );
            markRealtimeSummaryFresh();
            updateNavAndSidebars();
            if (window.location.hash.startsWith('#notifications'))
                showNotificationsScreen();
            return;
        }
        if (event.type === 'notification_unread_count') {
            getCurrentUser().notification_unread_count = Number(
                event.unread_count || 0,
            );
            markRealtimeSummaryFresh();
            updateNavAndSidebars();
            return;
        }
        if (event.type === 'timeline_post') {
            if (
                event.timeline === 'following' &&
                Number(event.author_id) !== Number(getCurrentUser().id)
            ) {
                queueRealtimeTimelineUpdate();
            }
            return;
        }
        if (event.type === 'dm_message') {
            if (Number(event.message?.userid) === Number(getCurrentUser().id))
                return;
            invalidateDmCaches(event.dm_id);
            void appendRealtimeDmMessage(
                event.dm_id,
                event.message,
                event.sender || null,
            );
            return;
        }
        if (event.type === 'dm_unread_count') {
            invalidateDmCaches(
                event.dm_id !== undefined && event.dm_id !== null
                    ? event.dm_id
                    : null,
            );
            if (event.dm_id !== undefined && event.dm_id !== null) {
                // 個別DM単位の未読数通知。dm一覧に見えている該当行だけを更新し、
                // 全体合計はこのDM分の差分だけを反映する(他DMの未読数を巻き込まない)。
                const key = String(event.dm_id);
                const newCount = Number(event.unread_count || 0);
                const prevCount = getDmUnreadCounts().get(key) || 0;
                getDmUnreadCounts().set(key, newCount);
                const prevTotal = Number(getCurrentUser().unreadDmTotal || 0);
                getCurrentUser().unreadDmTotal = Math.max(
                    0,
                    prevTotal - prevCount + newCount,
                );

                const listItem = document.querySelector(
                    `.dm-list-item[data-dm-id="${CSS.escape(key)}"]`,
                );
                const prefixEl = listItem?.querySelector(
                    '.dm-list-item-unread-prefix',
                );
                if (prefixEl)
                    prefixEl.textContent = newCount > 0 ? `(${newCount}) ` : '';
            } else {
                getCurrentUser().unreadDmTotal = Number(
                    event.unread_count || 0,
                );
            }
            markRealtimeSummaryFresh();
            // 既読通知は会話本文を変更しない。開いているDMを router() で再描画すると
            // `mark_read=1` が再実行され、既読通知との循環で無限リクエストになる。
            // バッジ更新だけに限定する。
            void updateNavAndSidebars();
        }
    }

    function connectRealtimeSocket() {
        if (!getRealtimeShouldReconnect() || !getCurrentUser()) return;
        // Same-origin WebSocket handshakeにはHttpOnly Cookieが自動送信される。
        // URLクエリにBearerトークンを載せるとログ・監視基盤へ漏れるため使わない。
        const authKey = 'cookie';
        if (
            getRealtimeChannel() &&
            getRealtimeAuthKey() === authKey &&
            (getRealtimeChannel().readyState === WebSocket.OPEN ||
                getRealtimeChannel().readyState === WebSocket.CONNECTING)
        ) {
            return;
        }
        if (getRealtimeChannel()) stopRealtimeConnection();
        setRealtimeShouldReconnect(true);

        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const socket = new WebSocket(
            `${protocol}//${window.location.host}/server/realtime`,
        );
        setRealtimeChannel(socket);
        setRealtimeAuthKey(authKey);

        socket.onopen = () => {
            if (getRealtimeChannel() !== socket) return;
            setRealtimeReconnectAttempts(0);
            if (getRealtimePingTimer()) clearInterval(getRealtimePingTimer());
            setRealtimePingTimer(
                setInterval(() => {
                    if (socket.readyState === WebSocket.OPEN) {
                        socket.send(JSON.stringify({ type: 'ping' }));
                    }
                }, 25000),
            );
        };
        socket.onmessage = (message) => {
            try {
                handleRealtimeEvent(JSON.parse(message.data));
            } catch (_) {
                // Unknown or malformed events must not interrupt the current screen.
            }
        };
        socket.onerror = () => {
            // The close handler performs reconnect and HTTP fallback consistently.
        };
        socket.onclose = () => {
            if (getRealtimeChannel() !== socket) return;
            setRealtimeChannel(null);
            setRealtimeAuthKey(null);
            if (getRealtimePingTimer()) clearInterval(getRealtimePingTimer());
            setRealtimePingTimer(null);
            refreshNavSummaryFallback();
            scheduleRealtimeReconnect();
        };
    }

    function subscribeToChanges() {
        setRealtimeShouldReconnect(true);
        connectRealtimeSocket();
    }

    function unsubscribeFromChanges() {
        stopRealtimeConnection();
    }

    // アプリケーション全体のクリックイベントを処理する単一のハンドラ
    document.addEventListener('click', (e) => {
        const target = e.target;
        const hashLink = target.closest('a[href^="#"]');
        const isPlainHashNavigation =
            hashLink &&
            e.button === 0 &&
            !e.metaKey &&
            !e.ctrlKey &&
            !e.shiftKey &&
            !e.altKey;
        if (isPlainHashNavigation) {
            // href="#" の既定動作はブラウザを直ちにページ先頭へ移動させる。
            // 先にSPAのルーターへ遷移を委ね、保存済み位置の復元より後に0,0が
            // 適用される競合を防ぐ。
            e.preventDefault();
            const destinationHash = hashLink.getAttribute('href') || '#';
            const currentHash = window.location.hash || '#';
            if (destinationHash !== currentHash) {
                // ハッシュを書き換えるとブラウザが先頭へ移動することがあるため、
                // その前に直前ページを確定保存し、保存対象を解除する。
                // hashchangeで起動するrouter()はこのルートを0,0で再保存しない。
                beginScrollRouteTransition();
                window.location.hash = destinationHash;
            }
            return;
        }

        const actionTarget = target.closest('[data-action]');
        if (actionTarget?.dataset.action === 'refresh-realtime-timeline') {
            e.preventDefault();
            clearRealtimeTimelineUpdate();
            void switchTimelineTab(getCurrentTimelineTab(), {
                forceRefresh: true,
                resetScroll: true,
            });
            return;
        }
        if (actionTarget?.dataset.action === 'history-back') {
            e.preventDefault();
            window.history.back();
            return;
        }
        if (actionTarget?.dataset.action === 'open-create-dm') {
            e.preventDefault();
            window.openCreateDmModal?.();
            return;
        }
        if (actionTarget?.dataset.action === 'open-dm-manage') {
            const dmId = String(actionTarget.dataset.dmId || '').trim();
            if (dmId && dmId.length <= 128) {
                e.preventDefault();
                e.stopPropagation();
                window.openDmManageModal?.(dmId);
            }
            return;
        }
        const reportDmMessageButton = target.closest('.report-dm-message-btn');
        if (reportDmMessageButton) {
            const dmId = String(
                reportDmMessageButton.dataset.dmId || '',
            ).trim();
            const messageId = String(
                reportDmMessageButton.dataset.messageId || '',
            ).trim();
            if (
                dmId &&
                messageId &&
                dmId.length <= 128 &&
                messageId.length <= 128
            ) {
                e.preventDefault();
                e.stopPropagation();
                openReportModal({
                    targetKind: 'dm_message',
                    targetId: `${dmId}:${messageId}`,
                    targetLabel: 'このメッセージ',
                });
                reportDmMessageButton
                    .closest('.post-menu')
                    ?.classList.remove('is-visible');
            }
            return;
        }
        if (actionTarget?.dataset.action === 'open-admin-report') {
            const reportId = Number(actionTarget.dataset.reportId);
            if (Number.isInteger(reportId) && reportId > 0) {
                e.preventDefault();
                window.location.hash = `#admin/reports/${reportId}`;
            }
            return;
        }
        if (actionTarget?.dataset.action === 'open-dm') {
            const dmId = String(actionTarget.dataset.dmId || '').trim();
            if (dmId && dmId.length <= 128)
                window.location.hash = `#dm/${encodeURIComponent(dmId)}`;
            return;
        }
        if (actionTarget?.dataset.action === 'open-image') {
            const imageUrl = getSafeHttpUrl(actionTarget.dataset.url);
            if (imageUrl) {
                e.preventDefault();
                e.stopPropagation();
                window.openImageModal?.(imageUrl);
            }
            return;
        }
        if (actionTarget?.dataset.action === 'download-attachment') {
            const downloadUrl = getSafeHttpUrl(actionTarget.dataset.url);
            if (downloadUrl) {
                e.preventDefault();
                e.stopPropagation();
                window.handleDownload?.(
                    downloadUrl,
                    String(actionTarget.dataset.name || '添付ファイル').slice(
                        0,
                        255,
                    ),
                );
            }
            return;
        }

        const copyButton = target.closest('.copy-btn');
        if (copyButton) {
            e.stopPropagation();
            const parentPre = copyButton.closest('pre');
            const parentInlineWrapper = copyButton.closest(
                '.inline-code-wrapper',
            );
            let textToCopy = '';

            if (parentPre) {
                // コードブロックの場合
                textToCopy = parentPre.querySelector('code')?.textContent || '';
            } else if (parentInlineWrapper) {
                // インラインコードの場合
                textToCopy =
                    parentInlineWrapper.querySelector('code')?.textContent ||
                    '';
            }

            if (textToCopy) {
                navigator.clipboard
                    .writeText(textToCopy)
                    .then(() => {
                        const originalContent = copyButton.innerHTML;
                        copyButton.innerHTML = 'Copied!';
                        copyButton.style.minWidth = '50px';
                        copyButton.style.textAlign = 'center';
                        setTimeout(() => {
                            copyButton.innerHTML = originalContent;
                            copyButton.style.minWidth = '';
                            copyButton.style.textAlign = '';
                        }, 1500);
                    })
                    .catch((err) => {
                        console.error('Copy failed', err);
                        copyButton.innerHTML = 'Copy failed';
                    });
            }
            return; // コピーボタン処理はここで終了
        }

        const menuButton = target.closest(
            '.post-menu-btn, .dm-message-menu-btn',
        );
        if (menuButton) {
            e.stopPropagation();

            let menuToToggle;
            if (menuButton.classList.contains('dm-message-menu-btn')) {
                menuToToggle = menuButton
                    .closest('.dm-message-container')
                    ?.querySelector('.post-menu');
            } else {
                menuToToggle = menuButton
                    .closest('.post-header')
                    ?.querySelector('.post-menu');
            }

            if (menuToToggle) {
                const isCurrentlyVisible =
                    menuToToggle.classList.contains('is-visible');

                // 開いている他のメニューをすべて閉じる
                document
                    .querySelectorAll('.post-menu.is-visible')
                    .forEach((menu) => {
                        menu.classList.remove('is-visible');
                    });

                // ターゲットが閉じていた場合のみ開く
                if (!isCurrentlyVisible) {
                    if (menuButton.classList.contains('dm-message-menu-btn')) {
                        positionDmMessageMenu(menuToToggle, menuButton);
                    }
                    menuToToggle.classList.add('is-visible');
                }
            }
            return; // メニュー開閉処理はここで終了
        }
        if (!target.closest('.post-menu')) {
            const openMenus = [
                ...document.querySelectorAll('.post-menu.is-visible'),
            ];
            if (openMenus.length > 0) {
                e.preventDefault();
                e.stopImmediatePropagation();
                openMenus.forEach((menu) => {
                    menu.classList.remove('is-visible');
                });
                return;
            }
        }

        const dmEditBtn = target.closest('.edit-dm-msg-btn');
        if (dmEditBtn) {
            const container = dmEditBtn.closest('.dm-message-container');
            openDmEditModal(
                window.location.hash.substring(4),
                container.dataset.messageId,
            );
            return;
        }
        const dmDeleteBtn = target.closest('.delete-dm-msg-btn');
        if (dmDeleteBtn) {
            const container = dmDeleteBtn.closest('.dm-message-container');
            handleDeleteDmMessage(
                window.location.hash.substring(4),
                container.dataset.messageId,
            );
            return;
        }

        const postElement = target.closest('.post');
        if (postElement) {
            const timelinePostId = postElement.dataset.postId;
            const actionTargetPostId =
                postElement.dataset.actionTargetId || timelinePostId;

            const shareButton = target.closest('.share-btn');
            if (shareButton) {
                window.copyPost(timelinePostId, shareButton);
                return;
            }

            const editButton = target.closest('.edit-btn');
            if (editButton) {
                openEditPostModal(timelinePostId);
                return;
            }

            const pinButton = target.closest('.pin-btn');
            if (pinButton) {
                window.pinPost(timelinePostId);
                return;
            }

            const deleteButton = target.closest('.delete-btn');
            if (deleteButton) {
                window.deletePost(timelinePostId);
                return;
            }

            const replyButton = target.closest('.reply-button');
            if (replyButton) {
                window.handleReplyClick(
                    actionTargetPostId,
                    replyButton.dataset.username,
                );
                return;
            }

            const likeButton = target.closest('.like-button');
            if (likeButton) {
                window.handleLike(likeButton, actionTargetPostId);
                return;
            }

            const starButton = target.closest('.star-button');
            if (starButton) {
                window.handleStar(starButton, actionTargetPostId);
                return;
            }

            const repostButton = target.closest('.repost-button');
            if (repostButton) {
                api.from('post')
                    .select('*, user(id, name, scid, icon_data, admin, verify)')
                    .eq('id', actionTargetPostId)
                    .single()
                    .then(({ data }) => {
                        if (data) openRepostModal(data, repostButton);
                    });
                return;
            }

            const postAlertButton = target.closest('.post-mask-alert');
            if (postAlertButton) {
                window.handleShowMaskedPost(postAlertButton);
                return;
            }

            if (
                !target.closest('a') &&
                !target.closest('.post-menu-btn') &&
                !target.closest('.attachment-item') &&
                !target.closest('.post-clamp-toggle')
            ) {
                window.location.hash = `#post/${actionTargetPostId}`;
                return;
            }
        }

        // @メンションは通知本体のターゲットではなく、発信者プロフィールへ遷移する。
        if (target.closest('.notification-actor-link')) return;

        const notificationItem = target.closest('.notification-item');
        if (notificationItem) {
            const notificationId = notificationItem.dataset.notificationId;
            const notification = getCurrentUser().notice.find(
                (n) => Number(n.id) === Number(notificationId),
            );

            // 削除ボタンがクリックされた場合
            if (target.closest('.notification-delete-btn')) {
                e.stopPropagation();
                const wasUnread = Boolean(notification && !notification.read);
                api.rpc('delete_notification', {
                    target_user_id: getCurrentUser().id,
                    notification_id_to_delete: notificationId,
                }).then(({ error }) => {
                    if (error) {
                        console.error('通知の削除に失敗:', error);
                        showAppAlert('通知の削除に失敗しました。');
                    } else {
                        getCurrentUser().notice =
                            getCurrentUser().notice.filter(
                                (n) => n.id !== notificationId,
                            );
                        if (wasUnread)
                            getCurrentUser().notification_unread_count =
                                Math.max(
                                    0,
                                    Number(
                                        getCurrentUser()
                                            .notification_unread_count || 0,
                                    ) - 1,
                                );
                        notificationItem.remove();
                        void updateNavAndSidebars();
                    }
                });
                return;
            }

            // クリック済み状態は既読状態と独立させる。クリックしても未読バッジは減らさない。
            if (notification && !notification.clicked) {
                api.rpc('mark_notification_as_clicked', {
                    notification_id_to_update: notificationId,
                }).then(({ error }) => {
                    if (error) {
                        console.error('通知クリック状態の更新に失敗:', error);
                    } else {
                        notification.clicked = true;
                        notificationItem.classList.remove('notification-new');
                        notificationItem.classList.add('notification-clicked');
                        notificationItem.dataset.notificationClicked = 'true';
                    }
                });
            }
            if (notification) {
                window.location.hash = getNotificationTargetHash(notification);
            }
            return;
        }

        const timelineTab = target.closest('.timeline-tab-button');
        if (timelineTab) {
            clearRealtimeTimelineUpdate();
            void switchTimelineTab(timelineTab.dataset.tab, {
                forceRefresh: true,
                resetScroll: true,
            });
            return;
        }

        const bannerSignup = target.closest('#banner-signup-button');
        if (bannerSignup) {
            goToLoginPage();
            return;
        }

        const bannerLogin = target.closest('#banner-login-button');
        if (bannerLogin) {
            goToLoginPage();
            return;
        }
    });

    // 「再試行」ボタンのイベントリスナー
    DOM.retryConnectionBtn.addEventListener('click', () => {
        DOM.connectionErrorOverlay.classList.add('hidden'); // エラー表示を隠す
        checkSession(); // 再度セッションチェックを実行
    });

    window.addEventListener('hashchange', router);

    // 全ての準備が整った後、最後にセッションチェックを開始
    DOM.freezeOverlay.classList.add('hidden');
    DOM.connectionErrorOverlay.classList.add('hidden');
    void registerPwaServiceWorker();
    void (async () => {
        const handledPushOpen = await handlePendingPushNotificationOpen();
        if (!handledPushOpen) await checkSession();
    })();
}
