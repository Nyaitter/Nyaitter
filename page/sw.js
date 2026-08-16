const STATIC_ASSET_PATTERN = /\.(?:html|css|js|mjs|json|webmanifest|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|otf)$/i;
const APP_SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/js/main.js',
  '/js/app.js',
  '/js/state.js',
  '/js/api.js',
  '/js/dom.js',
  '/js/icons.js',
  '/manifest.webmanifest',
  '/favicon.png',
  '/pwa-icon-192.png',
  '/pwa-icon-512.png',
];

function base64UrlToUint8Array(base64Url) {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from(rawData, (character) => character.charCodeAt(0));
}

function getSafeNotificationUrl(value) {
  try {
    const url = new URL(value || '#notifications', self.location.origin);
    return url.origin === self.location.origin ? url.href : new URL('#notifications', self.location.origin).href;
  } catch (_) {
    return new URL('#notifications', self.location.origin).href;
  }
}

function parsePushIdentifier(value, minimum) {
  if (
    (typeof value !== 'number' && typeof value !== 'string') ||
    String(value).trim() === ''
  )
    return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum ? parsed : null;
}

function getPushOpenUrl(value, userId, notificationId) {
  const url = new URL(getSafeNotificationUrl(value));
  const parsedUserId = parsePushIdentifier(userId, 0);
  const parsedNotificationId = parsePushIdentifier(notificationId, 1);
  if (parsedUserId !== null && parsedNotificationId !== null) {
    // URLはアプリ起動後ただちにHistory APIで消去される一時的な引き継ぎ情報。
    url.searchParams.set('push_user_id', String(parsedUserId));
    url.searchParams.set('push_notification_id', String(parsedNotificationId));
  }
  return url.href;
}

function isCacheableStaticResponse(response) {
  if (!response || !response.ok || response.type !== 'basic') return false;
  const cacheControl = response.headers.get('Cache-Control') || '';
  return !/\bno-store\b/i.test(cacheControl) && !response.headers.has('Set-Cookie');
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open('nyaitter-client-v2')
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith('nyaitter-client') && key !== 'nyaitter-client-v2')
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/server/') || url.pathname.startsWith('/uploads/')) {
    return;
  }

  const isStaticAsset = STATIC_ASSET_PATTERN.test(url.pathname);
  if (request.mode === 'navigate' || isStaticAsset) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (isCacheableStaticResponse(response)) {
            const copy = response.clone();
            caches.open('nyaitter-client-v2').then((cache) => cache.put(request.mode === 'navigate' ? '/index.html' : request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request.mode === 'navigate' ? '/index.html' : request)),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request).then((response) => {
      if (!isCacheableStaticResponse(response)) return response;
      const copy = response.clone();
      caches.open('nyaitter-client-v2').then((cache) => cache.put(request, copy));
      return response;
    })),
  );
});

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (_) {
    payload = { body: event.data ? event.data.text() : '' };
  }

  const title = String(payload.title || 'Nyaitter').slice(0, 80);
  const iconUrl = typeof payload.icon === 'string' && payload.icon.startsWith('/') ? payload.icon : '/pwa-icon-192.png';
  const options = {
    body: String(payload.body || '新しい通知があります').slice(0, 240),
    icon: iconUrl,
    badge: '/pwa-icon-192.png',
    tag: String(payload.tag || 'nyaitter-notification').slice(0, 64),
    renotify: false,
    data: {
      url: getSafeNotificationUrl(payload.url),
      userId: payload.user_id || null,
      notificationId: payload.notification_id || null,
    },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = getPushOpenUrl(
    event.notification.data?.url,
    event.notification.data?.userId,
    event.notification.data?.notificationId,
  );

  event.waitUntil((async () => {
    const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find((client) => new URL(client.url).origin === self.location.origin);
    if (existing) {
      if ('navigate' in existing) await existing.navigate(targetUrl);
      return existing.focus();
    }
    return clients.openWindow(targetUrl);
  })());
});

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    try {
      let subscription = event.newSubscription;
      if (!subscription) {
        const configResponse = await fetch('/server/api/push/config', { credentials: 'same-origin' });
        if (!configResponse.ok) return;
        const config = await configResponse.json();
        if (!config.enabled || !config.vapid_public_key) return;
        subscription = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: base64UrlToUint8Array(config.vapid_public_key),
        });
      }

      await fetch('/server/api/push/subscriptions', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ subscription: subscription.toJSON() }),
      });
    } catch (_) {
      // A later settings-page visit will reconcile the subscription if this background update fails.
    }
  })());
});
