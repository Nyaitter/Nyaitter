/**
 * @typedef {Object} QueryOptions
 * @property {number} [limit]
 * @property {number} [offset]
 * @property {string} [orderBy]
 * @property {'asc'|'desc'} [orderDirection]
 */

class DatabaseAdapter {
	
	async connect() {
		throw new Error('connect() must be implemented');
	}

	
	async disconnect() {
		throw new Error('disconnect() must be implemented');
	}

	async createSession(userId, meta = {}) { throw new Error('createSession() must be implemented'); }
	async getSessionByToken(token) { throw new Error('getSessionByToken() must be implemented'); }
	async invalidateSession(token) { throw new Error('invalidateSession() must be implemented'); }
	async getUserSessions(userId) { throw new Error('getUserSessions() must be implemented'); }
	async invalidateAllSessions(userId) { throw new Error('invalidateAllSessions() must be implemented'); }
	async invalidateSessionsByIp(userId, ipHash) { throw new Error('invalidateSessionsByIp() must be implemented'); }
	async trustLoginIp(userId, metadata) { throw new Error('trustLoginIp() must be implemented'); }
	async getTrustedLoginIp(userId, ipHash) { throw new Error('getTrustedLoginIp() must be implemented'); }
	async countTrustedLoginIps(userId) { throw new Error('countTrustedLoginIps() must be implemented'); }
	async revokeTrustedLoginIp(userId, ipHash) { throw new Error('revokeTrustedLoginIp() must be implemented'); }
	async createLoginApproval(approvalData) { throw new Error('createLoginApproval() must be implemented'); }
	async getLoginApproval(id) { throw new Error('getLoginApproval() must be implemented'); }
	async getLoginApprovalByPollToken(id, pollTokenHash) { throw new Error('getLoginApprovalByPollToken() must be implemented'); }
	async decideLoginApproval(userId, id, decision) { throw new Error('decideLoginApproval() must be implemented'); }
	async consumeLoginApproval(id, pollTokenHash) { throw new Error('consumeLoginApproval() must be implemented'); }

	/**
	 * SCID（Scratch ID）でユーザーを取得（後方互換用）
	 * @param {string} scid
	 * @returns {Promise<Object|null>}
	 */
	async getUserByScid(scid) {
		throw new Error('getUserByScid() must be implemented');
	}

	
	async getUserById(id) {
		throw new Error('getUserById() must be implemented');
	}

	
	async getUserByNyaitterAddress(address) {
		throw new Error('getUserByNyaitterAddress() must be implemented');
	}

	
	async getOrCreateExternalUser(params) {
		throw new Error('getOrCreateExternalUser() must be implemented');
	}

	
	async createUser(userData) {
		throw new Error('createUser() must be implemented');
	}

	
	async searchUsers(query, limit = 20) {
		throw new Error('searchUsers() must be implemented');
	}

	
	async getUsersByIds(userIds) {
		throw new Error('getUsersByIds() must be implemented');
	}

	
	async getAllUsers() {
		throw new Error('getAllUsers() must be implemented');
	}

	
	async getUserStatus(userId) {
		throw new Error('getUserStatus() must be implemented');
	}

	
	async setUserStatus(userId, status) {
		throw new Error('setUserStatus() must be implemented');
	}

	async createBotToken(userId, tokenId, tokenHash, name) { throw new Error('createBotToken() must be implemented'); }
	async getBotTokenById(tokenId) { throw new Error('getBotTokenById() must be implemented'); }
	async getUserBotTokens(userId) { throw new Error('getUserBotTokens() must be implemented'); }
	async revokeBotToken(userId, tokenId) { throw new Error('revokeBotToken() must be implemented'); }
	async updateBotTokenLastUsed(tokenId) { throw new Error('updateBotTokenLastUsed() must be implemented'); }

	
	async createPost(postData) {
		throw new Error('createPost() must be implemented');
	}

	
			async getPostById(postId) {
			throw new Error('getPostById() must be implemented');
		}

		
		async getPostsByIds(postIds) {
			throw new Error('getPostsByIds() must be implemented');
		}

		
		async getPostMetricsBatch(postIds, currentUserId = null) {
			throw new Error('getPostMetricsBatch() must be implemented');
		}

		
	async updatePost(postId, fields) {
		throw new Error('updatePost() must be implemented');
	}

	
	async getTimelinePosts(params) {
		throw new Error('getTimelinePosts() must be implemented');
	}

	
	async getRecentPosts(limit = 30) {
		throw new Error('getRecentPosts() must be implemented');
	}

	
	async getPostsByUserId(userId, limit = 50, currentUserId = null) {
		throw new Error('getPostsByUserId() must be implemented');
	}

	
	async getReplyPostIds(parentPostId, limit = 50, offset = 0) {
		throw new Error('getReplyPostIds() must be implemented');
	}

	async getThreadReplyPostIds(parentPostId, limit = 50, offset = 0) {
		throw new Error('getThreadReplyPostIds() must be implemented');
	}

	async getTimelinePostIds(params = {}) {
		throw new Error('getTimelinePostIds() must be implemented');
	}

	async getRecommendedPostIds(params = {}) {
		throw new Error('getRecommendedPostIds() must be implemented');
	}

	async getProfilePostIds(params = {}) {
		throw new Error('getProfilePostIds() must be implemented');
	}

	async searchPostIds(query, limit = 30, offset = 0) {
		throw new Error('searchPostIds() must be implemented');
	}

	async getPostCount(userId) {
		throw new Error('getPostCount() must be implemented');
	}

	async getMediaCount(userId) {
		throw new Error('getMediaCount() must be implemented');
	}

	async getMediaPosts(userId, limit = 15, offset = 0) {
		throw new Error('getMediaPosts() must be implemented');
	}

	async getReplyCount(postId) {
		throw new Error('getReplyCount() must be implemented');
	}

	
	async getPostDetail(id, currentUserId = null) {
		throw new Error('getPostDetail() must be implemented');
	}

	
	async toggleLike(userId, postId) {
		throw new Error('toggleLike() must be implemented');
	}

	
	async toggleStar(userId, postId) {
		throw new Error('toggleStar() must be implemented');
	}

	
	async getLikeCount(postId) {
		throw new Error('getLikeCount() must be implemented');
	}

	async hasUserLikedPost(userId, postId) {
		throw new Error('hasUserLikedPost() must be implemented');
	}

	async getLikeIds(userId) {
		throw new Error('getLikeIds() must be implemented');
	}

	async getStarCount(postId) {
		throw new Error('getStarCount() must be implemented');
	}

	async hasUserStarredPost(userId, postId) {
		throw new Error('hasUserStarredPost() must be implemented');
	}

	async getStarIds(userId) {
		throw new Error('getStarIds() must be implemented');
	}

	async getPinnedPostId(userId) {
		throw new Error('getPinnedPostId() must be implemented');
	}

	
	async hasUserLikedPost(userId, postId) {
		throw new Error('hasUserLikedPost() must be implemented');
	}

	
	async getStarCount(postId) {
		throw new Error('getStarCount() must be implemented');
	}

	
	async hasUserStarredPost(userId, postId) {
		throw new Error('hasUserStarredPost() must be implemented');
	}

	
	async getDmList(userId) {
		throw new Error('getDmList() must be implemented');
	}

	
	async getOrCreateDmChannel(userId1, userId2) {
		throw new Error('getOrCreateDmChannel() must be implemented');
	}

	
	async getDmMessages(channelId, limit = 50, offset = 0) {
		throw new Error('getDmMessages() must be implemented');
	}

	
	async sendDmMessage(channelId, senderId, content) {
		throw new Error('sendDmMessage() must be implemented');
	}

	
	async markDmMessagesAsRead(channelId, userId) {
		throw new Error('markDmMessagesAsRead() must be implemented');
	}

	
	async getUnreadDmCount(userId) {
		throw new Error('getUnreadDmCount() must be implemented');
	}

	
	async getGroupDmsForUser(userId) {
		throw new Error('getGroupDmsForUser() must be implemented');
	}

	
	async getGroupDm(dmId) {
		throw new Error('getGroupDm() must be implemented');
	}

	
	async createGroupDm(dmData) {
		throw new Error('createGroupDm() must be implemented');
	}

	
	async updateGroupDm(dmId, updates) {
		throw new Error('updateGroupDm() must be implemented');
	}

	
	async appendToGroupDm(dmId, message, senderId = null) {
		throw new Error('appendToGroupDm() must be implemented');
	}

	
	async markGroupDmRead(dmId, userId) {
		throw new Error('markGroupDmRead() must be implemented');
	}

	
	async getGroupDmUnreadCounts(userId) {
		throw new Error('getGroupDmUnreadCounts() must be implemented');
	}

	
	async getGroupDmUnreadTotal(userId) {
		throw new Error('getGroupDmUnreadTotal() must be implemented');
	}

	
	async deleteGroupDm(dmId) {
		throw new Error('deleteGroupDm() must be implemented');
	}

	
	async leaveGroupDm(dmId, userId) {
		throw new Error('leaveGroupDm() must be implemented');
	}

	
	async findGroupDmByMembers(memberIds) {
		throw new Error('findGroupDmByMembers() must be implemented');
	}

	
	async getDmPublicKeys(userIds) {
		throw new Error('getDmPublicKeys() must be implemented');
	}

	
	async setDmPublicKey(userId, publicKey) {
		throw new Error('setDmPublicKey() must be implemented');
	}

	
	async toggleFollow(followerId, followingId) {
		throw new Error('toggleFollow() must be implemented');
	}

	
	async isFollowing(followerId, followingId) {
		throw new Error('isFollowing() must be implemented');
	}

	
	async getFollowing(userId, limit = 100) {
		throw new Error('getFollowing() must be implemented');
	}

	
	async getFollowers(userId, limit = 100) {
		throw new Error('getFollowers() must be implemented');
	}

	
	async deletePost(postId, userId) {
		throw new Error('deletePost() must be implemented');
	}

	
	async togglePin(userId, postId) {
		throw new Error('togglePin() must be implemented');
	}

	
	async getPinnedPosts(userId) {
		throw new Error('getPinnedPosts() must be implemented');
	}

	
	async repostPost(userId, postId) {
		throw new Error('repostPost() must be implemented');
	}

	
	async getReposts(userId) {
		throw new Error('getReposts() must be implemented');
	}

	
	async getRepostsOfPost(postId, limit = 50) {
		throw new Error('getRepostsOfPost() must be implemented');
	}

	
	async getPinnedPosts(userId) {
		throw new Error('getPinnedPosts() must be implemented');
	}

	
	async createNotification(notificationData) {
		throw new Error('createNotification() must be implemented');
	}

	
	async getNotifications(userId, limit = 50, offset = 0) {
		throw new Error('getNotifications() must be implemented');
	}

	
	async markNotificationAsRead(notificationId) {
		throw new Error('markNotificationAsRead() must be implemented');
	}

	
	async markNotificationAsClicked(notificationId) {
		throw new Error('markNotificationAsClicked() must be implemented');
	}

	
	async getNotificationById(notificationId) {
		throw new Error('getNotificationById() must be implemented');
	}

	
	async deleteNotification(notificationId) {
		throw new Error('deleteNotification() must be implemented');
	}

	
	async markAllNotificationsAsRead(userId) {
		throw new Error('markAllNotificationsAsRead() must be implemented');
	}

	
	async getUnreadNotificationCount(userId) {
		throw new Error('getUnreadNotificationCount() must be implemented');
	}

	
	async upsertPushSubscription(userId, subscription) {
		throw new Error('upsertPushSubscription() must be implemented');
	}

	
	async getPushSubscriptions(userId) {
		throw new Error('getPushSubscriptions() must be implemented');
	}

	
	async deletePushSubscription(userId, endpoint) {
		throw new Error('deletePushSubscription() must be implemented');
	}

	
	async searchPosts(query, limit = 20) {
		throw new Error('searchPosts() must be implemented');
	}

	
	async updateUserProfile(userId, profileData) {
		throw new Error('updateUserProfile() must be implemented');
	}

	
	async getTrendingPosts(limit = 20) {
		throw new Error('getTrendingPosts() must be implemented');
	}

	
	async adminDeletePost(postId) {
		throw new Error('adminDeletePost() must be implemented');
	}

	async getFollowingCount(userId) {
		throw new Error('getFollowingCount() must be implemented');
	}

	async getFollowerCount(userId) {
		throw new Error('getFollowerCount() must be implemented');
	}

	async getFollowIds(userId) {
		throw new Error('getFollowIds() must be implemented');
	}

	async getRepostCount(postId) {
		throw new Error('getRepostCount() must be implemented');
	}

	async getRanking(type, limit = 50) {
		throw new Error('getRanking() must be implemented');
	}

	async getUserRanking(type, userId) {
		throw new Error('getUserRanking() must be implemented');
	}

	async getTrendingHashtags(limit = 10) {
		throw new Error('getTrendingHashtags() must be implemented');
	}

	async addLog(entry) {
		throw new Error('addLog() must be implemented');
	}

	async getLogs(limit = 20, offset = 0) {
		throw new Error('getLogs() must be implemented');
	}
}

module.exports = DatabaseAdapter;
