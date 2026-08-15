function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

/**
 * Markdownリンク用のURLはHTTPSだけを許可する。
 * プロトコル相対URL・data:・javascript:・file:・認証情報付きURLも拒否する。
 */
export function getSafeMarkdownUrl(value) {
    const raw = String(value || '');
    // 制御文字とそのパーセントエンコードは、ブラウザ・中継層ごとの解釈差を避けるため拒否する。
    if (
        /[\u0000-\u001F\u007F]/.test(raw) ||
        /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(raw)
    )
        return '';
    try {
        const url = new URL(raw);
        if (url.protocol !== 'https:' || url.username || url.password) return '';
        return url.href;
    } catch (_) {
        return '';
    }
}

function renderInlineMarkdown(
    source,
    { renderText, renderLinkLabel, sanitizeUrl, renderSyntax = () => '' },
) {
    // `_emoji_` は既存のカスタム絵文字記法なので、下線による斜体は採用しない。
    const markdownPattern = /`([^`\r\n]{1,500})`|\[([^\]\r\n]{1,200})\]\((https?:\/\/[^\s<>"']{1,2048})\)|\*\*\*([^*\r\n]{1,500})\*\*\*|\*\*([^*\r\n]{1,500})\*\*|__([^_\r\n]{1,500})__|~~([^~\r\n]{1,500})~~|(?:(?<!\*)|(?<=\*\*))\*([^*\r\n]{1,500})\*(?=$|[^*]|\*\*)|\|\|([^|\r\n]{1,1000})\|\|/g;
    let output = '';
    let previousIndex = 0;
    let match;

    while ((match = markdownPattern.exec(source)) !== null) {
        output += renderText(source.slice(previousIndex, match.index));
        if (match[1] !== undefined) {
            output += `${renderSyntax('`')}<code>${escapeHtml(match[1])}</code>${renderSyntax('`')}`;
        } else if (match[2] !== undefined) {
            const safeUrl = sanitizeUrl(match[3]);
            output += safeUrl
                ? `${renderSyntax('[')}<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer">${renderLinkLabel(match[2])}</a>${renderSyntax('](')}${renderSyntax(match[3])}${renderSyntax(')')}`
                : renderText(match[0]);
        } else if (match[4] !== undefined) {
            output += `${renderSyntax('***')}<strong><em>${renderText(match[4])}</em></strong>${renderSyntax('***')}`;
        } else if (match[5] !== undefined || match[6] !== undefined) {
            const marker = match[5] !== undefined ? '**' : '__';
            output += `${renderSyntax(marker)}<strong>${renderText(match[5] ?? match[6])}</strong>${renderSyntax(marker)}`;
        } else if (match[7] !== undefined) {
            output += `${renderSyntax('~~')}<del>${renderText(match[7])}</del>${renderSyntax('~~')}`;
        } else if (match[8] !== undefined) {
            output += `${renderSyntax('*')}<em>${renderText(match[8])}</em>${renderSyntax('*')}`;
        } else if (match[9] !== undefined) {
            output += `${renderSyntax('||')}<span class="markdown-spoiler" role="button" tabindex="0" aria-expanded="false" aria-label="ネタバレを表示"><span class="markdown-spoiler-content" aria-hidden="true">${renderText(match[9])}</span></span>${renderSyntax('||')}`;
        }
        previousIndex = markdownPattern.lastIndex;
    }

    return output + renderText(source.slice(previousIndex));
}

/**
 * 生HTMLを一切許可しない、投稿・DM用の限定Markdown。
 * 許可記法:
 * - インライン: ***太字斜体*** / **太字** / __太字__ / *斜体* / ~~取り消し線~~ / `コード` / ||ネタバレ||
 * - リンク: [ラベル](https://example.com)
 * - ブロック: ## 見出し、> 引用、- 箇条書き、1. 番号付きリスト、```コードブロック```
 *
 * HTML、画像、テーブル、埋め込み、任意属性は文字列としてエスケープする。
 */
export function renderLimitedMarkdown(
    input,
    {
        renderText = escapeHtml,
        renderLinkLabel = escapeHtml,
        sanitizeUrl = getSafeMarkdownUrl,
        renderSyntax = () => '',
        allowHeadings = true,
        allowBlockquotes = true,
    } = {},
) {
    const source = typeof input === 'string' ? input : '';
    const inlineOptions = {
        renderText,
        renderLinkLabel,
        sanitizeUrl,
        renderSyntax,
    };
    const renderInline = (value) => renderInlineMarkdown(value, inlineOptions);
    const lines = source.replace(/\r\n?/g, '\n').split('\n');
    const output = [];
    const paragraphLines = [];

    const flushParagraph = () => {
        if (paragraphLines.length === 0) return;
        output.push(`<p>${renderInline(paragraphLines.join('\n'))}</p>`);
        paragraphLines.length = 0;
    };

    for (let index = 0; index < lines.length;) {
        const line = lines[index];

        if (/^```[^`\r\n]*$/.test(line)) {
            let endIndex = index + 1;
            while (endIndex < lines.length && !/^```\s*$/.test(lines[endIndex])) {
                endIndex += 1;
            }
            if (endIndex < lines.length) {
                flushParagraph();
                const code = escapeHtml(
                    lines.slice(index + 1, endIndex).join('\n'),
                );
                const openingFence = renderSyntax('```');
                const closingFence = renderSyntax('```');
                output.push(
                    `<pre><code>${openingFence ? `${openingFence}\n` : ''}${code}${closingFence ? `\n${closingFence}` : ''}</code></pre>`,
                );
                index = endIndex + 1;
                continue;
            }
        }

        const headingMatch = /^(#{1,3})\s+([^\s].*)$/.exec(line);
        if (!allowHeadings && headingMatch) {
            flushParagraph();
            output.push(
                `<p>${renderSyntax(headingMatch[1])} ${renderInline(headingMatch[2])}</p>`,
            );
            index += 1;
            continue;
        }
        if (allowHeadings && headingMatch) {
            flushParagraph();
            const level = headingMatch[1].length;
            output.push(`<h${level}>${renderInline(headingMatch[2])}</h${level}>`);
            index += 1;
            continue;
        }

        const quoteMatch = /^> (.*)$/.exec(line);
        if (!allowBlockquotes && quoteMatch) {
            flushParagraph();
            output.push(
                `<p>${renderSyntax('>')} ${renderInline(quoteMatch[1])}</p>`,
            );
            index += 1;
            continue;
        }
        if (allowBlockquotes && quoteMatch) {
            flushParagraph();
            const quoteLines = [];
            while (index < lines.length && /^> /.test(lines[index])) {
                quoteLines.push(lines[index].replace(/^> /, ''));
                index += 1;
            }
            output.push(`<blockquote>${renderInline(quoteLines.join('\n'))}</blockquote>`);
            continue;
        }

        const unorderedMatch = /^[-*+]\s+(.+)$/.exec(line);
        if (unorderedMatch) {
            flushParagraph();
            const items = [];
            while (index < lines.length) {
                const itemMatch = /^[-*+]\s+(.+)$/.exec(lines[index]);
                if (!itemMatch) break;
                const marker = lines[index].match(/^[-*+]\s+/)?.[0] || '';
                items.push(
                    `<li>${renderSyntax(marker)}${renderInline(itemMatch[1])}</li>`,
                );
                index += 1;
            }
            output.push(`<ul>${items.join('')}</ul>`);
            continue;
        }

        const orderedMatch = /^\d{1,3}[.)]\s+(.+)$/.exec(line);
        if (orderedMatch) {
            flushParagraph();
            const items = [];
            while (index < lines.length) {
                const itemMatch = /^\d{1,3}[.)]\s+(.+)$/.exec(lines[index]);
                if (!itemMatch) break;
                const marker =
                    lines[index].match(/^\d{1,3}[.)]\s+/)?.[0] || '';
                items.push(
                    `<li>${renderSyntax(marker)}${renderInline(itemMatch[1])}</li>`,
                );
                index += 1;
            }
            output.push(`<ol>${items.join('')}</ol>`);
            continue;
        }

        if (line.trim() === '') {
            flushParagraph();
            output.push('<p class="markdown-empty-line"><br></p>');
            index += 1;
            continue;
        }

        paragraphLines.push(line);
        index += 1;
    }

    flushParagraph();
    return output.join('');
}
