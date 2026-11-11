// ==UserScript==
// @name         ChatGPT 回答完了デスクトップ通知
// @namespace    local.chatgpt.notification
// @version      1.9.1
// @description  ChatGPTの質問・回答・会話タイトルをデスクトップ通知
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-idle
// @grant        GM_notification
// @grant        GM_registerMenuCommand
// ==/UserScript==

(() => {
    'use strict';

    const COMPLETE_DELAY_MS = 1200;
    const CHECK_INTERVAL_MS = 250;
    const MAX_PROMPT_LENGTH = 80;
    const MAX_ANSWER_LENGTH = 180;

    let wasGenerating = false;
    let completionTimer = null;
    let scheduled = false;
    let generationContext = null;

    // 共通処理
    function isVisible(element) {
        if (!element || !element.isConnected) return false;
        const style = getComputedStyle(element);
        return element.getClientRects().length > 0 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            style.opacity !== '0';
    }

    function normalizeText(text) {
        return (text || '').replace(/\s+/g, ' ').trim();
    }

    function truncate(text, maxLength) {
        return text.length <= maxLength ? text : text.slice(0, maxLength) + '...';
    }

    // 会話タイトル
    function getConversationTitle() {
        const title = document.title.replace(/\s*[-|–—]\s*ChatGPT\s*$/i, '').trim();
        if (title && !/^chatgpt$/i.test(title)) return title;
        const match = location.pathname.match(/\/c\/([^/?#]+)/);
        return match ? `チャット ${match[1].slice(-8)}` : 'ChatGPT';
    }

    // 最新のユーザーメッセージ
    function getLatestUserMessage() {
        const messages = document.querySelectorAll('[class~="group/user-message"]');
        for (let i = messages.length - 1; i >= 0; i--) {
            const message = messages[i];
            if (!isVisible(message)) continue;
            const bubble = message.querySelector('[class~="bg-user-message"]') || message;
            const textElement = bubble.querySelector('[class~="text-size-chat"][class~="whitespace-pre-wrap"]');
            const text = normalizeText(textElement ? textElement.innerText : bubble.innerText);
            if (text) return text;
        }

        const bubbles = document.querySelectorAll('[class~="bg-user-message"]');
        for (let i = bubbles.length - 1; i >= 0; i--) {
            const text = normalizeText(bubbles[i].innerText);
            if (text) return text;
        }

        const standardMessages = document.querySelectorAll('[data-message-author-role="user"]');
        for (let i = standardMessages.length - 1; i >= 0; i--) {
            const text = normalizeText(standardMessages[i].innerText);
            if (text) return text;
        }

        console.warn('[ChatGPT Notify] 質問取得失敗');
        return '取得できませんでした';
    }

    // 最新のアシスタント回答
    function getLatestAssistantMessage() {
        const blocks = document.querySelectorAll('div.block-BQZwFn');
        for (let i = blocks.length - 1; i >= 0; i--) {
            const block = blocks[i];
            const candidates = [block, ...block.querySelectorAll('div')];
            let bestText = '';
            for (const element of candidates) {
                const text = normalizeText(element.innerText);
                if (text.length > bestText.length) bestText = text;
            }
            if (bestText) return bestText;
        }

        const messages = document.querySelectorAll('[data-message-author-role="assistant"]');
        for (let i = messages.length - 1; i >= 0; i--) {
            const text = normalizeText(messages[i].innerText);
            if (text) return text;
        }
        return '取得できませんでした';
    }

    // 生成状態判定
    function isGenerating() {
        const selectors = [
            '[data-testid="stop-button"]',
            'form button.size-token-button-composer:has(svg path[d^="M4.5 5.75C4.5 5.05964"])'
        ];
        const stopButton = document.querySelector(selectors.join(', '));
        if (isVisible(stopButton)) return true;

        const buttons = document.querySelectorAll('button.size-token-button-composer, [data-testid="stop-button"]');
        for (const button of buttons) {
            if (!isVisible(button)) continue;
            const label = [
                button.getAttribute('aria-label') || '',
                button.getAttribute('title') || '',
                button.innerText || ''
            ].join(' ').toLowerCase();
            if (/stop generating|stop streaming|stop response/.test(label) ||
                /生成を停止|回答を停止|応答を停止/.test(label)) return true;
        }
        return false;
    }

    // デスクトップ通知
    function isTabActive() {
        return document.visibilityState === 'visible' && document.hasFocus();
    }

    function notify(context, force = false) {
        if (!force && isTabActive()) {
            console.log('[ChatGPT Notify] アクティブなタブのため通知をスキップ');
            return;
        }

        GM_notification({
            title: `ChatGPT | ${context.title}`,
            text: [
                `質問: ${truncate(context.prompt, MAX_PROMPT_LENGTH)}`,
                `回答: ${truncate(context.answer, MAX_ANSWER_LENGTH)}`
            ].join(' ｜ '),
            timeout: 15000,
            silent: false,
            onclick: () => window.focus()
        });
    }

    // 生成状態監視
    function checkGenerationState() {
        const generating = isGenerating();

        if (generating) {
            if (!wasGenerating) {
                wasGenerating = true;
                generationContext = {
                    title: getConversationTitle(),
                    prompt: getLatestUserMessage()
                };
                console.log('[ChatGPT Notify] 生成開始:', generationContext);
            }
            if (completionTimer !== null) {
                clearTimeout(completionTimer);
                completionTimer = null;
            }
            return;
        }

        if (wasGenerating && completionTimer === null) {
            completionTimer = setTimeout(() => {
                completionTimer = null;
                if (isGenerating()) return;
                wasGenerating = false;

                const latestPrompt = getLatestUserMessage();
                const context = {
                    title: getConversationTitle(),
                    prompt: latestPrompt !== '取得できませんでした'
                        ? latestPrompt
                        : generationContext.prompt,
                    answer: getLatestAssistantMessage()
                };

                console.log('[ChatGPT Notify] 生成完了:', context);
                notify(context);
                generationContext = null;
            }, COMPLETE_DELAY_MS);
        }
    }

    // DOM監視
    function scheduleCheck() {
        if (scheduled) return;
        scheduled = true;
        setTimeout(() => {
            scheduled = false;
            checkGenerationState();
        }, 100);
    }

    function initialize() {
        wasGenerating = isGenerating();
        if (wasGenerating) {
            generationContext = {
                title: getConversationTitle(),
                prompt: getLatestUserMessage()
            };
        }

        const observer = new MutationObserver(scheduleCheck);
        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true
        });
        setInterval(checkGenerationState, CHECK_INTERVAL_MS);
        console.log('[ChatGPT Notify] 監視開始');
    }

    // Tampermonkeyメニュー
    GM_registerMenuCommand('通知テスト', () => {
        notify({
            title: getConversationTitle(),
            prompt: getLatestUserMessage(),
            answer: getLatestAssistantMessage()
        }, true);
    });

    GM_registerMenuCommand('質問内容を確認', () => {
        console.log('[ChatGPT Notify] 質問内容:', getLatestUserMessage());
    });

    GM_registerMenuCommand('回答内容を確認', () => {
        console.log('[ChatGPT Notify] 回答内容:', getLatestAssistantMessage());
    });

    GM_registerMenuCommand('生成状態を確認', () => {
        console.log('[ChatGPT Notify] 現在の状態:', isGenerating() ? '生成中' : '待機中');
    });

    GM_registerMenuCommand('タブ状態を確認', () => {
        console.log('[ChatGPT Notify] タブ状態:', isTabActive() ? 'アクティブ' : 'バックグラウンド');
    });

    initialize();
})();
