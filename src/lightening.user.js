// ==UserScript==
// @name         YouTube Hard Block: Fullscreen, Chat & Miniplayer
// @namespace    http://tampermonkey.net/
// @version      4.0
// @description  全画面化・チャット通信・ミニプレーヤーを根本無効化します
// @match        https://www.youtube.com/*
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

    // 1. 全画面化 (requestFullscreen) の完全無効化
    if (win.Element) {
        win.Element.prototype.requestFullscreen = function() {
            return Promise.reject(new Error('Fullscreen disabled'));
        };
        win.Element.prototype.webkitRequestFullscreen = function() {};
    }

    // 2. チャット通信 (live_chat) のネットワーク遮断
    if (win.fetch) {
        const origFetch = win.fetch;
        win.fetch = function(input, init) {
            const url = typeof input === 'string' ? input : (input && input.url) || '';
            if (url.includes('live_chat')) {
                return Promise.resolve(new Response('', { status: 200, statusText: 'OK' }));
            }
            return origFetch.apply(this, arguments);
        };
    }
    if (win.XMLHttpRequest) {
        const origOpen = win.XMLHttpRequest.prototype.open;
        win.XMLHttpRequest.prototype.open = function(method, url) {
            if (typeof url === 'string' && url.includes('live_chat')) {
                this.send = function() {};
                return;
            }
            return origOpen.apply(this, arguments);
        };
    }

    // 3. ミニプレーヤー起動イベントの最上流キャプチャ＆即時抹殺
    const killEvent = function(e) {
        e.stopPropagation();
        e.stopImmediatePropagation();
        e.preventDefault();
    };

    const miniplayerEvents = [
        'yt-miniplayer-activate',
        'yt-miniplayer-active',
        'yt-open-miniplayer'
    ];
    miniplayerEvents.forEach(evt => {
        win.addEventListener(evt, killEvent, true);
        document.addEventListener(evt, killEvent, true);
    });

    // YouTube内部の共通Action経由でのミニプレーヤー化をブロック
    const handleYtAction = function(e) {
        const action = e.detail && e.detail.actionName;
        if (action && (action.includes('miniplayer') || action.includes('MINIPLAYER'))) {
            killEvent(e);
        }
    };
    win.addEventListener('yt-action', handleYtAction, true);
    document.addEventListener('yt-action', handleYtAction, true);

    // 4. YouTube内部設定 (ytcfg) のミニプレーヤースワイプ無効化
    const patchYtcfg = function() {
        if (win.ytcfg && win.ytcfg.set) {
            win.ytcfg.set({
                WEB_ENABLE_MINIPLAYER: false,
                ENABLE_MINIPLAYER_SWIPE: false
            });
        }
    };
    patchYtcfg();
    document.addEventListener('DOMContentLoaded', patchYtcfg);

    // 5. チャット・ミニプレーヤー要素のCSS完全抹殺
    const style = document.createElement('style');
    style.textContent = `
        #chat, ytd-live-chat-frame, #chat-container, ytd-miniplayer {
            display: none !important;
        }
    `;
    (document.head || document.documentElement).appendChild(style);
})();
