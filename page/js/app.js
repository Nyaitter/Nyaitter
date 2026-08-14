import * as state from './state.js';
import { api, apiRequest } from './api.js';
import { ICONS } from './icons.js';
import { DOM, showMainJsError } from './dom.js';

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
    getPOST_COUNT,
    setPOST_COUNT,
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

    function formatPostTimestamp(post) {
        const value = post?.created_at;
        const date = value ? new Date(value) : null;
        if (!date || Number.isNaN(date.getTime())) return '日時不明';

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
            if (amount > 0) parts.push(`${amount}${label}`);
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
        .then((list) => (Array.isArray(list) ? list : []))
        .catch((error) => {
            console.warn(
                '[emoji] Custom emoji list could not be loaded:',
                error,
            );
            return [];
        });

    const POSTS_PER_PAGE = 30;
    const AdPOST_PER_POSTS = 30;

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
            : '/logo.png?v=v1';
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

    async function renderDmMessage(msg) {
        const plaintext = await dmE2EDecryptMessage(msg, getCurrentUser().id);
        await ensureMentionedUsersCached([plaintext]);
        if (msg.type === 'system') {
            const formattedContent = formatPostContent(
                plaintext,
                getAllUsersCache(),
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
            ? formatPostContent(plaintext, getAllUsersCache())
            : '';
        const sent = msg.userid === getCurrentUser().id;

        if (sent) {
            return `<div class="dm-message-container sent" data-message-id="${escapeHTML(msg.id)}">
	                <div class="dm-message-wrapper">
	                    <button class="dm-message-menu-btn">…</button>
	                    <div class="post-menu">
	                        <button class="edit-dm-msg-btn">編集</button>
	                        <button class="delete-dm-msg-btn delete-btn">削除</button>
	                    </div>
	                    <div class="dm-message">${formattedContent}${attachmentsHTML}</div>
	                </div>
	            </div>`;
        } else {
            const user = getAllUsersCache().get(msg.userid) || {};
            const time = new Date(msg.created_at).toLocaleTimeString('ja-JP', {
                hour: '2-digit',
                minute: '2-digit',
            });
            return `<div class="dm-message-container received" data-message-id="${escapeHTML(msg.id)}">
	                <a href="#profile/${user.id}" class="dm-user-link">
	                    <img src="${getUserIconUrl(user)}" class="dm-message-icon">
	                </a>
	                <div class="dm-message-wrapper">
	                    <div class="dm-message-meta">
	                        <a href="#profile/${user.id}" class="dm-user-link">${getEmoji(escapeHTML(user.name || '不明'))}</a>
	                        ・${time}
	                    </div>
	                    <div class="dm-message">${formattedContent}${attachmentsHTML}</div>
	                </div>
	            </div>`;
        }
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

        const messageHtml = await renderDmMessage(message);
        if (
            !isActiveDmConversation(dmId) ||
            hasRenderedDmMessage(view, message.id)
        )
            return;
        view.insertAdjacentHTML('afterbegin', messageHtml);
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
        return {
            id,
            type:
                typeof notification.type === 'string'
                    ? notification.type
                    : 'admin_notice',
            from,
            target,
            read: Boolean(notification.read),
            clicked: Boolean(notification.clicked),
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
        if (notification.type === 'login_approval')
            return '不明な場所からのログイン承認が必要です。';
        const suffix = getNotificationMessageSuffix(notification);
        return suffix
            ? `${notificationActorLabel(notification)}${suffix}`
            : '新しい通知があります。';
    }

    function appendNotificationDisplay(content, notification) {
        const actorId = Number(notification.from?.id);
        const suffix = getNotificationMessageSuffix(notification);
        if (!Number.isInteger(actorId) || !suffix) {
            content.textContent = getNotificationDisplayText(notification);
            return;
        }

        const actorLink = document.createElement('a');
        actorLink.className = 'notification-actor-link';
        actorLink.href = `#profile/${actorId}`;
        actorLink.textContent = notificationActorLabel(notification);
        content.append(actorLink, document.createTextNode(suffix));
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

    function formatPostContent(text, userCache = new Map()) {
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

            const emojiRegex = /(?<!\w)_([A-Za-z0-9_-]{1,80})_(?!\w)/g;
            processed = processed.replace(emojiRegex, (match, emojiId) => {
                return `<img src="/emoji/${encodeURIComponent(emojiId)}.svg" alt="_${emojiId}_" style="height: 1.2em; vertical-align: -0.2em; margin: 0 0.05em;" class="nyaitter-emoji">`;
            });

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

        return processStandardText(text);
    }
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
                author.block.includes(getCurrentUser().id)
            ) {
                // 自分がadminのときだけ規制を通過
                if (getCurrentUser().admin) {
                    return true;
                } else {
                    return false;
                }
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
        const textarea = container.querySelector('textarea');
        if (!picker || !pickerButton || !textarea) return;

        const emojiMart = window.EmojiMart;
        if (!emojiMart?.Picker) {
            pickerButton.disabled = true;
            pickerButton.title = '絵文字ピッカーを読み込めませんでした';
            return;
        }

        const pickerOptions = {
            onEmojiSelect: (emoji) => {
                const textStart = textarea.selectionStart;
                const textEnd = textarea.selectionEnd;
                const text = textarea.value;
                let value;
                if (
                    Array.isArray(emoji.keywords) &&
                    emoji.keywords.includes('NyaitterEmoji')
                ) {
                    const before = text.slice(0, textStart);
                    const after = text.slice(textEnd);
                    const prefix = isNotBlank(before.slice(-1)) ? ' ' : '';
                    const suffix =
                        isNotBlank(after.slice(0, 1)) || after.length === 0
                            ? ' '
                            : '';
                    value = `${prefix}_${emoji.id}_${suffix}`;
                } else {
                    value = String(emoji.native || '');
                }
                if (!value) return;
                textarea.value =
                    text.slice(0, textStart) + value + text.slice(textEnd);
                textarea.focus();
                textarea.setSelectionRange(
                    textStart + value.length,
                    textStart + value.length,
                );
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
                    svg: `<svg viewBox="0 0 1 1" aria-label="Nyaitter"><image href="/logo.png?v=v1" width="1" height="1" preserveAspectRatio="xMidYMid meet"></image></svg>`,
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
        textarea.addEventListener('focus', () =>
            picker.classList.add('hidden'),
        );
    }

    async function router() {
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
        const hash = window.location.hash || '#';
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
            else if (hash === '#admin/logs' && getCurrentUser()?.admin)
                await showAdminLogsScreen();
            else if (hash.startsWith('#dm/') && getCurrentUser())
                await showDmScreen(hash.substring(4));
            else if (hash === '#dm' && getCurrentUser()) await showDmScreen();
            else if (hash === '#settings' && getCurrentUser())
                await showSettingsScreen();
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
            console.error('Routing error:', error);
            DOM.pageHeader.innerHTML = `<h2>エラー</h2>`;
            showScreen('main-screen');
            DOM.timeline.innerHTML = `<p class="error-message">ページの読み込み中にエラーが発生しました。</p>`;
        } finally {
            // `showAdminLogsScreen`内で個別にローディングを解除するため、ここでの一括解除は不要
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
        if (!getRecommendedUsersCache()) {
            let query = api.from('user').select('id, name, scid, icon_data');
            if (getCurrentUser()) query = query.neq('id', getCurrentUser().id);
            const result = await query
                .order('created_at', { ascending: false })
                .limit(3);
            error = result.error;
            if (!error)
                setRecommendedUsersCache(
                    Array.isArray(result.data) ? result.data : [],
                );
        }

        const data = getRecommendedUsersCache() || [];

        const linkItems = [
            { name: 'Nyaitterルール', link: '/rule' },
            { name: '統計', link: '/stat' },
            { name: '申請フォーム', link: '/forms' },
            { name: 'Emoji一覧', link: '/emoji' },
            { name: 'Discord鯖', link: '/discord' },
        ];

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

        DOM.rightSidebar.links.innerHTML = linkItems
            .map((item) => {
                return `
	            <a href="${item.link}" class="link">${item.name}</a>
	            `;
            })
            .join('');
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
                getCurrentUser().unreadDmTotal ||
                    getCurrentUser().dm_unread_count ||
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
                { name: '設定', hash: '#settings', icon: ICONS.settings },
            );
        }

        DOM.navLogo.innerHTML = `<a href="#" class="nav-logo-img">${ICONS.nyaitter_logo}</a>`;

        DOM.navMenuTop.innerHTML = menuItems
            .map((item) => {
                let isActive = false;
                if (item.hash === '#') {
                    isActive = hash === '#' || hash === '';
                } else {
                    isActive = hash.startsWith(item.hash);
                }
                return `
	                <a href="${item.hash}" class="nav-item ${isActive ? 'active' : ''}">
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
        loadRightSidebar();
    }

    function goToLoginPage() {
        if (typeof window.openNyaitterLoginModal === 'function') {
            window.openNyaitterLoginModal({ reset: false });
            return;
        }
        window.location.href = '/login';
    }
    function handleLogout() {
        if (!confirm('ログアウトしますか？')) return;
        const userId = getCurrentUser()?.id;
        if (userId) removeAccountFromList(userId);
        api.auth.signOut().then(() => {
            setCurrentUser(null);
            unsubscribeFromChanges();
            window.location.hash = '#';
            router();
        });
    }
    async function checkSession() {
        const {
            data: { session },
            error: sessionError,
        } = await api.auth.getSession();

        if (sessionError || !session) {
            setCurrentUser(null);
            unsubscribeFromChanges();
            router();
            return;
        }

        if (session) {
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
                    return;
                }

                // DM E2E暗号化用の鍵ペアを準備（公開鍵をサーバーに登録）。
                void dmE2EEnsureKeyPairRegistered(getCurrentUser().id);

                addAccountToList(getCurrentUser());
                subscribeToChanges();
                router();
            } catch (error) {
                console.error(error);
                setCurrentUser(null);
                DOM.connectionErrorOverlay.classList.remove('hidden');
            }
        } else {
            setCurrentUser(null);
            router();
        }
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
                    if (!confirm('この端末からアカウントを解除しますか？'))
                        return;
                    const { data: result, error: removeError } =
                        await apiRequest(
                            `/server/auth/accounts/${encodeURIComponent(userId)}`,
                            { method: 'DELETE' },
                        );
                    if (removeError)
                        return alert(
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
                                alert(
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
                    return alert(
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
                alert(
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
        modalContainer.querySelector('textarea').focus();
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
        if (!getCurrentUser()) return alert('ログインが必要です。');
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

            router(); // タイムラインを更新
        } catch (e) {
            console.error(e);
            const friendlyMessage = e.message.replace(/^Error: /, '');
            alert(`リポストに失敗しました: ${friendlyMessage}`);
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
	                    <textarea id="post-content" placeholder="いまどうしてる？" maxlength="280"></textarea>
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
        container
            .querySelector('#post-submit-button')
            .addEventListener('click', () => handlePostSubmit(container));
        container
            .querySelector('textarea')
            .addEventListener('keydown', handleCtrlEnter);
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

    async function handleFileSelection(event, container) {
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

        setSelectedFiles(compressedFiles);

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

    async function handlePostSubmit(container) {
        if (!getCurrentUser()) return alert('ログインが必要です。');
        const contentEl = container.querySelector('textarea');
        const content = contentEl.value.trim();
        if (!content && getSelectedFiles().length === 0 && !getQuotingPost())
            return alert('内容を入力するか、ファイルを添付してください。');

        const maskActive = container
            .querySelector('.post-mask-button')
            .classList.contains('active');
        const lockActive = container
            .querySelector('.post-lock-button')
            .classList.contains('active');

        const button = container.querySelector('#post-submit-button');
        button.disabled = true;
        button.textContent = '投稿中...';
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
            setSelectedFiles([]);
            contentEl.value = '';
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
            alert(`投稿に失敗しました: ${e.message}`);
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
            alert('ファイルのダウンロードに失敗しました。');
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

        setPOST_COUNT(getPOST_COUNT() + 1);

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
                        menuBtn.className = 'post-menu-btn';
                        menuBtn.innerHTML = '…';
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

        if (getCurrentUser() && !isNested) {
            const menuBtn = document.createElement('button');
            menuBtn.className = 'post-menu-btn';
            menuBtn.innerHTML = '…';
            const menu = document.createElement('div');
            menu.className = 'post-menu';

            const shareBtn = document.createElement('button');
            shareBtn.className = 'share-btn';
            shareBtn.textContent = 'URLをコピー';
            menu.appendChild(shareBtn);

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
                    );
                    postMain.appendChild(masktitle);
                    postContent.innerHTML = formatPostContent(
                        post.content.slice(1),
                        userCache,
                    );
                } else {
                    postContent.innerHTML = formatPostContent(
                        post.content,
                        userCache,
                    );
                }
            } else {
                postContent.innerHTML = formatPostContent(
                    post.content,
                    userCache,
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

                // 挿入後に実測し、はみ出している場合だけボタンを表示する。
                const measure = () => {
                    if (!postEl.isConnected || !contentEl.isConnected)
                        return null;
                    if (contentEl.scrollHeight > contentEl.clientHeight + 1) {
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

    function createAdPostHTML() {
        const adContainer = document.createElement('div');
        adContainer.className = 'post ad-post';

        // iframeを使った広告描画用のHTML
        adContainer.innerHTML = `
	            <div class="user-icon-link">
	                <img src="logo.png?v=v1" class="user-icon" alt="広告アイコン">
	            </div>
	            <div class="post-main">
	                <div class="post-header">
	                    <span class="post-author">[広告]</span>
	                </div>
	                <div class="post-content">
	                    <p>広告は新機能の準備のため停止中です。</p>
	                </div>
	            </div>
	        `;

        // 広告ポスト全体のクリックイベントを止める
        adContainer.addEventListener(
            'click',
            (e) => {
                e.stopPropagation();
            },
            true,
        );

        return adContainer;
    }

    async function showMainScreen() {
        DOM.pageHeader.innerHTML = `<h2 id="page-title">ホーム</h2>`;
        showScreen('main-screen');

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
            const userResultsContainer = document.createElement('div');
            contentDiv.appendChild(userResultsContainer);
            userResultsContainer.innerHTML = '<div class="spinner"></div>';

            const filters = [
                `name.ilike.%${query}%`,
                `nyaitter_id.ilike.%${query}%`,
                `scid.ilike.%${query}%`,
                `me.ilike.%${query}%`,
            ];
            // #1234 と 1234 のどちらでもNyaitter IDを優先して検索する
            const nyaitterIdQuery = String(query).replace(/^#/, '');
            if (/^\d+$/.test(nyaitterIdQuery)) {
                filters.unshift(`id.eq.${Number(nyaitterIdQuery)}`);
            }

            const { data: users, error: userError } = await api
                .from('user')
                .select('id, name, scid, me, icon_data, settings')
                .or(filters.join(','))
                .order('id', { ascending: true })
                .limit(10);
            if (userError) console.error('ユーザー検索エラー:', userError);

            userResultsContainer.innerHTML = '';
            if (users && users.length > 0) {
                users.forEach((u) => {
                    const userCard = document.createElement('div');
                    userCard.className = 'profile-card widget-item';
                    const userLink = document.createElement('a');
                    userLink.href = `#profile/${u.id}`;
                    userLink.className = 'profile-link';
                    userLink.style.cssText =
                        'display:flex; align-items:center; gap:0.8rem; text-decoration:none; color:inherit;';
                    userLink.innerHTML = `<img src="${getUserIconUrl(u)}" style="width:48px; height:48px; border-radius:50%;" alt="${escapeHTML(u.name)}'s icon"><div><span class="name" style="font-weight:700;">${getEmoji(escapeHTML(u.name))}</span><span class="id" style="color:var(--secondary-text-color);">${getNyaitterId(u)}</span><p class="me" style="margin:0.2rem 0 0;">${getEmoji(escapeHTML(u.me || ''))}</p></div>`;
                    userCard.appendChild(userLink);
                    userResultsContainer.appendChild(userCard);
                });
            } else {
                userResultsContainer.innerHTML = `<p style="padding:1rem; text-align:center;">ユーザーは見つかりませんでした。</p>`;
            }
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
            await loadPostsWithPagination(postResultsContainer, 'search', {
                query,
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
                if (!confirm('すべての通知を既読にしますか？')) return;

                showLoading(true);
                try {
                    const { data, error } = await api.rpc(
                        'mark_all_notifications_as_read',
                        {
                            p_user_id: getCurrentUser().id,
                        },
                    );
                    if (error) throw error;

                    if (getCurrentUser().notice) {
                        getCurrentUser().notice.forEach((n) => (n.read = true));
                    }
                    getCurrentUser().notification_unread_count = Number(
                        data?.notification_unread_count || 0,
                    );
                    await showNotificationsScreen();
                    await updateNavAndSidebars();
                } catch (e) {
                    console.error('すべて既読処理でエラー:', e);
                    alert('処理中にエラーが発生しました。');
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
        await loadPostsWithPagination(DOM.likesContent, 'likes', {
            ids: getCurrentUser().like,
        });
        showLoading(false);
    }
    async function showStarsScreen() {
        DOM.pageHeader.innerHTML = `<h2 id="page-title">お気に入り</h2>`;
        showScreen('stars-screen');
        DOM.starsContent.innerHTML = '';
        await loadPostsWithPagination(DOM.starsContent, 'stars', {
            ids: getCurrentUser().star,
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

                    if (getPOST_COUNT() >= AdPOST_PER_POSTS) {
                        setPOST_COUNT(0);
                        const adPostEl = createAdPostHTML();
                        if (adPostEl) repliesContainer.appendChild(adPostEl);
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

            repliesLoadObserver.observe(trigger);
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
                const { data: dmPayload, error } =
                    await apiRequest('/server/api/dm');
                if (error) throw error;
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
	                                <button class="dm-manage-btn" data-action="open-dm-manage" data-dm-id="${escapeHTML(String(dm.id))}">…</button>
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
            const { data: dmPayload, error } = await apiRequest(
                `/server/api/dm/${encodeURIComponent(dmId)}?mark_read=1`,
            );
            const dm = Array.isArray(dmPayload?.dm) ? dmPayload.dm[0] : null;
            for (const member of dmPayload?.members || []) {
                getAllUsersCache().set(member.id, member);
            }
            setActiveDmMemberIds(
                Array.isArray(dm?.member) ? dm.member.map(Number) : [],
            );
            getCurrentUser().unreadDmTotal = Number(
                dmPayload?.unread_total || 0,
            );
            if (dm) getDmUnreadCounts().set(String(dm.id), 0);
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
	                    <button class="dm-manage-btn" style="font-size: 1.2rem;" data-action="open-dm-manage" data-dm-id="${escapeHTML(String(dm.id))}">…</button>
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
                    .map((msg) => renderDmMessage(msg)),
            );
            const messagesHTML = messagesHTMLArray.join('');

            container.innerHTML = `
	                <div class="dm-conversation-view">${messagesHTML}</div>
	                <div class="dm-message-form">
	                    <div class="dm-form-content">
	                        <textarea id="dm-message-input" placeholder="メッセージを送信"></textarea>
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

            const messageInput = document.getElementById('dm-message-input');
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
	                    </div>
	                    <div class="profile-info">
	                        <h2>${getEmoji(escapeHTML(user.name))}</h2>
						<div class="user-id" title="Nyaitter ID">${getNyaitterId(user)}</div>
	                    </div>`;
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
                    menuButton.className = 'profile-menu-button dm-button'; // dm-buttonのスタイルを流用
                    menuButton.innerHTML = '…';
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
                    loadProfileTabContent(user, button.dataset.tab);
                };
            });

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
                        loadProfileTabContent(user, button.dataset.subTab);
                    };
                });
        } else {
            document
                .querySelectorAll('#profile-tabs .tab-button')
                .forEach((btn) =>
                    btn.classList.toggle('active', btn.dataset.tab === subpage),
                );
        }

        let newUrl =
            subpage === 'posts'
                ? `#profile/${user.id}`
                : `#profile/${user.id}/${subpage}`;
        if (window.location.hash !== newUrl) {
            window.history.pushState({ path: newUrl }, '', newUrl);
        }

        try {
            switch (subpage) {
                case 'posts':
                    await loadPostsWithPagination(contentDiv, 'profile_posts', {
                        userId: user.id,
                        subType: 'posts_only',
                        pinId: user.pinned_post_id,
                    });
                    break;
                case 'replies':
                    await loadPostsWithPagination(contentDiv, 'profile_posts', {
                        userId: user.id,
                        subType: 'replies_only',
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

    async function showSettingsScreen() {
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
	                        <button type="button" class="settings-group-button active" data-settings-group="profile" data-settings-title="プロフィール">プロフィール</button>
	                        <button type="button" class="settings-group-button" data-settings-group="privacy" data-settings-title="プライバシーとセキュリティ">プライバシーとセキュリティ</button>
	                        <button type="button" class="settings-group-button" data-settings-group="ui" data-settings-title="UI / フォント">UI / フォント</button>
	                        <button type="button" class="settings-group-button" data-settings-group="notifications" data-settings-title="通知">通知</button>
	                        <button type="button" class="settings-group-button" data-settings-group="api" data-settings-title="API / Bot">API / Bot</button>
	                        <button type="button" class="settings-group-button" data-settings-group="resources" data-settings-title="リソース">リソース</button>
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
	                            <label for="setting-emoji-kind">絵文字のフォント</label>
	                            <select id="setting-emoji-kind" class="settings-select">
	                                <option value="twemoji">Twemoji</option><option value="emojione">Emoji One</option><option value="default">デフォルト（端末絵文字）</option>
	                            </select>
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
	                                    <p class="settings-help-text">HTTPリクエストの <code>Authorization</code> ヘッダー（または <code>X-API-Key</code> ヘッダー / クエリパラメータ <code>?token=</code>）に指定してください。</p>
	                                    <pre class="settings-code-example"><code>curl -X POST ${window.location.origin}/server/api/posts \\
  -H "Authorization: Bearer bot_..." \\
  -H "Content-Type: application/json" \\
  -d '{"content": "Hello from Bot!"}'</code></pre>
	                                </div>
	                            </div>
	                        </section>
	                        <section class="settings-group-panel" data-settings-panel="resources" hidden>
	                        </section>
	                    </form>
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

        const emoji_kind = getCurrentUser().settings?.emoji || 'twemoji';
        document.getElementById('setting-emoji-kind').value = emoji_kind;

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
            if (group === 'api') {
                void loadUserBotTokens();
            }
        };
        document
            .querySelectorAll('.settings-group-button')
            .forEach((button) => {
                button.addEventListener('click', () =>
                    selectSettingsGroup(button.dataset.settingsGroup),
                );
            });
        selectSettingsGroup('profile');

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
                        !confirm(
                            session.current
                                ? 'この端末のセッションを無効化してログアウトしますか？'
                                : 'このセッションを無効化しますか？',
                        )
                    )
                        return;
                    const { data: result, error: invalidateError } =
                        await apiRequest(
                            `/server/auth/sessions/${encodeURIComponent(session.id)}`,
                            { method: 'DELETE' },
                        );
                    if (invalidateError)
                        return alert(
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
                            !confirm(
                                'このIPアドレスの信頼を取り消し、同じIPアドレスの全セッションを無効化しますか？',
                            )
                        )
                            return;
                        const { data: result, error: revokeError } =
                            await apiRequest(
                                `/server/auth/sessions/${encodeURIComponent(session.id)}/revoke-ip`,
                                { method: 'POST' },
                            );
                        if (revokeError)
                            return alert(
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
        void loadLoginSecuritySessions();

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
                        !confirm(
                            `APIキー「${token.name || token.tokenId}」を無効化しますか？\n無効化するとこのキーを使用したBotはアクセスできなくなります。`,
                        )
                    )
                        return;
                    revokeBtn.disabled = true;
                    const { error: revokeError } = await apiRequest(
                        `/server/auth/bot-tokens/${encodeURIComponent(token.tokenId)}`,
                        { method: 'DELETE' },
                    );
                    if (revokeError) {
                        alert(
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
                        alert(`APIキーの生成に失敗しました: ${error.message}`);
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
                            alert(
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
        void loadPushSettingsState();
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

    async function fetchOptimizedPostPage(type, options, page) {
        const params = new URLSearchParams({
            limit: String(POSTS_PER_PAGE),
            offset: String(page * POSTS_PER_PAGE),
        });
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
            showPinPost,
            context: data.context || null,
        };
    }

    async function loadPostsWithPagination(container, type, options = {}) {
        let localPostLoadObserver;
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
                const optimizedPage = await fetchOptimizedPostPage(
                    type,
                    options,
                    getCurrentPagination().page,
                );
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
                                    .eq('userid', 2525)
                                    .ilike('content', '%#NXAnnounce%')
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
                        if (getPOST_COUNT() >= AdPOST_PER_POSTS) {
                            setPOST_COUNT(0);
                            const adPostEl = createAdPostHTML();
                            if (adPostEl) currentTrigger.before(adPostEl);
                        }
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

        localPostLoadObserver.observe(trigger);
    }

    async function loadUsersWithPagination(container, type, options = {}) {
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

            const from = getCurrentPagination().page * POSTS_PER_PAGE;
            const to = from + POSTS_PER_PAGE - 1;

            let users = [];
            let error = null;

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
                    const idsToFetch = (options.ids || []).slice(from, to + 1);
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
                    `/server/api/users/${encodeURIComponent(options.userId)}/followers?limit=${POSTS_PER_PAGE}&offset=${from}`,
                );
                users = Array.isArray(result.data?.followers)
                    ? result.data.followers
                    : [];
                error = result.error;
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
                    if (users.length < POSTS_PER_PAGE) {
                        getCurrentPagination().hasMore = false;
                    }
                } else {
                    getCurrentPagination().hasMore = false;
                }

                if (!getCurrentPagination().hasMore) {
                    const emptyMessages = {
                        follows: '誰もフォローしていません。',
                        followers: 'まだフォロワーがいません。',
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

        getPostLoadObserver().observe(trigger);
    }

    async function switchTimelineTab(tab) {
        if (tab === 'following' && !getCurrentUser()) return;
        setIsLoadingMore(false); // 読み込み状態をリセット
        setCurrentTimelineTab(tab);
        document
            .querySelectorAll('.timeline-tab-button')
            .forEach((btn) =>
                btn.classList.toggle('active', btn.dataset.tab === tab),
            );

        if (getPostLoadObserver()) getPostLoadObserver().disconnect();
        DOM.timeline.innerHTML = '';
        await loadPostsWithPagination(DOM.timeline, 'timeline', { tab });
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
                    emoji: form.querySelector('#setting-emoji-kind').value,
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

        if (!getCurrentUser()) return alert('ログインが必要です。');
        if (!getCurrentUser().pin || getCurrentUser().pin !== postId) {
            cmessage = 'このポストをピン留めしますか?';
            emessage = 'ポストのピン留め';
        } else {
            cmessage = 'このポストのピン留めを解除しますか?';
            emessage = 'ポストのピン留めの解除';
        }
        if (!confirm(cmessage)) return;
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
            router();
        } catch (e) {
            console.error(e);
            alert(`${emessage}に失敗しました。`);
        } finally {
            showLoading(false);
        }
    };
    window.deletePost = async (postId) => {
        if (!getCurrentUser()) return alert('ログインが必要です。');
        if (!confirm('このポストを削除しますか?')) return;
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

            router();
        } catch (e) {
            console.error(e);
            alert('削除に失敗しました。');
        } finally {
            showLoading(false);
        }
    };
    window.handleReplyClick = (postId, username) => {
        if (!getCurrentUser()) return alert('ログインが必要です。');
        openPostModal({ id: postId, name: username });
    };
    window.handleLike = async (button, postId) => {
        if (!getCurrentUser()) return alert('ログインが必要です。');
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

            countSpan.textContent = isLiked
                ? currentCount + 1
                : currentCount - 1;
            button.classList.toggle('liked', isLiked);
        } catch (e) {
            console.error('いいね更新エラー:', e);
            alert('いいねの更新に失敗しました。');
        } finally {
            button.disabled = false;
        }
    };
    window.handleStar = async (button, postId) => {
        if (!getCurrentUser()) return alert('ログインが必要です。');
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

            countSpan.textContent = isStarred
                ? currentCount + 1
                : currentCount - 1;
            button.classList.toggle('starred', isStarred);
        } catch (e) {
            console.error('お気に入り更新エラー:', e);
            alert('お気に入りの更新に失敗しました。');
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
        if (!getCurrentUser()) return alert('ログインが必要です。');
        button.disabled = true;

        try {
            const { data, error } = await api.rpc('handle_follow', {
                p_target_id: targetUserId,
            });

            if (error) throw error;

            const isFollowing = data.following;
            getCurrentUser().follow = data.updated_follows;

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
            alert('フォロー状態の更新に失敗しました。');
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
	                        <textarea id="edit-post-textarea" class="post-form-textarea">${escapeHTML(String(post.content || ''))}</textarea>
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
            alert(e.message);
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
            alert('タイトルの更新に失敗しました。');
        } else {
            alert('タイトルを更新しました。');
            DOM.dmManageModal.classList.add('hidden');
            openDmManageModal(dmId); // モーダルを再描画
        }
    }

    async function handleRemoveDmMember(
        dmId,
        userIdToRemove,
        userNameToRemove,
    ) {
        if (!confirm(`${userNameToRemove}さんをDMから削除しますか?`)) return;

        const { data: dm } = await api
            .from('dm')
            .select('member')
            .eq('id', dmId)
            .single();
        const updatedMembers = dm.member.filter((id) => id !== userIdToRemove);

        const { error } = await api
            .from('dm')
            .update({ member: updatedMembers })
            .eq('id', dmId);
        if (error) {
            alert('メンバーの削除に失敗しました。');
        } else {
            await sendSystemDmMessage(
                dmId,
                `@${getCurrentUser().id}さんが@${userIdToRemove}さんを強制退出させました`,
            );
            void sendNotification(userIdToRemove, 'dm_removed', {
                kind: 'dm',
                id: dmId,
            });
            alert('メンバーを削除しました。');
            openDmManageModal(dmId); // モーダルを再描画
        }
    }

    async function handleSetHostDmMember(dmId, userIdToHost, userNameToHost) {
        if (!confirm(`${userNameToHost}さんに管理者権限を譲渡しますか?`))
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
            alert('権限の譲渡に失敗しました。');
        } else {
            void sendNotification(userIdToHost, 'dm_host_transfer', {
                kind: 'dm',
                id: dmId,
            });
            alert('権限を譲渡しました。');
            openDmManageModal(dmId); // モーダルを再描画
        }
    }

    async function handleAddDmMember(dmId, userIdToAdd, userNameToAdd) {
        if (!confirm(`${userNameToAdd}さんをDMに追加しますか？`)) return;

        const { data: dm } = await api
            .from('dm')
            .select('member')
            .eq('id', dmId)
            .single();
        if (dm.member.includes(userIdToAdd)) {
            alert('このユーザーは既にメンバーです。');
            return;
        }
        const updatedMembers = [...dm.member, userIdToAdd];

        const { error } = await api
            .from('dm')
            .update({ member: updatedMembers })
            .eq('id', dmId);
        if (error) {
            alert('メンバーの追加に失敗しました。');
        } else {
            await sendSystemDmMessage(
                dmId,
                `@${getCurrentUser().id}さんが@${userIdToAdd}さんを招待しました`,
            );
            void sendNotification(userIdToAdd, 'dm_invite', {
                kind: 'dm',
                id: dmId,
            });
            alert('メンバーを追加しました。');
            openDmManageModal(dmId); // モーダルを再描画
        }
    }

    async function handleLeaveDm(dmId) {
        if (!confirm('本当にこのDMから退出しますか？')) return;
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

            alert('DMから退出しました。');
            DOM.dmManageModal.classList.add('hidden');

            window.location.hash = '#dm';
            await showDmScreen();
        } catch (e) {
            console.error('DMからの退出に失敗しました:', e);
            alert('DMからの退出に失敗しました。');
        } finally {
            showLoading(false);
        }
    }

    async function handleDisbandDm(dmId) {
        if (!confirm('本当にこのDMを解散しますか？この操作は取り消せません。'))
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

            alert('DMを解散しました。');
            DOM.dmManageModal.classList.add('hidden');
            window.location.hash = '#dm';
            await showDmScreen();
        } catch (e) {
            console.error(e);
            alert('DMの解散に失敗しました。');
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
        const newContent = DOM.editPostModal
            .querySelector('#edit-post-textarea')
            .value.trim();
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
            return alert('内容を入力するか、ファイルを添付してください。');

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
            router(); // 画面を再読み込みして変更を反映
        } catch (e) {
            console.error(e);
            alert('ポストの更新に失敗しました。');
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
            if (!confirm(`${targetUser.name}さんとのDMを開始しますか？`))
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
            window.location.hash = `#dm/${result.dm.id}`;
            await router();
        } catch (error) {
            console.error('DMの作成に失敗しました:', error);
            alert(`DMの作成に失敗しました: ${error.message}`);
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
	                        <textarea id="edit-dm-textarea" style="min-height: 100px; font-size: 1rem;">${escapeHTML(String(messagePlaintext))}</textarea>
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
            alert(e.message);
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
        const newContent = DOM.editDmMessageModal
            .querySelector('#edit-dm-textarea')
            .value.trim();
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
            // E2Eメッセージは編集後に全メンバー向けへ再暗号化する。
            if (targetMessage.e2e) {
                await dmE2EEnsureKeyPairRegistered(getCurrentUser().id);
                const e2e = await dmE2EEncryptContent(
                    newContent,
                    getActiveDmMemberIds(),
                    getCurrentUser().id,
                );
                if (e2e) {
                    targetMessage.e2e = e2e;
                    targetMessage.content = '';
                } else {
                    delete targetMessage.e2e;
                    targetMessage.content = newContent;
                }
            } else {
                targetMessage.content = newContent;
            }
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
                );
            }
        } catch (e) {
            console.error(e);
            alert('メッセージの更新に失敗しました。');
        } finally {
            button.disabled = false;
            button.textContent = '保存';
            showLoading(false);
        }
    }

    async function handleDeleteDmMessage(dmId, messageId) {
        if (!confirm('このメッセージを削除しますか?')) return;
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
            alert('メッセージの削除に失敗しました。');
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
        const content = input.value.trim();
        if (!content && files.length === 0) return;
        if (content.length > 2000) {
            alert('DMの内容は2000文字以下にしてください。');
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

            // E2E暗号化（全メンバーの公開鍵が揃っていれば平文を送信しない）
            await dmE2EEnsureKeyPairRegistered(getCurrentUser().id);
            const e2e = await dmE2EEncryptContent(
                content,
                getActiveDmMemberIds(),
                getCurrentUser().id,
            );
            if (e2e) {
                message.content = '';
                message.e2e = e2e;
            }

            const { error } = await api.rpc('append_to_dm_post', {
                dm_id_in: dmId,
                new_message_in: message,
            });

            if (error) {
                throw error;
            } else {
                input.value = '';
                const view = document.querySelector('.dm-conversation-view');
                if (view) {
                    const msgHTML = await renderDmMessage(message);
                    view.insertAdjacentHTML('afterbegin', msgHTML);
                    setLastRenderedMessageId(message.id);
                    view.scrollTop = view.scrollHeight;
                }
            }
        } catch (error) {
            alert('メッセージの送信に失敗しました。');
            console.error(error);
        } finally {
            input.disabled = false;
            sendButton.disabled = false;
            input.focus();
        }
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
                    menu.remove();
                    await showProfileScreen(targetUser.id);
                } else {
                    alert('ブロック操作に失敗しました');
                    blockBtn.disabled = false;
                }
            };
            menu.appendChild(blockBtn);
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
            freezeBtn.textContent = 'アカウントを凍結';
            freezeBtn.className = 'delete-btn';
            freezeBtn.onclick = () => adminFreezeAccount(targetUser.id);

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

        if (confirm(`本当にこのユーザーの${actionText}を行いますか?`)) {
            const { error } = await api
                .from('user')
                .update({ verify: newVerifyStatus })
                .eq('id', targetUser.id);

            if (error) {
                alert(`${actionText}に失敗しました: ${error.message}`);
            } else {
                alert(
                    `ユーザーの${actionText}が完了しました。\nページをリロードします。`,
                );
                window.location.reload();
            }
        }
    }

    async function adminSendNotice(targetUserId) {
        if (!confirm('このユーザーへ管理者からのお知らせ通知を送信しますか？'))
            return;
        await sendNotification(targetUserId, 'admin_notice', {
            kind: 'route',
            value: '#notifications',
        });
        alert('通知を送信しました。');
    }

    async function adminToggleShadow(targetUser) {
        const newShadowStatus = !targetUser.shadow;
        const actionText = newShadowStatus ? '有効' : '無効';

        if (confirm(`本当にこのユーザーの検索除外を${actionText}にしますか?`)) {
            const { error } = await api.rpc('admin_set_status', {
                p_id: targetUser.id,
                p_shadow: newShadowStatus,
            });

            if (error) {
                alert(`${actionText}に失敗しました: ${error.message}`);
            } else {
                alert(
                    `ユーザーの検索除外の${actionText}化が完了しました。\nページをリロードします。`,
                );
                window.location.reload();
            }
        }
    }

    async function adminFreezeAccount(targetUserId) {
        const reason = prompt('アカウントの凍結理由を入力してください (必須):');
        if (reason && reason.trim()) {
            if (
                confirm(`本当にこのユーザーを凍結しますか？\n理由: ${reason}`)
            ) {
                const { error } = await api
                    .from('user')
                    .update({ freeze: reason.trim() })
                    .eq('id', targetUserId);
                if (error) {
                    alert(`凍結に失敗しました: ${error.message}`);
                } else {
                    alert(
                        'アカウントを凍結しました。\nページをリロードします。',
                    );
                    window.location.reload();
                }
            }
        } else {
            alert('凍結理由の入力は必須です。');
        }
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
        if (event.type === 'dm_message') {
            if (Number(event.message?.userid) === Number(getCurrentUser().id))
                return;
            void appendRealtimeDmMessage(
                event.dm_id,
                event.message,
                event.sender || null,
            );
            return;
        }
        if (event.type === 'dm_unread_count') {
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

        const actionTarget = target.closest('[data-action]');
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
                    menuToToggle.classList.add('is-visible');
                }
            }
            return; // メニュー開閉処理はここで終了
        }
        if (!target.closest('.post-menu')) {
            document
                .querySelectorAll('.post-menu.is-visible')
                .forEach((menu) => {
                    menu.classList.remove('is-visible');
                });
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
                        alert('通知の削除に失敗しました。');
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
            switchTimelineTab(timelineTab.dataset.tab);
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
    checkSession();
}
