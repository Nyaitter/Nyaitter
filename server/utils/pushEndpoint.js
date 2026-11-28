'use strict';

// 購読先のホストはブラウザや端末のプッシュサービスごとに異なるため、
// 特定のベンダー名では絞らない。https の公開ホスト名であることだけを
// 確認し、内部アドレスへの送信を防ぐ。
function isAllowedPushEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length > 4096) return false;
  let url;
  try {
    url = new URL(endpoint);
  } catch (_) {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return false;
  const host = url.hostname.toLowerCase();
  if (!host || !host.includes('.')) return false;
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  if (host.startsWith('[')) return false;
  return true;
}

module.exports = { isAllowedPushEndpoint };
