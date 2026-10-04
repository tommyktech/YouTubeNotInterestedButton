// ==UserScript==
// @name         YouTube Hard Block: Fullscreen, Chat & Miniplayer
// @namespace    http://tampermonkey.net/
// @version      3.0
// @description  全画面化・チャット読み込み・ミニプレーヤーをAPI/ネットワークレベルで根本遮断します
// @match        https://www.youtube.com/*
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const noopPromise = () => Promise.reject(new Error('Blocked by UserScript'));
    const noop = () => {};

    // =========================================================
    // 1. 全画面化 (requestFullscreen) の根本遮断
    // =========================================================
    if (win.Element) {
        win.Element.prototype.requestFullscreen = noopPromise;
        win.Element.prototype.webkitRequestFullscreen = noopPromise;
    }

    // =========================================================
    // 2. ミニプレーヤー (Picture-in-Picture & ytd-miniplayer) の根本遮断
    // =========================================================
    if (win.HTMLVideoElement) {
        win.HTMLVideoElement.prototype.requestPictureInPicture = noopPromise;
    }

    // Element prototypeレベルで active プロパティの更新をブロック
    if (win.Element) {
        try {
            Object.defineProperty(win.Element.prototype, 'active', {
                get: function() { return false; },
                set: noop, // active = true への変更要求をすべて無視
                configurable: true
            });
        } catch (e) {}

        win.Element.prototype.open = noop;
        win.Element.prototype.activate = noop;
        win.Element.prototype.selectMiniplayer = noop;
    }

    // =========================================================
    // 3. チャット領域の通信・データ読み込み根本遮断
    // =========================================================

    // (A) fetch リクエストのフック (live_chat 通信の阻止)
    const origFetch = win.fetch;
    if (origFetch) {
        win.fetch = function(input, init) {
            const url = typeof input === 'string' ? input : (input && input.url) || '';
            if (url.includes('live_chat')) {
                return Promise.resolve(new Response('', { status: 200, statusText: 'OK' }));
            }
            return origFetch.apply(this, arguments);
        };
    }

    // (B) XMLHttpRequest のフック
    const origXHR = win.XMLHttpRequest;
    if (origXHR) {
        const origOpen = origXHR.prototype.open;
        origXHR.prototype.open = function(method, url) {
            if (typeof url === 'string' && url.includes('live_chat')) {
                this.send = noop; // 通信送信を即座に破棄
                return;
            }
            return origOpen.apply(this, arguments);
        };
    }

    // (C) iframe (live_chat) の src 設定を直接フックして阻止
    if (win.HTMLIFrameElement) {
        const desc = Object.getOwnPropertyDescriptor(win.HTMLIFrameElement.prototype, 'src');
        if (desc && desc.set) {
            Object.defineProperty(win.HTMLIFrameElement.prototype, 'src', {
                set: function(val) {
                    if (typeof val === 'string' && val.includes('live_chat')) {
                        return; // src 代入自体を無効化
                    }
                    desc.set.call(this, val);
                },
                get: desc.get,
                configurable: true
            });
        }
    }

    // (D) YouTube初期データ (ytInitialData) からチャットオブジェクトを破棄
    let initialData = win.ytInitialData;
    Object.defineProperty(win, 'ytInitialData', {
        get: () => initialData,
        set: (data) => {
            if (data && data.contents && data.contents.twoColumnWatchNextResults) {
                delete data.contents.twoColumnWatchNextResults.conversation;
            }
            initialData = data;
        },
        configurable: true
    });
})();
