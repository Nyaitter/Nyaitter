'use strict';

/**
 * Service for generating Open Graph Protocol (OGP) tags, HTML meta embeds,
 * and oEmbed responses for Discord, Twitter, and other platforms.
 */

const BOT_USER_AGENTS = [
	'discordbot',
	'twitterbot',
	'facebookexternalhit',
	'slackbot',
	'telegrambot',
	'linespider',
	'mastodon',
	'misskey',
	'pleroma',
	'applebot',
	'whatsapp',
	'linkedinbot',
	'pinterest',
	'googlebot',
	'bingbot',
	'yandexbot',
	'baiduspider',
	'duckduckbot',
	'embedly',
	'quora link preview',
	'outbrain',
	'vkshare',
	'w3c_validator',
];

function isCrawler(userAgent) {
	if (!userAgent || typeof userAgent !== 'string') return false;
	const lower = userAgent.toLowerCase();
	return BOT_USER_AGENTS.some((bot) => lower.includes(bot));
}

function escapeHtml(str) {
	if (!str) return '';
	return String(str)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#039;');
}

function extractFirstImage(attachments, publicUrl) {
	if (!Array.isArray(attachments) || attachments.length === 0) return null;
	for (const att of attachments) {
		if (att?.type === 'image' || att?.contentType?.startsWith('image/')) {
			if (att.url) return att.url.startsWith('http') ? att.url : `${publicUrl}${att.url}`;
			if (att.id) return `${publicUrl}/user_files/${encodeURIComponent(att.id)}`;
		}
	}
	return null;
}

function generatePostOgpTags({ post, author, publicUrl }) {
	const authorName = author?.name || 'Unknown User';
	const authorHandle = author?.handle ? `@${author.handle}` : (author?.scid ? `@${author.scid}` : `@${author?.id || 'unknown'}`);
	const title = `${authorName} (${authorHandle}) on Nyaitter`;

	let description = post.content || '';
	if (post.mask) {
		description = '🔒 [この投稿はマスクされています]';
	} else if (!description && post.attachments?.length > 0) {
		description = `[添付ファイル ${post.attachments.length}件]`;
	}
	if (!description) {
		description = 'Nyaitterのポスト';
	}

	const postUrl = `${publicUrl}/posts/${post.id}`;
	const firstImage = extractFirstImage(post.attachments, publicUrl);
	const avatarImage = author?.icon_data ? (author.icon_data.startsWith('http') ? author.icon_data : `${publicUrl}${author.icon_data}`) : null;
	const ogImage = firstImage || avatarImage || `${publicUrl}/logo.png`;
	const twitterCard = firstImage ? 'summary_large_image' : 'summary';
	const themeColor = '#79529c';

	const oEmbedUrl = `${publicUrl}/api/oembed?url=${encodeURIComponent(postUrl)}`;

	return `
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(description)}" />
    <meta name="theme-color" content="${themeColor}" />

    <!-- Open Graph / Facebook -->
    <meta property="og:type" content="article" />
    <meta property="og:site_name" content="Nyaitter" />
    <meta property="og:title" content="${escapeHtml(title)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta property="og:url" content="${escapeHtml(postUrl)}" />
    <meta property="og:image" content="${escapeHtml(ogImage)}" />

    <!-- Twitter -->
    <meta name="twitter:card" content="${twitterCard}" />
    <meta name="twitter:site" content="@Nyaitter" />
    <meta name="twitter:title" content="${escapeHtml(title)}" />
    <meta name="twitter:description" content="${escapeHtml(description)}" />
    <meta name="twitter:image" content="${escapeHtml(ogImage)}" />

    <!-- oEmbed -->
    <link rel="alternate" type="application/json+oembed" href="${escapeHtml(oEmbedUrl)}" title="${escapeHtml(title)}" />
`;
}

function generateOembedJson({ post, author, publicUrl, postUrl }) {
	const authorName = author ? `${author.name} (@${author.handle || author.scid || author.id})` : 'Nyaitter User';
	const authorUrl = author ? `${publicUrl}/#profile/${author.id}` : publicUrl;
	const firstImage = extractFirstImage(post.attachments, publicUrl);

	const json = {
		version: '1.0',
		type: firstImage ? 'photo' : 'rich',
		provider_name: 'Nyaitter',
		provider_url: publicUrl,
		author_name: authorName,
		author_url: authorUrl,
		title: post.content ? post.content.slice(0, 100) : 'Nyaitter Post',
	};

	if (firstImage) {
		json.url = firstImage;
		json.width = 1200;
		json.height = 630;
	} else {
		json.html = `<blockquote><p>${escapeHtml(post.content || '')}</p>&mdash; ${escapeHtml(authorName)} <a href="${escapeHtml(postUrl)}">${escapeHtml(postUrl)}</a></blockquote>`;
	}

	return json;
}

function generatePostHtml({ post, author, publicUrl, frontendUrl = null }) {
	const ogpTags = generatePostOgpTags({ post, author, publicUrl });
	const authorName = author?.name || 'Unknown User';
	const content = post?.mask ? '🔒 [この投稿はマスクされています]' : (post?.content || '');
	const safeContent = escapeHtml(content);
	const safeAuthor = escapeHtml(authorName);
	const postId = Number(post?.id);

	return `<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    ${ogpTags}
    <script>
        (function() {
            var postId = ${JSON.stringify(postId)};
            var explicitFrontend = ${JSON.stringify(frontendUrl || '')};
            var targetUrl = '';
            if (explicitFrontend) {
                targetUrl = explicitFrontend.replace(/\\/+$/, '') + '/#post/' + postId;
            } else {
                var hostname = window.location.hostname.replace(/^(?:link|api)\\./i, '');
                var portSuffix = (window.location.port && window.location.port !== '80' && window.location.port !== '443' && window.location.port !== '3005') ? (':' + window.location.port) : '';
                targetUrl = window.location.protocol + '//' + hostname + portSuffix + '/#post/' + postId;
            }
            if (targetUrl) {
                window.location.replace(targetUrl);
            }
        })();
    </script>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 600px; margin: 40px auto; padding: 20px; color: #333; line-height: 1.6; background-color: #f7f9fa; }
        .card { border: 1px solid #e1e8ed; border-radius: 12px; padding: 24px; background: #fff; box-shadow: 0 2px 8px rgba(0,0,0,0.05); }
        .author { font-weight: bold; font-size: 1.1em; margin-bottom: 8px; }
        .content { font-size: 1.05em; white-space: pre-wrap; word-break: break-word; }
        .footer { margin-top: 16px; font-size: 0.9em; color: #888; border-top: 1px solid #eee; padding-top: 12px; }
    </style>
</head>
<body>
    <div class="card">
        <div class="author">${safeAuthor}</div>
        <div class="content">${safeContent}</div>
        <div class="footer">Nyaitter • <a id="redirectLink" href="${escapeHtml(publicUrl || '')}">Nyaitterで開く</a></div>
    </div>
</body>
</html>`;
}

module.exports = {
	isCrawler,
	generatePostOgpTags,
	generatePostHtml,
	generateOembedJson,
	escapeHtml,
};
