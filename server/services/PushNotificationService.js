const webpush = require('web-push');
const { getNotificationText, getNotificationTargetHash } = require('../utils/notification');

class PushNotificationService {
  constructor({ dbAdapter, pushConfig = {} }) {
    this.dbAdapter = dbAdapter;
    this.config = pushConfig;
    this.enabled = Boolean(
      pushConfig.vapidSubject
      && pushConfig.vapidPublicKey
      && pushConfig.vapidPrivateKey,
    );

    if (this.enabled) {
      webpush.setVapidDetails(
        pushConfig.vapidSubject,
        pushConfig.vapidPublicKey,
        pushConfig.vapidPrivateKey,
      );
    } else {
      console.warn('[push] Web Push is disabled: VAPID_SUBJECT, VAPID_PUBLIC_KEY, and VAPID_PRIVATE_KEY are required.');
    }
  }

  getPublicConfiguration() {
    return {
      enabled: this.enabled,
      vapid_public_key: this.enabled ? this.config.vapidPublicKey : null,
    };
  }

  async sendNotificationToUser(userId, notification) {
    if (!this.enabled) return { attempted: 0, delivered: 0, removed: 0 };

    let subscriptions;
    try {
      subscriptions = await this.dbAdapter.getPushSubscriptions(userId);
    } catch (error) {
      console.warn('[push] Failed to load subscriptions:', error.message);
      return { attempted: 0, delivered: 0, removed: 0 };
    }

    const payload = JSON.stringify({
      title: 'Nyaitter',
      body: getNotificationText(notification).slice(0, 240),
      tag: notification?.id ? `notification-${notification.id}` : 'notification',
      url: getNotificationTargetHash(notification?.target, notification?.from?.id),
      user_id: userId,
      notification_id: notification?.id || null,
      icon: notification?.from?.id != null ? `/server/api/users/${notification.from.id}/icon` : null,
    });

    const result = { attempted: subscriptions.length, delivered: 0, removed: 0, skipped: 0 };
    await Promise.all(subscriptions.map(async (subscription) => {
      const sessionStatus = await this._getSessionStatus(
        userId,
        subscription.sessionToken,
      );
      if (sessionStatus !== 'valid') {
        result.skipped += 1;
        if (sessionStatus === 'invalid') {
          try {
            await this.dbAdapter.deletePushSubscription(userId, subscription.endpoint);
            result.removed += 1;
          } catch (deleteError) {
            console.warn('[push] Failed to remove stale subscription:', deleteError.message);
          }
        }
        return;
      }

      try {
        await webpush.sendNotification(subscription, payload, {
          TTL: 300,
          urgency: 'normal',
          topic: notification?.id ? `nyaitter-${notification.id}`.slice(0, 32) : 'nyaitter-notification',
        });
        result.delivered += 1;
      } catch (error) {
        const statusCode = Number(error?.statusCode || 0);
        if (statusCode === 404 || statusCode === 410) {
          try {
            await this.dbAdapter.deletePushSubscription(userId, subscription.endpoint);
            result.removed += 1;
          } catch (deleteError) {
            console.warn('[push] Failed to remove expired subscription:', deleteError.message);
          }
          return;
        }
        console.warn('[push] Delivery failed:', error.message || error);
      }
    }));

    return result;
  }

  async _getSessionStatus(userId, sessionToken) {
    // 旧形式など、セッションに紐付かない購読には送信しない。
    if (!sessionToken) return 'invalid';
    if (typeof this.dbAdapter.getSessionByToken !== 'function') {
      console.warn('[push] Session validation is not supported by the active database adapter.');
      return 'unknown';
    }

    try {
      const session = await this.dbAdapter.getSessionByToken(sessionToken);
      if (!session || Number(session.userId) !== Number(userId)) return 'invalid';
      return 'valid';
    } catch (error) {
      // DBの一時障害時に誤送信しない。購読自体は回復後に利用できるよう削除しない。
      console.warn('[push] Session validation failed:', error.message);
      return 'unknown';
    }
  }
}

module.exports = PushNotificationService;
