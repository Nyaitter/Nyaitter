class ConnectionManager {
  constructor() {
    this.connectionsByUser = new Map();
  }

  register(userId, socket) {
    const normalizedUserId = Number(userId);
    if (!Number.isInteger(normalizedUserId) || normalizedUserId < 0 || !socket) {
      return;
    }

    if (!this.connectionsByUser.has(normalizedUserId)) {
      this.connectionsByUser.set(normalizedUserId, new Set());
    }
    this.connectionsByUser.get(normalizedUserId).add(socket);
  }

  unregister(userId, socket) {
    const normalizedUserId = Number(userId);
    const sockets = this.connectionsByUser.get(normalizedUserId);
    if (!sockets) return;

    sockets.delete(socket);
    if (sockets.size === 0) {
      this.connectionsByUser.delete(normalizedUserId);
    }
  }

  sendToUser(userId, event) {
    const normalizedUserId = Number(userId);
    const sockets = this.connectionsByUser.get(normalizedUserId);
    if (!sockets || sockets.size === 0) return false;

    let serialized;
    try {
      serialized = JSON.stringify(event);
    } catch (error) {
      console.warn('[realtime] Event serialization failed:', error.message);
      return false;
    }

    let delivered = false;
    for (const socket of [...sockets]) {
      // ws.OPEN is 1. 数値で確認し、ライブラリ実装への依存を最小化する。
      if (!socket || socket.readyState !== 1) {
        this.unregister(normalizedUserId, socket);
        continue;
      }

      try {
        socket.send(serialized);
        delivered = true;
      } catch (error) {
        console.warn('[realtime] Event delivery failed:', error.message);
        this.unregister(normalizedUserId, socket);
        try {
          socket.terminate();
        } catch (_) {
          // Socket has already been torn down.
        }
      }
    }

    return delivered;
  }

  async publishNotificationUnreadCount(userId, dbAdapter) {
    const unreadCount = await dbAdapter.getUnreadNotificationCount(userId);
    this.sendToUser(userId, {
      type: 'notification_unread_count',
      unread_count: unreadCount,
    });
    return unreadCount;
  }

  async publishNewNotification(userId, notification, dbAdapter) {
    const unreadCount = await dbAdapter.getUnreadNotificationCount(userId);
    this.sendToUser(userId, {
      type: 'notification_new',
      notification,
      unread_count: unreadCount,
    });
    this.sendToUser(userId, {
      type: 'notification_unread_count',
      unread_count: unreadCount,
    });
    return unreadCount;
  }

  publishDmMessage(userId, dmId, message, sender = null) {
    return this.sendToUser(userId, {
      type: 'dm_message',
      dm_id: String(dmId),
      message,
      ...(sender ? { sender } : {}),
    });
  }

  async publishDmUnreadCount(userId, dbAdapter, dmId = null) {
    const unreadCount = await dbAdapter.getGroupDmUnreadTotal(userId);
    this.sendToUser(userId, {
      type: 'dm_unread_count',
      unread_count: unreadCount,
      ...(dmId ? { dm_id: String(dmId) } : {}),
    });
    return unreadCount;
  }

  closeAll(code = 1001, reason = 'Server shutting down') {
    for (const sockets of this.connectionsByUser.values()) {
      for (const socket of sockets) {
        try {
          socket.close(code, reason);
        } catch (_) {
          // Socket may have been closed concurrently.
        }
      }
    }
    this.connectionsByUser.clear();
  }
}

module.exports = ConnectionManager;
