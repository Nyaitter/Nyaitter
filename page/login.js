document.addEventListener('DOMContentLoaded', () => {
  const AUTH_API = '/server/auth';
  const NYAITTER_ADDRESS_PATTERN = /^#\d{1,16}@[A-Za-z0-9.-]+(?::\d{1,5})?$/;

  const loginModal = document.getElementById('login-modal');
  const authStep1 = document.getElementById('auth-step1');
  const authStep2 = document.getElementById('auth-step2');
  const profileLink = document.getElementById('pflink');
  const usernameInput = document.getElementById('username-input');
  const getCodeBtn = document.getElementById('get-code-btn');
  const verificationCodeElem = document.getElementById('verification-code');
  const verifyCommentBtn = document.getElementById('verify-comment-btn');
  const loadingOverlay = document.getElementById('login-loading-overlay') || document.getElementById('loading-overlay');
  const errorMessage = document.getElementById('error-message');
  const copyMessage = document.getElementById('copy-message');
  const loginInstruction = document.getElementById('login-instruction');
  const loginApprovalWaitModal = document.getElementById('login-approval-wait-modal');
  const loginApprovalWaitStatus = document.getElementById('login-approval-wait-status');
  const loginApprovalWaitCancelBtn = document.getElementById('login-approval-wait-cancel-btn');

  if (!authStep1 || !authStep2 || !profileLink || !usernameInput || !getCodeBtn
    || !verificationCodeElem || !verifyCommentBtn || !loadingOverlay || !errorMessage || !copyMessage || !loginInstruction) {
    return;
  }

  let scratchUsername = '';
  let activeApprovalWait = null;

  function showLoading(show) {
    loadingOverlay.classList.toggle('hidden', !show);
  }

  function showError(message) {
    errorMessage.textContent = message;
    errorMessage.classList.remove('hidden');
  }

  function hideMessages() {
    errorMessage.classList.add('hidden');
    copyMessage.classList.add('hidden');
  }

  function isNyaitterAddress(value) {
    return NYAITTER_ADDRESS_PATTERN.test(String(value || '').trim());
  }

  function isSafeExternalAuthUrl(rawUrl, nyaitterAddress) {
    try {
      const address = String(nyaitterAddress || '').trim();
      const expectedHost = address.slice(address.lastIndexOf('@') + 1).toLowerCase();
      const url = new URL(rawUrl);
      const localDevelopmentHost = /^(localhost|127\.0\.0\.1)(?::\d{1,5})?$/.test(expectedHost);
      if (url.host.toLowerCase() !== expectedHost) return false;
      return url.protocol === 'https:' || (localDevelopmentHost && url.protocol === 'http:');
    } catch (_) {
      return false;
    }
  }

  const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

  function showApprovalWait() {
    const state = { cancelled: false };
    activeApprovalWait = state;
    loginModal?.classList.add('hidden');
    showLoading(false);
    if (loginApprovalWaitStatus) loginApprovalWaitStatus.textContent = '許可を待機しています…';
    loginApprovalWaitModal?.classList.remove('hidden');
    return state;
  }

  function closeApprovalWait({ restoreLogin = false } = {}) {
    loginApprovalWaitModal?.classList.add('hidden');
    if (restoreLogin) loginModal?.classList.remove('hidden');
  }

  function cancelApprovalWait() {
    if (!activeApprovalWait) return;
    activeApprovalWait.cancelled = true;
    closeApprovalWait({ restoreLogin: true });
    showError('ログインをキャンセルしました。');
  }

  async function completeApprovedLogin(pendingLogin) {
    const approvalId = String(pendingLogin?.approval_id || '');
    const approvalToken = String(pendingLogin?.approval_token || '');
    const expiresAt = new Date(pendingLogin?.expires_at || 0).getTime();
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(approvalId) || !/^[A-Za-z0-9_-]{20,128}$/.test(approvalToken)) {
      throw new Error('ログイン承認情報が無効です。最初からやり直してください。');
    }
    const waitState = showApprovalWait();
    let approved = false;
    try {
      while (Date.now() < expiresAt) {
        if (waitState.cancelled) throw new Error('ログインをキャンセルしました。');
        await wait(2500);
        if (waitState.cancelled) throw new Error('ログインをキャンセルしました。');
        const response = await fetch(`${AUTH_API}/login-approvals/${encodeURIComponent(approvalId)}/poll`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ approval_token: approvalToken }),
        });
        const data = await response.json().catch(() => ({}));
        if (response.status === 202 && data.pending) {
          if (loginApprovalWaitStatus) loginApprovalWaitStatus.textContent = 'ログイン済み端末での許可を待っています…';
          continue;
        }
        if (!response.ok || data.error || !data.success) {
          throw new Error(data.error || 'ログイン要求は許可されませんでした。');
        }
        approved = true;
        return data;
      }
      throw new Error('ログイン承認の有効期限が切れました。最初からやり直してください。');
    } finally {
      const ownsWaitModal = activeApprovalWait === waitState;
      if (ownsWaitModal) {
        activeApprovalWait = null;
        closeApprovalWait({ restoreLogin: !approved });
      }
    }
  }

  function updateLoginMode() {
    const externalLogin = isNyaitterAddress(usernameInput.value);
    loginInstruction.textContent = externalLogin
      ? '入力したNyaitterアドレスのNyaitterサーバーでログインを確認します。'
      : 'ScratchID、またはNyaitterアドレスを入力してください。';
    getCodeBtn.textContent = externalLogin
      ? '外部NyaitterIDでログイン'
      : '認証コードを取得';
  }

  function clearLoginQuery() {
    const url = new URL(window.location.href);
    url.searchParams.delete('login');
    url.searchParams.delete('external_login');
    url.searchParams.delete('state');
    url.searchParams.delete('proof');
    url.searchParams.delete('error');
    window.history.replaceState({}, document.title, `${url.pathname}${url.search}${url.hash}`);
  }

  function resetLoginModal() {
    scratchUsername = '';
    usernameInput.value = '';
    verificationCodeElem.textContent = '';
    profileLink.href = 'https://scratch.mit.edu/';
    authStep2.classList.add('hidden');
    authStep1.classList.remove('hidden');
    hideMessages();
    updateLoginMode();
  }

  function openLoginModal({ reset = false } = {}) {
    if (!loginModal) return;
    if (reset) resetLoginModal();
    else {
      hideMessages();
      updateLoginMode();
    }
    loginModal.classList.remove('hidden');
    window.setTimeout(() => usernameInput.focus(), 0);
  }

  function closeLoginModal() {
    if (!loginModal) return;
    resetLoginModal();
    loginModal.classList.add('hidden');
    if (new URL(window.location.href).searchParams.get('login') === '1') clearLoginQuery();
  }

  window.openNyaitterLoginModal = openLoginModal;
  loginApprovalWaitCancelBtn?.addEventListener('click', cancelApprovalWait);

  if (loginModal) {
    loginModal.querySelector('.modal-close-btn')?.addEventListener('click', closeLoginModal);
    loginModal.addEventListener('click', (event) => {
      if (event.target === loginModal) closeLoginModal();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !loginModal.classList.contains('hidden') && !loadingOverlay.classList.contains('hidden')) return;
      if (event.key === 'Escape' && !loginModal.classList.contains('hidden')) closeLoginModal();
    });
  }

  function finishLogin() {
    localStorage.removeItem('nyaitter_session_token');

    // 先にhistoryを書き換えると、ブラウザが同じURLへのreplaceを最適化して
    // クライアントを再初期化しないことがある。現在のクエリ付きURLから直接遷移先を
    // 組み立て、ログイン済みCookieを使う完全なSPA再初期化を必ず発生させる。
    const url = new URL(window.location.href);
    const pendingConfirm = url.searchParams.get('external_confirm') === '1';
    url.searchParams.delete('login');
    if (!pendingConfirm) {
      url.searchParams.delete('external_login');
      url.searchParams.delete('state');
      url.searchParams.delete('proof');
      url.searchParams.delete('error');
      url.searchParams.delete('nyaitter_address');
      url.searchParams.delete('redirect');
      url.searchParams.delete('external_confirm');
    }
    const pathname = url.pathname === '/login' ? '/' : url.pathname;
    const destination = `${pathname}${url.search}${url.hash}`;
    const currentDestination = `${window.location.pathname}${window.location.search}${window.location.hash}`;

    loginModal?.classList.add('hidden');
    showLoading(false);

    // クエリ除去後も遷移先が現在のURLと同一になる場合、replaceではブラウザが
    // 再読み込みを行わずモーダルが閉じたまま画面が更新されないことがある。
    // その場合は明示的にreloadしてSPAを確実に再初期化する。
    if (destination === currentDestination) {
      window.location.reload();
    } else {
      window.location.replace(destination);
    }
  }

  async function handleExternalLoginCallback() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('external_login') !== '1') return false;

    openLoginModal();
    const state = params.get('state');
    const proof = params.get('proof');
    const externalError = params.get('error');
    if (externalError) {
      showError(`外部Nyaitterログインを完了できませんでした: ${externalError}`);
      return true;
    }
    if (!state || !proof) {
      showError('外部Nyaitterからの認証結果が不足しています。ログインを最初からやり直してください。');
      return true;
    }

    showLoading(true);
    hideMessages();
    try {
      const response = await fetch(`${AUTH_API}/external/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ state, proof }),
      });
      let data = await response.json().catch(() => ({}));
      if (!response.ok || data.error) {
        throw new Error(data.error || '外部Nyaitterログインの確認に失敗しました。');
      }
      if (data.approval_required) data = await completeApprovedLogin(data);
      if (!data.success) throw new Error('セッションの設定に失敗しました。');
      finishLogin();
    } catch (error) {
      showError(error.message);
    } finally {
      showLoading(false);
    }
    return true;
  }

  async function startExternalLogin(nyaitterAddress) {
    const response = await fetch(`${AUTH_API}/external/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ nyaitter_address: nyaitterAddress }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.error || !data.auth_url) {
      throw new Error(data.error || '外部Nyaitterログインを開始できませんでした。');
    }
    if (!isSafeExternalAuthUrl(data.auth_url, nyaitterAddress)) {
      throw new Error('外部ログイン先のURLを検証できませんでした。');
    }
    window.location.assign(data.auth_url);
  }

  getCodeBtn.addEventListener('click', async () => {
    const loginInput = usernameInput.value.trim();
    if (!loginInput) {
      showError('Scratchユーザー名またはNyaitterアドレスを入力してください。');
      return;
    }

    showLoading(true);
    hideMessages();
    try {
      if (isNyaitterAddress(loginInput)) {
        await startExternalLogin(loginInput);
        return;
      }

      scratchUsername = loginInput;
      const response = await fetch(`${AUTH_API}/scratch/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ type: 'generateCode', username: scratchUsername }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.error) throw new Error(data.error || 'コードの生成に失敗しました。');

      verificationCodeElem.textContent = data.code;
      profileLink.href = `https://scratch.mit.edu/users/${encodeURIComponent(scratchUsername)}/#comments`;
      authStep1.classList.add('hidden');
      authStep2.classList.remove('hidden');
    } catch (error) {
      showError(error.message);
    } finally {
      showLoading(false);
    }
  });

  usernameInput.addEventListener('input', updateLoginMode);
  usernameInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      getCodeBtn.click();
    }
  });

  verificationCodeElem.addEventListener('click', () => {
    navigator.clipboard.writeText(verificationCodeElem.textContent).then(() => {
      copyMessage.classList.remove('hidden');
      errorMessage.classList.add('hidden');
      window.setTimeout(() => copyMessage.classList.add('hidden'), 2000);
    }).catch(() => showError('認証コードをコピーできませんでした。手動でコピーしてください。'));
  });

  verifyCommentBtn.addEventListener('click', async () => {
    showLoading(true);
    hideMessages();
    try {
      const response = await fetch(`${AUTH_API}/scratch/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          type: 'verifyComment',
          username: scratchUsername,
          code: verificationCodeElem.textContent,
        }),
      });
      let data = await response.json().catch(() => ({}));
      if (!response.ok || data.error) throw new Error(data.error || '認証に失敗しました。');
      if (data.approval_required) data = await completeApprovedLogin(data);
      if (!data.success) throw new Error('セッションの設定に失敗しました。');
      finishLogin();
    } catch (error) {
      showError(error.message);
    } finally {
      showLoading(false);
    }
  });


  const externalConfirmModal = document.getElementById('external-confirm-modal');
  const externalConfirmInstruction = document.getElementById('external-confirm-instruction');
  const externalConfirmDetail = document.getElementById('external-confirm-detail');
  const externalConfirmAddress = document.getElementById('external-confirm-address');
  const externalConfirmCurrentUser = document.getElementById('external-confirm-current-user');
  const externalConfirmActions = document.getElementById('external-confirm-actions');
  const externalConfirmLoginNeeded = document.getElementById('external-confirm-login-needed');
  const externalConfirmError = document.getElementById('external-confirm-error');
  const externalConfirmLoading = document.getElementById('external-confirm-loading');
  const externalConfirmApproveBtn = document.getElementById('external-confirm-approve-btn');
  const externalConfirmDenyBtn = document.getElementById('external-confirm-deny-btn');
  const externalConfirmOpenLoginBtn = document.getElementById('external-confirm-open-login-btn');
  const externalConfirmCloseBtn = document.getElementById('external-confirm-close-btn');

  let pendingExternalConfirm = null;

  function showExternalConfirmError(message) {
    if (!externalConfirmError) return;
    externalConfirmError.textContent = message;
    externalConfirmError.classList.remove('hidden');
  }

  function hideExternalConfirmError() {
    externalConfirmError?.classList.add('hidden');
  }

  function setExternalConfirmLoading(show) {
    externalConfirmLoading?.classList.toggle('hidden', !show);
  }

  function clearExternalConfirmQuery() {
    const url = new URL(window.location.href);
    url.searchParams.delete('external_confirm');
    url.searchParams.delete('nyaitter_address');
    url.searchParams.delete('state');
    url.searchParams.delete('redirect');
    window.history.replaceState({}, document.title, `${url.pathname}${url.search}${url.hash}`);
  }

  function closeExternalConfirmModal({ clearQuery = true } = {}) {
    externalConfirmModal?.classList.add('hidden');
    pendingExternalConfirm = null;
    if (clearQuery && new URL(window.location.href).searchParams.get('external_confirm') === '1') {
      clearExternalConfirmQuery();
    }
  }

  function openExternalConfirmModal() {
    externalConfirmModal?.classList.remove('hidden');
  }

  function renderExternalConfirmState(context) {
    hideExternalConfirmError();
    if (externalConfirmAddress) externalConfirmAddress.textContent = context.nyaitter_address || '';
    externalConfirmDetail?.classList.remove('hidden');

    if (!context.logged_in) {
      if (externalConfirmInstruction) {
        externalConfirmInstruction.textContent = '外部サーバーからのログイン確認です。先にこのサーバーへログインしてください。';
      }
      if (externalConfirmCurrentUser) externalConfirmCurrentUser.textContent = '未ログイン';
      externalConfirmActions?.classList.add('hidden');
      externalConfirmLoginNeeded?.classList.remove('hidden');
      return;
    }

    if (!context.address_matches) {
      if (externalConfirmInstruction) {
        externalConfirmInstruction.textContent = '要求されたNyaitterアドレスと、いまログインしているアカウントが一致しません。正しいアカウントに切り替えてください。';
      }
      if (externalConfirmCurrentUser) {
        const user = context.user || {};
        externalConfirmCurrentUser.textContent = `${user.name || '不明'}（${user.nyaitter_address || 'アドレスなし'}）`;
      }
      externalConfirmActions?.classList.add('hidden');
      externalConfirmLoginNeeded?.classList.remove('hidden');
      if (externalConfirmOpenLoginBtn) externalConfirmOpenLoginBtn.textContent = 'アカウントを切り替える／ログインする';
      return;
    }

    if (externalConfirmInstruction) {
      externalConfirmInstruction.textContent = '別のNyaitterサーバーが、このアカウントでのログインを確認しようとしています。許可すると、表示名・自己紹介などの基本プロフィールのみが共有されます。';
    }
    if (externalConfirmCurrentUser) {
      const user = context.user || {};
      externalConfirmCurrentUser.textContent = `${user.name || '不明'}（${user.nyaitter_address || ''}）`;
    }
    externalConfirmLoginNeeded?.classList.add('hidden');
    externalConfirmActions?.classList.remove('hidden');
    if (externalConfirmOpenLoginBtn) externalConfirmOpenLoginBtn.textContent = 'ログインする';
  }

  async function loadExternalConfirmContext(params) {
    const query = new URLSearchParams({
      nyaitter_address: params.nyaitter_address,
      state: params.state,
      redirect: params.redirect,
    });
    const response = await fetch(`${AUTH_API}/external/confirm-context?${query.toString()}`, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.error) {
      throw new Error(data.error || '確認情報を取得できませんでした。');
    }
    return data;
  }

  async function handleExternalConfirmRequest() {
    if (!externalConfirmModal) return false;
    const params = new URLSearchParams(window.location.search);
    const fromAuthPath = window.location.pathname === '/auth/external';
    const flagged = params.get('external_confirm') === '1' || fromAuthPath;
    if (!flagged) return false;

    const nyaitterAddress = params.get('nyaitter_address') || '';
    const state = params.get('state') || '';
    const redirect = params.get('redirect') || '';
    if (
      !nyaitterAddress ||
      !state ||
      !redirect ||
      !isNyaitterAddress(nyaitterAddress) ||
      !isSafeExternalAuthUrl(redirect, nyaitterAddress)
    ) {
      openExternalConfirmModal();
      showExternalConfirmError('外部ログイン確認に必要な情報、または遷移先URLが正しくありません。');
      return true;
    }

    pendingExternalConfirm = { nyaitter_address: nyaitterAddress, state, redirect };
    openExternalConfirmModal();
    setExternalConfirmLoading(true);
    hideExternalConfirmError();
    try {
      const context = await loadExternalConfirmContext(pendingExternalConfirm);
      pendingExternalConfirm = {
        ...pendingExternalConfirm,
        ...context,
      };
      renderExternalConfirmState(context);
    } catch (error) {
      showExternalConfirmError(error.message);
      externalConfirmDetail?.classList.add('hidden');
      externalConfirmActions?.classList.add('hidden');
      externalConfirmLoginNeeded?.classList.add('hidden');
    } finally {
      setExternalConfirmLoading(false);
    }
    return true;
  }

  async function approveExternalConfirm() {
    if (!pendingExternalConfirm) return;
    setExternalConfirmLoading(true);
    hideExternalConfirmError();
    try {
      const response = await fetch(`${AUTH_API}/external/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          nyaitter_address: pendingExternalConfirm.nyaitter_address,
          state: pendingExternalConfirm.state,
          redirect: pendingExternalConfirm.redirect,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.error || !data.redirect_url) {
        throw new Error(data.error || 'ログイン許可に失敗しました。');
      }
      if (!isSafeExternalAuthUrl(data.redirect_url, pendingExternalConfirm.nyaitter_address)) {
        throw new Error('外部ログインの遷移先URLを検証できませんでした。');
      }
      window.location.assign(data.redirect_url);
    } catch (error) {
      showExternalConfirmError(error.message);
      setExternalConfirmLoading(false);
    }
  }

  function denyExternalConfirm() {
    if (!pendingExternalConfirm?.redirect) {
      closeExternalConfirmModal();
      return;
    }
    try {
      if (!isSafeExternalAuthUrl(
        pendingExternalConfirm.redirect,
        pendingExternalConfirm.nyaitter_address,
      )) {
        throw new Error('Unsafe external redirect');
      }
      const target = new URL(pendingExternalConfirm.redirect);
      target.searchParams.set('external_login', '1');
      target.searchParams.set('state', pendingExternalConfirm.state || '');
      target.searchParams.set('error', 'user_denied');
      window.location.assign(target.toString());
    } catch (_) {
      closeExternalConfirmModal();
    }
  }

  externalConfirmApproveBtn?.addEventListener('click', () => {
    void approveExternalConfirm();
  });
  externalConfirmDenyBtn?.addEventListener('click', () => {
    denyExternalConfirm();
  });
  externalConfirmOpenLoginBtn?.addEventListener('click', () => {
    const returnUrl = new URL(window.location.href);
    returnUrl.searchParams.set('external_confirm', '1');
    if (pendingExternalConfirm?.nyaitter_address) {
      returnUrl.searchParams.set('nyaitter_address', pendingExternalConfirm.nyaitter_address);
    }
    if (pendingExternalConfirm?.state) {
      returnUrl.searchParams.set('state', pendingExternalConfirm.state);
    }
    if (pendingExternalConfirm?.redirect) {
      returnUrl.searchParams.set('redirect', pendingExternalConfirm.redirect);
    }
    window.history.replaceState({}, document.title, `${returnUrl.pathname}${returnUrl.search}${returnUrl.hash}`);
    closeExternalConfirmModal({ clearQuery: false });
    openLoginModal({ reset: true });
  });
  externalConfirmCloseBtn?.addEventListener('click', () => closeExternalConfirmModal());
  externalConfirmModal?.addEventListener('click', (event) => {
    if (event.target === externalConfirmModal) closeExternalConfirmModal();
  });


  updateLoginMode();
  if (new URL(window.location.href).searchParams.get('login') === '1') openLoginModal();
  void handleExternalLoginCallback();
  void handleExternalConfirmRequest();
});
