'use strict';

function postGroupBadges(user) {
	const badges = Array.isArray(user?.group_badges) ? user.group_badges : [];
	const saved = user?.settings?.display_group_badges;
	if (!Array.isArray(saved)) return badges;
	const byId = new Map(
		badges.filter((b) => b && b.id != null).map((b) => [String(b.id), b]),
	);
	return saved.map((id) => byId.get(String(id))).filter(Boolean);
}

function validateDisplayGroupBadges(value) {
	if (!Array.isArray(value)) return '表示するバッジの指定が正しくありません';
	if (value.length > 20) return '表示するバッジの指定が正しくありません';
	const valid = value.every(
		(id) => typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id)),
	);
	return valid ? null : '表示するバッジの指定が正しくありません';
}

module.exports = { postGroupBadges, validateDisplayGroupBadges };
