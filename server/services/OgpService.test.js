'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isCrawler, generatePostOgpTags, generatePostHtml } = require('./OgpService');

test('OGP: 対象年齢が付いた投稿は本文も添付も OGP に出ない', () => {
	const post = {
		id: 42,
		content: '秘密の本文テキスト',
		age_rating: 18,
		attachments: [{ url: '/files/secret.png', type: 'image/png' }],
	};
	const author = { name: 'author', external_id: 1 };
	const tags = generatePostOgpTags({ post, author, publicUrl: 'https://example.com' });
	assert.ok(!tags.includes('秘密の本文テキスト'), '本文が description に出ない');
	assert.ok(!tags.includes('secret.png'), '添付が og:image に出ない');
	const html = generatePostHtml({ post, author, publicUrl: 'https://example.com' });
	assert.ok(!html.includes('秘密の本文テキスト'), '本文が HTML に出ない');
	assert.ok(!html.includes('secret.png'), '添付が HTML に出ない');

	const plain = { ...post, age_rating: 0 };
	const plainTags = generatePostOgpTags({ post: plain, author, publicUrl: 'https://example.com' });
	assert.ok(plainTags.includes('秘密の本文テキスト'), '対象年齢が無ければ従来どおり出る');
});

test('isCrawler: 通常のブラウザはクローラーではない', () => {
	assert.equal(isCrawler('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6422.66 Mobile Safari/537.36'), false);
	assert.equal(isCrawler('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0'), false);
	assert.equal(isCrawler(''), false);
	assert.equal(isCrawler(null), false);
	assert.equal(isCrawler(undefined), false);
});

test('isCrawler: アプリ内ブラウザ（ブラウザUA＋アプリ名）はクローラーではない', () => {
	assert.equal(isCrawler('Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36 WhatsApp/2.23.10.76'), false);
	assert.equal(isCrawler('Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 WhatsApp/2.23.9.79'), false);
	assert.equal(isCrawler('Mozilla/5.0 (Linux; Android 12; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Mobile Safari/537.36 Pinterest/12.5'), false);
});

test('isCrawler: プレビュー取得・検索クローラーはクローラー', () => {
	assert.equal(isCrawler('Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'), true);
	assert.equal(isCrawler('Twitterbot/1.0'), true);
	assert.equal(isCrawler('facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)'), true);
	assert.equal(isCrawler('Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)'), true);
	assert.equal(isCrawler('TelegramBot (like TwitterBot)'), true);
	assert.equal(isCrawler('Mastodon/4.2.0 (+https://example.social)'), true);
	assert.equal(isCrawler('Misskey/2023.12.2 (https://example.tld)'), true);
	assert.equal(isCrawler('Pleroma/2.5.0; https://example.tld (Pleroma::Instance)'), true);
	assert.equal(isCrawler('WhatsApp/2.23.10.76'), true);
	// 検索クローラーはブラウザ署名を持つUAでもクローラーとして扱う
	assert.equal(isCrawler('Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'), true);
	assert.equal(isCrawler('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)'), true);
});
