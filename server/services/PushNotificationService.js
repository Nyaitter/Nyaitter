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
      const sessionValid = await this._isSessionValid(subscription.sessionToken);
      if (!sessionValid) {
        result.skipped += 1;
        try {
          await this.dbAdapter.deletePushSubscription(userId, subscription.endpoint);
          result.removed += 1;
        } catch (deleteError) {
          console.warn('[push] Failed to remove stale subscription:', deleteError.message);
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

  async _isSessionValid(sessionToken) {
    if (!sessionToken) return true;
    if (typeof this.dbAdapter.getSessionByToken !== 'function') return true;
    try {
      const session = await this.dbAdapter.getSessionByToken(sessionToken);
      return Boolean(session);
    } catch (error) {
      console.warn('[push] Session validation failed:', error.message);
      return true;
    }
  }
}

module.exports = PushNotificationService;
