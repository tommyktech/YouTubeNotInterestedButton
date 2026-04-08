// ==UserScript==
// @name         YouTube Remove Low-View Videos
// @match        https://www.youtube.com/
// @match        https://www.youtube.com/?*
// @match        https://www.youtube.com/watch*
// @grant        GM_addStyle
// @run-at       document-idle
// @version      0.12
// ==/UserScript==
GM_addStyle(`
div.yt-lockup-metadata-view-model__menu-button button.yt-spec-button-shape-next, div.ytLockupMetadataViewModelMenuButton button.yt-spec-button-shape-next  {
    width: 60px !important;
    height: 44px !important;
}
ytd-watch-next-secondary-results-renderer > div#items {
   height: 100vh;
   overflow-y: scroll;
   overflow-x: hidden;
   scrollbar-width: none;
   width: calc(100% + 17px);
   padding-right: 17px;
   box-sizing: border-box;
}
ytd-watch-next-secondary-results-renderer > div#items::-webkit-scrollbar {
  display: none;
}
`);
(function () {
    'use strict';
    console.log("YouTube Remove Low-View Videos Init")

    var TILE_SELECTOR = 'yt-lockup-view-model';
    var LIVE_SELECTOR = 'yt-thumbnail-view-model yt-thumbnail-overlay-badge-view-model badge-shape.yt-badge-shape--thumbnail-live';
    var MEMBER_ONLY_SELECTOR = 'div.yt-lockup-view-model__metadata yt-content-metadata-view-model div.yt-content-metadata-view-model__metadata-row, div.yt-lockup-view-model__metadata yt-content-metadata-view-model div.ytContentMetadataViewModelMetadataRow';
    var N_VIEWERS_SELECTOR = 'div.yt-lockup-view-model__metadata yt-content-metadata-view-model div.yt-content-metadata-view-model__metadata-row:nth-child(2) span, div.yt-lockup-view-model__metadata yt-content-metadata-view-model div.ytContentMetadataViewModelMetadataRow:nth-child(2) span';
    const PROCESSED_ATTR = 'data-yt-low-view-processed';

    // 要素を隠す
    function removeVideo(video_elem) {
        video_elem.style.display = "none";
        if (video_elem.classList.contains("ytd-rich-item-renderer") &&
            video_elem.parentElement.parentElement.tagName.toLowerCase() == "ytd-rich-item-renderer") {
            // topページの場合は親要素ごと非表示にする
            video_elem.parentElement.parentElement.style.display = "none";
        }
    }
    function extractNumberAndDot(str) {
        return str.replace(/[^0-9.万億kmKM]/g, '');
    }
    function removeLowViewVideos(tile, idx) {
        if (tile.hasAttribute(PROCESSED_ATTR)) {
            return;
        }
        tile.setAttribute(PROCESSED_ATTR, '1');

        // live は処理しない
        const live_badge = tile.querySelector(LIVE_SELECTOR);
        if (live_badge) {
            console.log("Skipped processing with live stream:", tile.textContent)
            return ;
        }

        // まずメン限を消す
        const rowElems = tile.querySelectorAll(MEMBER_ONLY_SELECTOR);
        if (rowElems.length >= 3 && rowElems[2].children.length >= 2) {
            // メン限など、YouTubeからの余計なおすすめが入ってきてる要素なので消す
            removeVideo(tile)
            console.info("Removed Recommended Video By YouTube:", tile.textContent)
            return;
        }

        // 視聴者数が少ない動画を消す
        const nViewersElem = tile.querySelector(N_VIEWERS_SELECTOR);
        if (!nViewersElem) {
            console.error("視聴者数が取れない tile.textContent:", tile.textContent);
            return ;
        }
        // const nViewers = nViewersElem.textContent.split(" ")[0];
        const nViewers = extractNumberAndDot(nViewersElem.textContent)

        // 万とかK, M などの単位が入っている場合は十分視聴数があるので何もしない
        if (/[.万億KMkm]/.test(nViewers)) return;

        if (parseInt(nViewers) < 3000) {
            removeVideo(tile)
            console.log("Removed Video with Low-view (under 3000):", tile.textContent)
        }
    }

    function scanTiles() {
        var checkElem = document.querySelector("div#contents yt-lockup-view-model yt-lockup-metadata-view-model yt-content-metadata-view-model div.yt-content-metadata-view-model__metadata-row:nth-child(2)  span.yt-core-attributed-string, div#contents yt-lockup-view-model yt-lockup-metadata-view-model yt-content-metadata-view-model div.ytContentMetadataViewModelMetadataRow:nth-child(2)  span.yt-core-attributed-string")
        if (!checkElem) return ;
        const elems = document.querySelectorAll(TILE_SELECTOR);
        elems.forEach((tile, idx) => removeLowViewVideos(tile, idx));
    }
    new MutationObserver(scanTiles).observe(document.body, { childList: true, subtree: true });


})();
