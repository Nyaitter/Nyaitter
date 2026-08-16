import { initApp } from './app.js';

function showInitialLoadingScreen() {
    const loadingOverlay = document.getElementById('loading-overlay');
    if (!loadingOverlay) return;

    loadingOverlay.classList.remove('hidden');
    loadingOverlay.setAttribute('aria-hidden', 'false');
    loadingOverlay.setAttribute('aria-busy', 'true');
}

function startApp() {
    // 認証状態の取得より前にローディング画面を確実に描画する。
    showInitialLoadingScreen();

    // 2フレーム待つことで、初期ローディング画面が描画された後に
    // initApp() 内の /server/auth/me リクエストを開始する。
    window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
            initApp();
        });
    });
}

if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', startApp, { once: true });
} else {
    startApp();
}
