document.addEventListener('DOMContentLoaded', async () => {
	const container = document.getElementById('emoji-container');
	if (!container) return;

	const isSafeEmojiId = (value) => /^[A-Za-z0-9_-]{1,80}$/.test(String(value || ''));
	const showMessage = (message, className) => {
		container.replaceChildren();
		const paragraph = document.createElement('p');
		paragraph.className = className;
		paragraph.textContent = message;
		container.appendChild(paragraph);
	};

	try {
		const response = await fetch('/emoji/list.json', { credentials: 'same-origin' });
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const emojiList = await response.json();
		if (!Array.isArray(emojiList) || emojiList.length === 0) {
			showMessage('絵文字が見つかりませんでした。', 'error-text');
			return;
		}

		const fragment = document.createDocumentFragment();
		for (const emoji of emojiList) {
			const emojiId = String(emoji?.id || '');
			if (!isSafeEmojiId(emojiId)) continue;
			const displayName = String(emoji?.name || emojiId).slice(0, 120);

			const card = document.createElement('div');
			card.className = 'emoji-card';
			const image = document.createElement('img');
			image.src = `/emoji/${encodeURIComponent(emojiId)}.svg`;
			image.alt = displayName;
			image.className = 'emoji-image';
			image.loading = 'lazy';
			const name = document.createElement('p');
			name.className = 'emoji-name';
			name.textContent = displayName;
			const wrapper = document.createElement('div');
			wrapper.className = 'id-wrapper';
			const code = document.createElement('span');
			code.className = 'emoji-id-code';
			code.title = `_${emojiId}_`;
			code.textContent = `_${emojiId}_`;
			const button = document.createElement('button');
			button.type = 'button';
			button.className = 'copy-button';
			button.dataset.emojiId = emojiId;
			button.textContent = 'コピー';
			wrapper.append(code, button);
			card.append(image, name, wrapper);
			fragment.appendChild(card);
		}

		if (!fragment.childNodes.length) {
			showMessage('利用可能な絵文字が見つかりませんでした。', 'error-text');
			return;
		}
		container.replaceChildren(fragment);
		container.addEventListener('click', async (event) => {
			const button = event.target.closest('.copy-button');
			if (!button || !container.contains(button)) return;
			const emojiId = button.dataset.emojiId;
			if (!isSafeEmojiId(emojiId)) return;
			try {
				await navigator.clipboard.writeText(`_${emojiId}_`);
				const originalText = button.textContent;
				button.textContent = 'コピーしました!';
				button.disabled = true;
				setTimeout(() => {
					button.textContent = originalText;
					button.disabled = false;
				}, 1500);
			} catch (error) {
				console.error('クリップボードへのコピーに失敗しました:', error);
				alert('コピーに失敗しました。');
			}
		});
	} catch (error) {
		console.error('絵文字リストの読み込みに失敗しました:', error);
		showMessage('絵文字リストの読み込みに失敗しました。', 'error-text');
	}
});
