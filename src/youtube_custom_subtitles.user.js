// ==UserScript==
// @name         Youtube API Custom Subtitles
// @namespace    yt-custom-sub
// @version      16.0
// @match        https://www.youtube.com/watch*
// @match        https://www.youtube.com/shorts/*
// @run-at       document-start
// @sandbox      raw
// @grant        none
// @noframes
// ==/UserScript==

(() => {
    'use strict';
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    let captionURL = null;
    let cues = [];              // 最終的に表示に使う（翻訳・分割済み）cue
    let rawCues = null;         // バックグラウンドで取得した「原文のまま」のcue
    let overlay = null;
    let rafId = 0;
    let loading = false;        // ボタン側処理（句読点〜翻訳）の実行中フラグ
    let preparing = false;      // バックグラウンド取得の実行中フラグ
    let prepared = false;       // バックグラウンド取得が完了しているか
    let generation = 0;         // 動画切り替え世代カウンタ（競合防止用）
    let currentVideoId = null;
    let customSubtitlesOn = false; // 自前字幕が現在表示中かどうか

    // ============================================================
    // デバッグログ
    // ============================================================
    const DEBUG = true; // 原因調査が終わったら false にしてよい
    const dbg = (...args) => { if (DEBUG) console.log('[YT-CUSTOM][dbg]', ...args); };

    // fetch/XHRで実際に飛んだURL（字幕以外も含む）を直近N件だけ保持しておき、
    // 失敗時にまとめてダンプできるようにする
    const RECENT_URL_LIMIT = 40;
    const recentRequestURLs = [];
    function pushRecentURL(url) {
        if (!url) return;
        recentRequestURLs.push({ t: Date.now(), url: String(url) });
        if (recentRequestURLs.length > RECENT_URL_LIMIT) recentRequestURLs.shift();
    }

    function dumpDiagnostics(label) {
        console.group(`[YT-CUSTOM][diag] ${label}`);
        console.log('videoId:', getVideoId(), 'currentVideoId:', currentVideoId, 'generation:', generation);
        console.log('captionURL:', captionURL);
        const settingsBtn = document.querySelector('.ytp-settings-button');
        const ccBtn = document.querySelector('.ytp-subtitles-button');
        console.log('settingsButton found:', !!settingsBtn);
        console.log('ccButton found:', !!ccBtn, 'aria-pressed:', ccBtn?.getAttribute('aria-pressed'));
        console.log('menuItems now:', getMenuItems().map(el => (el.textContent || '').trim()));
        console.log('recentRequestURLs (直近%d件):', recentRequestURLs.length);
        console.table(recentRequestURLs.map(r => ({ t: new Date(r.t).toLocaleTimeString(), url: r.url })));
        console.groupEnd();
    }

    // ============================================================
    // メニュー項目の参照（診断ログ用）
    // ============================================================

    function getMenuItems() {
        return Array.from(document.querySelectorAll('.ytp-menuitem'));
    }




    // ============================================================
    // 1. YouTube自身の字幕リクエストを捕捉
    // ============================================================

    const isCaptionURL = url =>
        /\/api\/timedtext/i.test(url) ||
        /[?&](fmt|kind)=(json3|srv3|vtt)/i.test(url);

    const captureURL = url => {
        pushRecentURL(url);
        if (url && isCaptionURL(url)) {
            captionURL = url;
            console.log('[YT-CUSTOM] caption URL captured:', url);
        }
    };

    // captionURLから lang パラメータを取得
    function getCaptionLang() {
        if (!captionURL) return null;
        try {
            return new URL(captionURL).searchParams.get('lang');
        } catch {
            return null;
        }
    }

    const nativeFetch = window.fetch;

    window.fetch = function (...args) {
        try {
            const input = args[0];
            captureURL(
                typeof input === 'string'
                    ? input
                    : input?.url || ''
            );
        } catch {}

        return nativeFetch.apply(this, args);
    };

    const nativeOpen = XMLHttpRequest.prototype.open;

    XMLHttpRequest.prototype.open = function (method, url) {
        try {
            captureURL(String(url));
        } catch {}

        return nativeOpen.apply(this, arguments);
    };

    function scanResources() {
        for (const r of performance.getEntriesByType('resource')) {
            captureURL(r.name);
        }
    }

    // ============================================================
    // 2. 実字幕データ取得
    // ============================================================
    function cleanCaptionText(text) {
        return text
            .replace(/\[music\]/gi, '')
            .replace(/\n/gi, ' ')
            .trim();
    }

    // クリーニング後、実質空(">>"だけ、記号だけ等)になったcueを判定
    function isEmptyCue(text) {
        if (!text) return true;
        // ">>" だけ、または前後に空白があっても ">>" のみの場合
        if (/^>+\s*$/.test(text)) return true;
        return false;
    }

    async function fetchCaption() {
        scanResources();

        if (!captionURL) {
            throw new Error(
                'YouTubeの字幕リクエストを捕捉できませんでした。'
            );
        }

        const url = new URL(captionURL);

        // 元のURLに含まれるtoken等はすべて保持
        url.searchParams.set('fmt', 'json3');

        const response = await nativeFetch(
            url.toString(),
            { credentials: 'include' }
        );

        const text = await response.text();

        if (!text.trim()) {
            throw new Error(
                '字幕APIが空レスポンスを返しました。'
            );
        }

        try {
            return parseJson3(JSON.parse(text));
        } catch {}

        return parseXML(text);
    }

    function parseJson3(data) {
        const result = [];

        for (const event of data?.events || []) {
            if (!event.segs) continue;
            // console.log("event:", event);

            const text = cleanCaptionText(
                event.segs
                .map(x => x?.utf8 || '')
                .join('')
            );

            // if (!text) continue;
            if (isEmptyCue(text)) continue;

            const start = Number(event.tStartMs || 0);
            const dur = Number(event.dDurationMs || 0);

            result.push({
                start,
                end: dur ? start + dur : null,
                text
            });
        }

        return dedupe(result);
    }

    function parseXML(xml) {
        const doc =
              new DOMParser().parseFromString(
                  xml,
                  'text/xml'
              );

        const result = [];

        for (const node of doc.querySelectorAll('text')) {
            const start =
                  Number(
                      node.getAttribute('start') || 0
                  ) * 1000;

            const dur =
                  Number(
                      node.getAttribute('dur') || 0
                  ) * 1000;

            const text =
                  cleanCaptionText(
                      decodeHTML(
                          node.textContent || ''
                      )
                  );

            if (isEmptyCue(text)) continue;
            // if (!text) continue;

            result.push({
                start,
                end: dur ? start + dur : null,
                text
            });
        }

        return dedupe(result);
    }

    function decodeHTML(text) {
        const el = document.createElement('textarea');
        el.innerHTML = text;
        return el.value
            .replace(/\s+/g, ' ')
            .trim();
    }

    function dedupe(items) {
        const seen = new Set();

        return items.filter(x => {
            const key = `${x.start}\0${x.text}`;

            if (seen.has(key)) return false;

            seen.add(key);
            return true;
        });
    }

    // ============================================================
    // 句読点区切り変換（パターンB: 元cue境界を尊重した文字補間）
    // ============================================================
    const SENTENCE_END_CHARS = new Set(['.', '!', '?', '…']);
    const COMMA_CHARS = new Set(['、', ',']);
    const TRAILING_CHARS = new Set(['」', '』', '）', ')', '"', "'", '”', '】']);
    const SPEAKER_MARK = '>>';
    const COMMA_BREAK_THRESHOLD = 20;

    // 「区切ってはいけない . / , 」を検出する正規表現群
    // 必要に応じて自由に追加してください
    const NON_BREAK_PATTERNS = [
        /\d[.,]\d/g,                                   // 1.2 / 1,234 のような数字内の区切り
        /\b[A-Za-z]\.(?=[A-Za-z]\.)/g,                 // A.M. / U.S. / Ph.D. の1文字目.2文字目...
        /\b(?:[A-Za-z]\.){2,}/g,                       // A.M. / U.S. のような連続頭字語全体
        /\b(?:Mr|Mrs|Ms|Dr|Prof|St|Jr|Sr|vs|etc|e\.g|i\.e|Inc|Ltd|Co)\./gi, // 略語
        /\d+\.\d+(?:\.\d+)*/g,                         // v1.2.3 のようなバージョン番号
        /\b[\w.-]+\.[A-Za-z]{2,}(?=\/|\b)/g,           // example.com のようなドメイン
    ];

    // text中で「区切ってはいけないインデックス集合」を作る
    function computeNonBreakIndices(text) {
        const protectedIdx = new Set();
        for (const pattern of NON_BREAK_PATTERNS) {
            pattern.lastIndex = 0;
            let m;
            while ((m = pattern.exec(text))) {
                for (let k = m.index; k < m.index + m[0].length; k++) {
                    if (text[k] === '.' || text[k] === ',') {
                        protectedIdx.add(k);
                    }
                }
                if (m[0].length === 0) pattern.lastIndex++; // 無限ループ防止
            }
        }
        return protectedIdx;
    }

    function segmentByPunctuation(cues) {
        const timeline = buildCharTimeline(normalizeCueEnds(cues));
        const fullText = timeline.map(t => t.ch).join('');
        const nonBreakIdx = computeNonBreakIndices(fullText);

        const sentences = [];
        let buffer = '';
        let bufferStart = null;
        let i = 0;
        const flush = (endTime) => {
            const text = buffer.trim();
            if (text) sentences.push({ start: bufferStart, end: endTime, text });
            buffer = '';
            bufferStart = null;
        };
        const isSpeakerMarkAt = (idx) =>
        timeline[idx]?.ch === '>' &&
              timeline[idx + 1]?.ch === '>';

        while (i < timeline.length) {
            if (isSpeakerMarkAt(i) && buffer.trim()) {
                const prevEnd = timeline[i - 1]?.endTime ?? timeline[i].startTime;
                flush(prevEnd);
            }
            const { ch, startTime, endTime } = timeline[i];
            const idx = i;
            if (bufferStart === null) bufferStart = startTime;
            buffer += ch;
            let currentEnd = endTime;
            i++;

            const isProtected = nonBreakIdx.has(idx);

            if (SENTENCE_END_CHARS.has(ch) && !isProtected) {
                while (i < timeline.length && TRAILING_CHARS.has(timeline[i].ch)) {
                    buffer += timeline[i].ch;
                    currentEnd = timeline[i].endTime;
                    i++;
                }
                flush(currentEnd);
                continue;
            }
            if (
                COMMA_CHARS.has(ch) &&
                !isProtected &&
                Array.from(buffer).length >= COMMA_BREAK_THRESHOLD
            ) {
                while (i < timeline.length && TRAILING_CHARS.has(timeline[i].ch)) {
                    buffer += timeline[i].ch;
                    currentEnd = timeline[i].endTime;
                    i++;
                }
                flush(currentEnd);
            }
        }
        if (buffer.trim()) {
            const lastEnd = timeline[timeline.length - 1]?.endTime ?? bufferStart;
            flush(lastEnd);
        }
        return sentences;
    }


    // end が欠落しているcueを補完（次cueのstart、または文字数から推定）
    function normalizeCueEnds(cues) {
        return cues.map((cue, i) => {
            const next = cues[i + 1];
            const durEnd = cue.end != null
            ? cue.end
            : cue.start + Math.max(500, cue.text.length * 150);

            // 次キューのstartを超えないようにクランプ
            if (next) {
                return { ...cue, end: Math.min(durEnd, next.start) };
            }
            return { ...cue, end: durEnd };
        });
    }

    // 各cueをその時間範囲内で文字ごとに按分し、
    // 「文字1つごとの開始/終了時刻」のフラットな列にする
    function buildCharTimeline(cues) {
        const timeline = [];

        for (const cue of cues) {
            const chars = Array.from(cue.text + " "); // サロゲートペア対応
            const len = chars.length;

            if (len === 0) continue;

            const duration = cue.end - cue.start;

            chars.forEach((ch, i) => {
                timeline.push({
                    ch,
                    startTime: cue.start + (duration * i) / len,
                    endTime: cue.start + (duration * (i + 1)) / len
                });
            });
        }

        return timeline;
    }


    // ============================================================
    // 3. YouTube標準字幕をOFF
    // ============================================================

    function nativeCaptionButton() {
        return document.querySelector(
            '.ytp-subtitles-button'
        );
    }

    function disableNativeSubtitles() {
        const button = nativeCaptionButton();

        if (!button) return;

        const enabled =
            button.getAttribute('aria-pressed') === 'true';

        if (enabled) {
            button.click();
            console.log(
                '[YT-CUSTOM] native subtitles OFF'
            );
        }
    }

    // ============================================================
    // 4. 独自字幕オーバーレイ
    // ============================================================

    function createOverlay() {
        if (overlay?.isConnected) {
            return overlay;
        }

        const player =
            document.querySelector('#movie_player');

        if (!player) {
            return null;
        }

        overlay =
            document.createElement('div');

        overlay.id =
            '__yt_custom_subtitle_overlay';

        Object.assign(overlay.style, {
            position: 'absolute',
            left: '5%',
            right: '5%',
            bottom: '9%',
            zIndex: '9999',
            pointerEvents: 'none',

            textAlign: 'center',

            fontFamily:
            'Arial, "Noto Sans JP", sans-serif',

            fontSize: '22px',
            fontWeight: '600',
            lineHeight: '1.4',

            color: '#fff',

            background: 'rgba(0, 0, 0, 0.65)',

            padding: '6px 14px',
            borderRadius: '4px',

            textShadow: '0 1px 2px rgba(0,0,0,.8)',

            whiteSpace: 'pre-wrap',

            boxSizing: 'border-box'
        });

        player.appendChild(overlay);

        return overlay;
    }

    function currentCueIndex(time) {
        let left = 0;
        let right = cues.length - 1;

        while (left <= right) {
            const mid = (left + right) >> 1;
            const cue = cues[mid];

            if (time < cue.start) {
                right = mid - 1;
                continue;
            }

            if (
                cue.end != null &&
                time >= cue.end
            ) {
                left = mid + 1;
                continue;
            }

            return mid;
        }

        return -1;
    }

    function renderBlock(cue, isDim) {
        if (!cue) return null;

        // 1段目(isDim=true)は少し小さめに
        const originalSize = isDim ? '22px' : '26px';
        const translatedSize = isDim ? '15px' : '18px';

        const block = document.createElement('div');
        block.style.opacity = isDim ? '0.55' : '1';

        const originalLine = document.createElement('div');
        Object.assign(originalLine.style, {
            fontSize: originalSize,
            opacity: '1',
            lineHeight: '1.3'
        });
        originalLine.textContent = cue.original;

        const translatedLine = document.createElement('div');
        Object.assign(translatedLine.style, {
            fontSize: translatedSize,
            opacity: '0.8',
            lineHeight: '1.3',
            marginTop: '2px'
        });
        translatedLine.textContent = cue.translated;

        block.appendChild(originalLine);
        block.appendChild(translatedLine);

        return block;
    }

    function render() {
        const SUBTITLE_OFFSET_MS = 0;
        const video = document.querySelector('#movie_player video');
        const box = createOverlay();

        if (!video || !box) {
            rafId = requestAnimationFrame(render);
            return;
        }

        const index = currentCueIndex(
            video.currentTime * 1000 - SUBTITLE_OFFSET_MS
        );

        // 既存の中身をクリア(innerHTML='' もTrusted Types対象なのでreplaceChildrenを使う)
        box.replaceChildren();

        if (index >= 0) {
            const previousCue = cues[index - 1];
            const currentCue = cues[index];

            const prevBlock = renderBlock(previousCue, true);
            const currBlock = renderBlock(currentCue, false);

            if (prevBlock) box.appendChild(prevBlock);
            if (currBlock) box.appendChild(currBlock);
        }

        rafId = requestAnimationFrame(render);
    }



    function startRendering() {
        cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(render);
    }


    // ============================================================
    // 7. 翻訳（Chrome Translator API）
    // ============================================================

    const TARGET_LANGUAGE = 'ja';

    // captionURLのlangパラメータから元言語を推定
    function guessSourceLanguageFromURL() {
        if (!captionURL) return null;

        try {
            const lang = new URL(captionURL).searchParams.get('lang');
            return lang || null;
        } catch {
            return null;
        }
    }

    // LanguageDetector APIでフォールバック推定
    async function detectSourceLanguage(sampleText) {
        if (!('LanguageDetector' in self)) return null;

        try {
            const availability = await self.LanguageDetector.availability();
            if (availability === 'unavailable') return null;

            const detector = await self.LanguageDetector.create();
            const results = await detector.detect(sampleText);
            return results?.[0]?.detectedLanguage || null;
        } catch {
            return null;
        }
    }

    async function resolveSourceLanguage(cues) {
        const fromURL = guessSourceLanguageFromURL();
        if (fromURL) return fromURL;

        const sample = cues.slice(0, 5).map(c => c.text).join(' ');
        const detected = await detectSourceLanguage(sample);
        if (detected) return detected;

        throw new Error('翻訳元言語を特定できませんでした。');
    }

    async function translateCues(cues, onProgress) {
        if (!('Translator' in self)) {
            throw new Error('このブラウザはTranslator APIに対応していません。');
        }

        const sourceLanguage = await resolveSourceLanguage(cues);

        if (sourceLanguage === TARGET_LANGUAGE) {
            // 翻訳不要でも original/translated の形は揃えておく
            return cues.map(cue => ({ ...cue, original: cue.text, translated: cue.text }));
        }

        const availability = await self.Translator.availability({
            sourceLanguage,
            targetLanguage: TARGET_LANGUAGE
        });

        if (availability === 'unavailable') {
            throw new Error(
                `翻訳ペア (${sourceLanguage} → ${TARGET_LANGUAGE}) は利用できません。`
            );
        }

        const translator = await self.Translator.create({
            sourceLanguage,
            targetLanguage: TARGET_LANGUAGE,
            monitor(m) {
                m.addEventListener('downloadprogress', (e) => {
                    const pct = Math.round((e.loaded / e.total) * 100) || 0;
                    onProgress?.(`モデルDL中... ${pct}%`);
                });
            }
        });

        if (translator.ready) {
            await translator.ready;
        }

        const translated = [];

        for (let i = 0; i < cues.length; i++) {
            const cue = cues[i];
            onProgress?.(`翻訳中... ${i + 1}/${cues.length}`);

            const result = await translator.translate(cue.text);
            const translatedText = typeof result === 'string' ? result : (result?.output ?? cue.text);

            translated.push({
                ...cue,
                original: cue.text,     // ← 原文を保持
                translated: translatedText
            });
        }

        translator.destroy?.();

        return translated;
    }


    // ============================================================
    // 8. 句読点の自動補完（AI + ヒューリスティック）
    // ============================================================

    const PUNCT_MARKER = '␟';
    const AI_CHUNK_SIZE = 30;          // 1リクエストあたりのcue数
    const PAUSE_THRESHOLD_MS = 600;    // これ以上の無音なら文末とみなす

    function hasPunctuation(cues) {
        const sample = cues.slice(0, 20).map(c => c.text).join('');
        return /[.!?,:;]/.test(sample);
    }

    // --- AI版 ---

    async function createPunctuationSession() {
        if (!('LanguageModel' in self)) {
            console.log("LanguageModel がない");
            return null;
        }

        try {
            const availability = await self.LanguageModel.availability();
            if (availability === 'unavailable') {
                console.log("LanguageModel.availabilityが unavalilable");
                return null;
            }

            return await self.LanguageModel.create({
                initialPrompts: [{
                    role: 'system',
                    content:
                    `あなたは字幕テキストに句読点を挿入するアシスタントです。` +
                    `入力は「${PUNCT_MARKER}」区切りの複数セグメントです。` +
                    `各セグメントの単語・語順・文字は一切変更・追加・削除せず、` +
                    `適切な位置に句読点(. , ! ? ; : )のみを挿入してください。日本語の句読点(、。)は一切使用してはいけません。` +
                    `セグメント数と区切り記号「${PUNCT_MARKER}」の数は入力と完全に一致させ、` +
                    `前置きや説明を付けず結果のテキストのみを出力してください。`
                }]
            });
        } catch {
            return null;
        }
    }

    async function punctuateChunkWithAI(baseSession, texts) {
        const input = texts.join(PUNCT_MARKER);
        const session = await baseSession.clone();

        try {
            const result = await session.prompt(input);
            const parts = result.split(PUNCT_MARKER).map(s => s.trim());

            if (parts.length !== texts.length) return null; // 数が合わない=失敗扱い
            return parts;
        } catch {
            return null;
        } finally {
            session.destroy?.();
        }
    }

    // --- ヒューリスティック版（フォールバック） ---

    function heuristicPunctuate(cues) {
        return cues.map((cue, i) => {
            const next = cues[i + 1];
            const gap = next ? next.start - (cue.end ?? cue.start) : Infinity;

            let mark = '';
            if (gap >= PAUSE_THRESHOLD_MS) {
                mark = '.';
            } else if (cue.text.length >= 8) {
                mark = ',';
            }

            return { ...cue, text: cue.text + mark };
        });
    }

    // --- 呼び出しエントリ ---

    async function ensurePunctuation(cues, onProgress) {
        if (hasPunctuation(cues)) {
            return cues; // 既に句読点があれば何もしない
        }

        const session = await createPunctuationSession();

        if (!session) {
            onProgress?.('句読点をヒューリスティック推定中...');
            return heuristicPunctuate(cues);
        }

        const result = cues.slice();

        for (let start = 0; start < cues.length; start += AI_CHUNK_SIZE) {
            const chunk = cues.slice(start, start + AI_CHUNK_SIZE);
            onProgress?.(`句読点推定中... ${start + chunk.length}/${cues.length}`);

            const punctuated = await punctuateChunkWithAI(
                session,
                chunk.map(c => c.text)
            );

            if (!punctuated) {
                heuristicPunctuate(chunk).forEach((c, i) => {
                    result[start + i] = c;
                });
                continue;
            }

            punctuated.forEach((text, i) => {
                result[start + i] = { ...chunk[i], text };
            });
        }

        session.destroy?.();
        return result;
    }


    // ============================================================
    // 9. バックグラウンド自動取得（原文cueの取得のみ）
    // ============================================================
    //
    // ここでは「重い処理」（句読点AI補完・翻訳）は一切行わない。
    // やることは、
    //   1. 手動英語字幕を選択（無ければCCボタンをトグル）してYouTube自身に
    //      字幕リクエストを発行させる
    //   2. そのリクエストURLを捕捉し、実データを取得してパースする
    // までで、結果は rawCues に格納するだけで表示等は一切行わない。

    function getVideoId() {
        try {
            const url = new URL(location.href);
            if (url.pathname.startsWith('/shorts/')) {
                return url.pathname.split('/')[2] || null;
            }
            return url.searchParams.get('v');
        } catch {
            return null;
        }
    }

    // 動画が切り替わった際に状態を初期化する
    function resetState() {
        generation++;

        cancelAnimationFrame(rafId);
        rafId = 0;

        captionURL = null;
        cues = [];
        rawCues = null;
        customSubtitlesOn = false;

        preparing = false;
        prepared = false;

        if (overlay?.isConnected) {
            overlay.replaceChildren();
        }

        const button = document.getElementById('__yt_custom_subtitle_button');
        if (button) {
            button.disabled = false;
        }
        setButtonStatus('字幕を翻訳');
        setButtonActive(false);
    }

    async function autoPrepareCaptions() {
        if (preparing || prepared) {
            dbg('autoPrepareCaptions: skip (preparing=%s prepared=%s)', preparing, prepared);
            return;
        }

        preparing = true;
        const myGeneration = generation;
        const startedAt = Date.now();
        dbg('autoPrepareCaptions: start', { generation: myGeneration, videoId: getVideoId() });

        try {
            captionURL = null;

            // 字幕ボタンをON/OFFするだけ（歯車メニューの自動操作はしない）
            const nativeButton = nativeCaptionButton();
            dbg('autoPrepareCaptions: nativeButton found?', !!nativeButton,
                'aria-pressed:', nativeButton?.getAttribute('aria-pressed'));

            if (nativeButton) {
                const enabled =
                    nativeButton.getAttribute('aria-pressed') === 'true';

                if (!enabled) {
                    nativeButton.click();
                    dbg('autoPrepareCaptions: native CC button clicked (OFF -> ON)');
                } else {
                    // 前の動画から字幕ON設定が引き継がれている場合、
                    // 新しいリクエストが飛ばないことがあるため一度OFF→ONし直して強制的に再リクエストさせる
                    dbg('autoPrepareCaptions: native CC already ON (前の動画の設定を引き継ぎ) -> OFF/ON再実行');
                    nativeButton.click();
                    await sleep(200);
                    if (myGeneration !== generation) return;
                    nativeButton.click();
                }
            } else {
                dbg('autoPrepareCaptions: 字幕ボタン自体が見つからない（この動画に字幕が無い可能性）');
            }

            // 実字幕リクエストを待つ（最大 40 * 300ms = 12秒）
            const MAX_ATTEMPTS = 40;
            for (let i = 0; i < MAX_ATTEMPTS && !captionURL; i++) {
                if (myGeneration !== generation) {
                    dbg('autoPrepareCaptions: 待機中に動画が切り替わったため中断', { myGeneration, generation });
                    return;
                }
                scanResources();
                if (i > 0 && i % 5 === 0) {
                    dbg(`autoPrepareCaptions: 待機中 ${i}/${MAX_ATTEMPTS} (経過 ${Date.now() - startedAt}ms) captionURL=`, captionURL);
                }
                await sleep(300);
            }

            if (myGeneration !== generation) return;

            if (!captionURL) {
                dumpDiagnostics('字幕リクエスト捕捉タイムアウト');
                throw new Error('YouTubeの字幕リクエストを捕捉できませんでした。');
            }

            console.log('[YT-CUSTOM] caption URL (background):', captionURL);

            const fetched = await fetchCaption();

            if (myGeneration !== generation) return;

            if (!fetched.length) {
                throw new Error('字幕が0件です。');
            }

            rawCues = fetched;
            prepared = true;

            console.log('[YT-CUSTOM] background fetch done:', rawCues.length, 'cues',
                        `(${Date.now() - startedAt}ms)`);
        } catch (error) {
            console.warn('[YT-CUSTOM] background prepare failed:', error?.message || error);
            // prepared は false のまま。ボタン押下時に再試行する。
        } finally {
            if (myGeneration === generation) {
                preparing = false;
            }
        }
    }

    // 動画IDの変化を監視し、切り替わったら状態リセット＋再取得
    function handleVideoChange() {
        const id = getVideoId();
        if (!id || id === currentVideoId) return;

        dbg('handleVideoChange:', currentVideoId, '->', id);
        currentVideoId = id;
        resetState();
        setTimeout(autoPrepareCaptions, 800);
    }

    document.addEventListener('yt-navigate-finish', handleVideoChange);


    // ============================================================
    // 5. ボタン
    // ============================================================

    // rawCues の準備ができるまで待つ（未着手なら開始もする）
    async function waitForPreparedCues(onProgress, timeoutMs = 25000) {
        if (prepared && rawCues) return rawCues;

        if (!preparing) {
            autoPrepareCaptions(); // 未着手 or 前回失敗していれば再試行
        }

        const start = Date.now();
        let pollCount = 0;

        while (!prepared || !rawCues) {
            if (Date.now() - start > timeoutMs) {
                dumpDiagnostics('waitForPreparedCues タイムアウト');
                throw new Error('字幕データの準備がタイムアウトしました。');
            }
            pollCount++;
            if (pollCount % 5 === 0) {
                dbg(`waitForPreparedCues: 待機中 (経過 ${Date.now() - start}ms) preparing=${preparing} prepared=${prepared}`);
            }
            onProgress?.('字幕データ準備中...');
            await sleep(300);
        }

        return rawCues;
    }

    const BUTTON_ID = '__yt_custom_subtitle_button';
    const ACTIVE_CLASS = 'yt-custom-subtitle-active';
    const LOADING_CLASS = 'yt-custom-subtitle-loading';

    // アイコン注入用のスタイルをDOM APIのみで挿入（innerHTML不使用）
    function ensureButtonStyle() {
        if (document.getElementById('__yt_custom_subtitle_style')) return;

        const style = document.createElement('style');
        style.id = '__yt_custom_subtitle_style';
        style.textContent = `
            #${BUTTON_ID} { position: relative; }
            #${BUTTON_ID} svg { transform-origin: 50% 50%; }
            #${BUTTON_ID} svg path { fill: rgba(255, 255, 255, .5); transition: fill .15s ease; }
            #${BUTTON_ID}.${ACTIVE_CLASS} svg path { fill: #ffffff; }
            #${BUTTON_ID}.${LOADING_CLASS} svg { animation: yt-custom-subtitle-spin 0.9s linear infinite; }
            @keyframes yt-custom-subtitle-spin {
                from { transform: rotate(0deg); }
                to { transform: rotate(360deg); }
            }
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    // テキストボタン時代の button.textContent = msg の代替（title tooltipに表示）
    function setButtonStatus(msg) {
        const button = document.getElementById(BUTTON_ID);
        if (button) button.title = msg;
    }

    function setButtonActive(active) {
        const button = document.getElementById(BUTTON_ID);
        if (!button) return;
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
        button.classList.toggle(ACTIVE_CLASS, active);
    }

    function setButtonLoading(isLoading) {
        const button = document.getElementById(BUTTON_ID);
        if (!button) return;
        button.classList.toggle(LOADING_CLASS, isLoading);
    }

    // SVGアイコンをDOM APIのみで組み立てる（innerHTML不使用）
    function buildIconSvg() {
        const svgNS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(svgNS, 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('width', '24');
        svg.setAttribute('height', '24');
        svg.style.pointerEvents = 'none';

        const path = document.createElementNS(svgNS, 'path');
        path.setAttribute(
            'd',
            'M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 12H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z'
        );

        svg.appendChild(path);
        return svg;
    }

    // 自前字幕を表示状態にする（cuesは準備済みである前提）
    function turnOnCustomSubtitles() {
        disableNativeSubtitles();
        const box = createOverlay();
        if (box) box.style.display = '';
        startRendering();

        customSubtitlesOn = true;
        setButtonActive(true);

        const lang = getCaptionLang();
        setButtonStatus(
            lang
                ? `字幕を翻訳（ON, ${cues.length}件）[${lang}]`
                : `字幕を翻訳（ON, ${cues.length}件）`
        );
    }

    // 自前字幕を非表示にする（取得済みのcuesは破棄しない＝再クリックで即ON可能）
    function turnOffCustomSubtitles() {
        cancelAnimationFrame(rafId);
        rafId = 0;

        if (overlay?.isConnected) {
            overlay.replaceChildren();
            overlay.style.display = 'none'; // 中身を消すだけだと padding/background が残って見えるため非表示にする
        }

        customSubtitlesOn = false;
        setButtonActive(false);
        setButtonStatus('字幕を翻訳（OFF）');
    }

    async function onTranslateButtonClick() {
        if (loading) return;

        // 既に翻訳済みのcuesがあればON/OFF切り替えのみ（再取得・再翻訳はしない）
        if (cues.length > 0) {
            if (customSubtitlesOn) {
                turnOffCustomSubtitles();
            } else {
                turnOnCustomSubtitles();
            }
            return;
        }

        const button = document.getElementById(BUTTON_ID);
        loading = true;
        setButtonLoading(true);
        if (button) button.disabled = true;

        const myGeneration = generation;

        try {
            // 1. バックグラウンド取得が終わっていなければ待つ（未着手なら開始）
            const base = await waitForPreparedCues((msg) => {
                setButtonStatus(msg);
            });

            if (myGeneration !== generation) return; // 待機中に動画が切り替わった

            // 2. ここから重い処理: 句読点補完 → 文分割 → 翻訳
            let processed = await ensurePunctuation(base, (msg) => {
                setButtonStatus(msg);
            });

            if (myGeneration !== generation) return;

            processed = segmentByPunctuation(processed);

            if (!processed.length) {
                throw new Error('字幕が0件です。');
            }

            processed = await translateCues(processed, (msg) => {
                setButtonStatus(msg);
            });

            if (myGeneration !== generation) return;

            cues = processed;

            console.log(
                '[YT-CUSTOM] loaded:',
                cues.length,
                'lang:', getCaptionLang()
            );

            // 3. 翻訳完了したらそのままONにする
            turnOnCustomSubtitles();

        } catch (error) {
            console.error(
                '[YT-CUSTOM]',
                error
            );

            alert(
                error?.message ||
                String(error)
            );

            setButtonStatus('字幕を翻訳');
            setButtonActive(false);

        } finally {
            loading = false;
            setButtonLoading(false);
            const btn = document.getElementById(BUTTON_ID);
            if (btn) btn.disabled = false;
        }
    }

    function buildButton() {
        const button = document.createElement('button');
        button.id = BUTTON_ID;
        button.classList.add('ytp-button');
        button.setAttribute('title', '字幕を翻訳');
        button.setAttribute('aria-label', '字幕を翻訳');
        button.setAttribute('aria-pressed', 'false');
        button.style.display = 'inline-flex';
        button.style.alignItems = 'center';
        button.style.justifyContent = 'center';

        button.appendChild(buildIconSvg());
        button.addEventListener('click', onTranslateButtonClick);
        return button;
    }

    function addButton() {
        if (document.getElementById(BUTTON_ID)) return; // 二重挿入防止

        const rightControls = document.querySelector('.ytp-right-controls');
        if (!rightControls) return;

        ensureButtonStyle();

        const button = buildButton();

        try {
            const ccButton = rightControls.querySelector('.ytp-subtitles-button');
            // querySelectorとinsertBeforeの間にYouTube側の再描画が挟まり、
            // ccButtonがrightControlsの子でなくなっているケースがあるため確認する
            if (ccButton && ccButton.parentNode === rightControls) {
                rightControls.insertBefore(button, ccButton);
            } else {
                rightControls.appendChild(button);
            }
        } catch (e) {
            if (!document.getElementById(BUTTON_ID)) {
                rightControls.appendChild(button);
            }
        }
    }

    // ============================================================
    // 6. YouTubeの字幕OFFを維持
    // ============================================================

    const nativeSubtitleObserver =
        new MutationObserver(() => {
            if (customSubtitlesOn) {
                disableNativeSubtitles();
            }
        });

    nativeSubtitleObserver.observe(
        document.documentElement,
        {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ['aria-pressed']
        }
    );

    // ============================================================
    // Init
    // ============================================================

    new MutationObserver(addButton)
        .observe(
            document.documentElement,
            {
                childList: true,
                subtree: true
            }
        );

    setTimeout(addButton, 1000);

    // 初回ロード時のバックグラウンド自動取得
    currentVideoId = getVideoId();
    setTimeout(autoPrepareCaptions, 1500);

})();
