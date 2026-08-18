const express = require('express');
const config = require('../config');
const {
	buildLocalNyaitterAddress,
	getAddressDomain,
	getPublicUrl,
} = require('../utils/nyaitterAddress');

const router = express.Router();

function getDbAdapter(req) {
	return req.app.locals.dbAdapter;
}

function serializeIntegerRange(range) {
	return {
		min: Number.isInteger(range?.min) ? range.min : null,
		max: Number.isInteger(range?.max) ? range.max : null,
	};
}

function serializeRateLimit(limit) {
	return {
		window_ms: Number.isInteger(limit?.windowMs) ? limit.windowMs : null,
		max: Number.isInteger(limit?.max) ? limit.max : null,
	};
}

function getPublicClientLimits() {
	const rateLimits = {};
	Object.entries(config.rateLimit || {}).forEach(([name, limit]) => {
		if (name === 'enabled' || !limit || typeof limit !== 'object') return;
		rateLimits[name] = serializeRateLimit(limit);
	});

	return {
		input: {
			post_content_length: serializeIntegerRange(
				config.limits.postContentLength,
			),
			dm_content_length: serializeIntegerRange(
				config.limits.dmContentLength,
			),
			user_name_length: serializeIntegerRange(
				config.limits.userNameLength,
			),
			profile_bio_length: serializeIntegerRange(
				config.limits.profileBioLength,
			),
			scratch_username_length: serializeIntegerRange(
				config.limits.scratchUsernameLength,
			),
		},
		upload: {
			max_file_size_bytes: config.limits.maxFileUploadSizeMB * 1024 * 1024,
		},
		rate_limits: {
			enabled: Boolean(config.rateLimit?.enabled),
			limits: rateLimits,
		},
	};
}

router.get('/status', async (req, res) => {
	let dbStatus = 'ok';

	try {
		const db = getDbAdapter(req);
		if (db && typeof db.connect === 'function') {
			dbStatus = 'connected';
		}
	} catch (error) {
		dbStatus = 'error';
		console.warn('[server] DB status check exception:', error.message);
	}

	const publicUrl = getPublicUrl(req);
	const domain = getAddressDomain(publicUrl);

	res.json({
		server: 'ok',
		timestamp: new Date().toISOString(),
		database: dbStatus,
		identity: {
			public_url: publicUrl,
			domain,
			example_address: buildLocalNyaitterAddress(1, req),
			nyaitter_id_format: '#{localId}',
			address_format: '#{localId}@{serverDomain}',
		},
		auth_methods: [
			'scratch',
			'external_nyaitter',
		],
		external_login: {
			enabled: !!config.federation?.allow_external_login,
			trusted_servers: (config.federation?.trusted_servers || []).map((server) => ({
				nyaitter_id: server.nyaitter_id,
				domain: server.domain,
			})),
		},
		client_limits: getPublicClientLimits(),
	});
});

module.exports = router;
