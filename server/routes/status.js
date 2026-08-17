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
	});
});

module.exports = router;
