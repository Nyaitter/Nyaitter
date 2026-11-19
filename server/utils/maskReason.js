'use strict';

const MASK_REASON_MAX_LENGTH = 100;

function normalizeMaskReason(value) {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim().slice(0, MASK_REASON_MAX_LENGTH);
	return trimmed || null;
}

module.exports = { normalizeMaskReason, MASK_REASON_MAX_LENGTH };
