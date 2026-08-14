export const DOM = {
    mainContent: document.getElementById('main-content'),
    navMenuTop: document.getElementById('nav-menu-top'),
    navMenuBottom: document.getElementById('nav-menu-bottom'),
    navLogo: document.getElementById('nav-logo'),
    pageHeader: document.getElementById('page-header'),
    screens: document.querySelectorAll('.screen'),
    postFormContainer: document.querySelector('.post-form-container'),
    postModal: document.getElementById('post-modal'),
    editPostModal: document.getElementById('edit-post-modal'),
    editPostModalContent: document.getElementById('edit-post-modal-content'),
    createDmModal: document.getElementById('create-dm-modal'),
    createDmModalContent: document.getElementById('create-dm-modal-content'),
    dmManageModal: document.getElementById('dm-manage-modal'),
    dmManageModalContent: document.getElementById('dm-manage-modal-content'),
    editDmMessageModal: document.getElementById('edit-dm-message-modal'),
    editDmMessageModalContent: document.getElementById(
        'edit-dm-message-modal-content',
    ),
    connectionErrorOverlay: document.getElementById('connection-error-overlay'),
    retryConnectionBtn: document.getElementById('retry-connection-btn'),
    freezeOverlay: document.getElementById('freeze-overlay'),
    freezeReason: document.getElementById('freeze-reason'),
    imagePreviewModal: document.getElementById('image-preview-modal'),
    imagePreviewModalContent: document.getElementById(
        'image-preview-modal-content',
    ),
    timeline: document.getElementById('timeline'),
    exploreContent: document.getElementById('explore-content'),
    notificationsContent: document.getElementById('notifications-content'),
    likesContent: document.getElementById('likes-content'),
    starsContent: document.getElementById('stars-content'),
    postDetailContent: document.getElementById('post-detail-content'),
    searchResultsScreen: document.getElementById('search-results-screen'),
    searchResultsContent: document.getElementById('search-results-content'),
    dmScreen: document.getElementById('dm-screen'),
    dmContent: document.getElementById('dm-content'),
    loadingOverlay: document.getElementById('loading-overlay'),
    loginBanner: document.getElementById('login-banner'),
    rightSidebar: {
        recommendations: document.getElementById(
            'recommendations-widget-container',
        ),
        searchWidget: document.getElementById(
            'right-sidebar-search-widget-container',
        ),
        links: document.getElementById('right-sidebar-links-container'),
    },
};

export function showMainJsError(message) {
    const overlay = document.getElementById('mainjs-error-overlay');
    const text = document.getElementById('mainjs-error-text');
    if (!overlay || !text) return;
    text.textContent = String(message || '不明なエラー').slice(0, 2000);
    overlay.classList.remove('hidden');
}

window.addEventListener('error', (event) => {
    showMainJsError(`JavaScriptエラー: ${event.message || '不明なエラー'}`);
});
window.addEventListener('unhandledrejection', (event) => {
    const reason =
        event.reason instanceof Error
            ? event.reason.message
            : String(event.reason || '不明なエラー');
    // 詳細は画面へ露出させず、運用者がブラウザコンソールで原因を調査できるようにする。
    console.error('[nyaitter] Unhandled promise rejection:', event.reason);
    showMainJsError(`未処理のPromise例外: ${reason}`);
});
document
    .getElementById('mainjs-error-reload-btn')
    ?.addEventListener('click', () => window.location.reload());
DOM.imagePreviewModal?.addEventListener('click', (event) => {
    if (
        event.target === DOM.imagePreviewModal ||
        event.target.closest('.modal-close-btn')
    ) {
        window.closeImageModal?.();
    }
});
