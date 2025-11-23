// ==UserScript==
// @name         YouTube Not Interested Button
// @description  Click once to mark any YouTube video as "Not Interested" and remove your watch history.
// @match        https://www.youtube.com/
// @match        https://www.youtube.com/?*
// @match        https://www.youtube.com/watch*
// @match        https://www.youtube.com/feed/history
// @grant        GM_addStyle
// @run-at       document-idle
// @version      0.1
// @homepageURL  https://github.com/tommyktech/YouTubeNotInterestedButton
// ==/UserScript==
GM_addStyle(`
  div.yt-lockup-metadata-view-model__menu-button button.yt-spec-button-shape-next {
    width: 60px !important;
    height: 44px !important;
  }
  ytm-menu-renderer ytm-menu button c3-icon {
    width: 50px !important;
    height: 50px !important;
  }
  .additional-btn {
    position: absolute;
    font-size: 28px;
    padding: 2px;
    margin-right: 4px;
    border: none;
    background: transparent;
    height: 24px;
    width: 48px;
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 0.5;
  }

  .additional-btn span {
    //background: rgba(0,0,0,0.6);
    padding: 0px;
    height: 34px;
    width: 34px;
    font-size: 30;
    // border-radius: 4px;
    color: white;
  }

  .additional-btn svg {
    //background: rgba(0,0,0,0.6);
    padding: 0px;
    height: 28px;
    width: 28px;
    //border-radius: 4px;
    stroke: white;
    fill: white;
    stroke-width:0.5px;
  }

  .read-btn {
    right: 0px;
    bottom: 0px;
  //  top: 40px;
    z-index: 2000;
  }

  .not-interested-in-btn {
    right: 40px;
    bottom: 0px;
//    top: 70px;
    z-index: 2000;
  }

  .delete-history-btn {
    right: 0px;
    top: 40px;
    z-index:2000;
    width: 30px;
  }

`);

(function () {
    'use strict';

    var TILE_SELECTOR = 'yt-lockup-view-model';
    var MENU_BUTTON_SELECTOR = 'div.yt-lockup-metadata-view-model__menu-button button-view-model button';
    var MENU_SELECTOR = 'ytd-popup-container tp-yt-iron-dropdown';
    const PROCESSED_ATTR = 'data-yt-menu-opener-added';

    // Show overlay notice on top of screen
    function showOverlay(msg, duration = 3000, backgroundColor="white") {
        let el = document.createElement("div");
        el.textContent = msg;
        Object.assign(el.style, {
            position: "fixed",
            top: "0",
            left: "0",
            width: "100%",
            padding: "10px 16px",
            backgroundColor: backgroundColor,
            opacity: 0.5,
            color: "black",
            fontSize: "24px",
            zIndex: "99999",
            textAlign: "center"
        });
        document.body.appendChild(el);
        console.log("Displayed message:", msg);

        setTimeout(() => el.remove(), duration);
    }

    // Wait for selected element to appear
    function waitForElement(selector, rootElem = null, intervalMs = 100, timeoutMs = 2000) {
        return new Promise((resolve, reject) => {
            const start = Date.now();

            const timer = setInterval(() => {
                const elem = (rootElem || document).querySelector(selector);
                if (elem && elem.style.display != "none") {
                    clearInterval(timer);
                    resolve(elem);
                    return;
                }

                if (Date.now() - start > timeoutMs) {
                    clearInterval(timer);
                    reject(new Error("Timeout: Can't find the element:" + selector));
                }
            }, intervalMs);
        });
    }

    // dispatch tap action
    function dispatchTapLike(target) {
        if (!target) return false;
        try {target.focus({preventScroll:true}); } catch(e){}

        /*
        // 1) dispatch 'tap' which libraries like Polymer listen
        try {
            target.dispatchEvent(new CustomEvent('tap', { bubbles: true, cancelable: true, composed: true }));
            console.log('dispatched CustomEvent tap');
        } catch(e) { console.warn('tap custom event failed', e); }

        // 2) dispatch a series of pointer / mouse actions（including pointerType:'touch'）
        try {
            const r = target.getBoundingClientRect();
            const cx = Math.round(r.left + r.width/2);
            const cy = Math.round(r.top + r.height/2);
            const pOpts = {
                bubbles: true, cancelable: true, composed: true,
                clientX: cx, clientY: cy, screenX: cx, screenY: cy,
                pointerId: Date.now() & 0xFFFF, pointerType: 'touch', isPrimary: true, pressure: 0.5, buttons: 1
            };
            target.dispatchEvent(new PointerEvent('pointerdown', pOpts));
            target.dispatchEvent(new PointerEvent('pointerup', pOpts));
            target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: cx, clientY: cy, buttons: 1 }));
            target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: cx, clientY: cy, buttons: 1 }));
            target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: cx, clientY: cy, buttons: 1 }));
            console.log('dispatched pointer/mouse sequence');
        } catch(e) {
            console.warn('pointer/mouse sequence failed', e);
        }
        */

        // 3) Dispatch touchstart/touchend if possible（depends on browsers）
        try {
            const r = target.getBoundingClientRect();
            const cx = Math.round(r.left + r.width/2);
            const cy = Math.round(r.top + r.height/2);
            const touch = new Touch({ identifier: Date.now(), target: target, clientX: cx, clientY: cy, screenX: cx, screenY: cy, pageX: cx, pageY: cy });
            const teStart = new TouchEvent('touchstart', { bubbles: true, cancelable: true, composed: true, touches: [touch], targetTouches: [touch], changedTouches: [touch] });
            const teEnd   = new TouchEvent('touchend',   { bubbles: true, cancelable: true, composed: true, touches: [], targetTouches: [], changedTouches: [touch] });
            target.dispatchEvent(teStart);
            target.dispatchEvent(teEnd);
            console.debug('dispatched touchstart/touchend');
        } catch(e) {
            console.warn('TouchEvent creation failed or not allowed', e);
        }

        // 4) finally dispatch DOM click()
        try {
            target.click();
            console.debug('called element.click()');
        } catch(e) {
            console.warn('element.click() threw', e);
            return false;
        }
        return true;
    }

    // attach 'Not Interested' button
    function attachNotInterestedInButton(tile) {
        const tileClassList = tile.classList

        // selector for original 'Not Interested'
        var svgPathData = "M12 1C5.925 1 1 5.925 1 12s4.925 11 11 11 11-4.925 11-11S18.075 1 12 1Zm0 2a9 9 0 018.246 12.605L4.755 6.661A8.99 8.99 0 0112 3ZM3.754 8.393l15.491 8.944A9 9 0 013.754 8.393Z";
        var SVG_SELECTOR = `path[d="${svgPathData}"]`

        // attach a custom 'Not Interested' button
        const notInterestedBtn = document.createElement('button');
        notInterestedBtn.className = 'additional-btn not-interested-in-btn';

        // create an SVG for the button
        const SVG_NS = "http://www.w3.org/2000/svg";
        const svg = document.createElementNS(SVG_NS, "svg");
        const path = document.createElementNS(SVG_NS, "path");
        path.setAttribute("d", "M12 1C5.925 1 1 5.925 1 12s4.925 11 11 11 11-4.925 11-11S18.075 1 12 1Zm0 2a9 9 0 018.246 12.605L4.755 6.661A8.99 8.99 0 0112 3ZM3.754 8.393l15.491 8.944A9 9 0 013.754 8.393Z");
        svg.appendChild(path);
        notInterestedBtn.appendChild(svg);
        if (tileClassList.contains("ytd-rich-item-renderer")) {
            // top page
            tile.parentElement.appendChild(notInterestedBtn);
        } else if (tileClassList.contains("ytd-item-section-renderer")) {
            // watch page
            tile.appendChild(notInterestedBtn);
        }

        // add eventlistener
        function onNotInterestedInButtonClick(ev) {
            ev.preventDefault();
            ev.stopPropagation();
            const menuBtn = tile.querySelector(MENU_BUTTON_SELECTOR);
            if (!menuBtn) {
                console.warn('menu button not found');
                return;
            }

            // Dispatch tap action to the menu button
            dispatchTapLike(menuBtn)

            // Check if the menu appeared
            waitForElement(MENU_SELECTOR).then(dropdown_el => {
                console.debug("dropdown_el:", dropdown_el)
                // Check if the target element appeared
                waitForElement(SVG_SELECTOR, dropdown_el).then(svg_el => {
                    console.debug("svg_el:", svg_el)
                    const result = dispatchTapLike(svg_el.parentElement.parentElement)
                    if (result) {
                        showOverlay('Sent "Not Interested In"');
                    }
                });
            });
        };
        notInterestedBtn.addEventListener('click', function(ev) {
            onNotInterestedInButtonClick(ev);
        });
    }

    // attach 'Already Watched' button
    function attachWatchedButton(tile) {
        const tileClassList = tile.classList

        // selector for original 'Not Interested' button
        var svgPathData = "M12 1C5.925 1 1 5.925 1 12s4.925 11 11 11 11-4.925 11-11S18.075 1 12 1Zm0 2a9 9 0 018.246 12.605L4.755 6.661A8.99 8.99 0 0112 3ZM3.754 8.393l15.491 8.944A9 9 0 013.754 8.393Z";
        var SVG_SELECTOR = `path[d="${svgPathData}"]`

        // attach a custom 'Already Watched' button
        const readBtn = document.createElement('button');
        readBtn.className = 'additional-btn read-btn';

        // create an SVG for the button
        const SVG_NS = "http://www.w3.org/2000/svg";
        const hide_svg = document.createElementNS(SVG_NS, "svg");
        const hide_path1 = document.createElementNS(SVG_NS, "path");
        hide_path1.setAttribute("d", "m6.666 5.303 2.122 1.272c4.486-1.548 10.002.26 12.08 5.426-.2.5-.435.968-.696 1.406l1.717 1.03c.41-.69.752-1.42 1.02-2.178a.77.77 0 000-.516l-.18-.473C19.998 4.436 12.294 2.448 6.667 5.303Zm-5.524.183a1.003 1.003 0 00.343 1.371l1.8 1.08a11.8 11.8 0 00-2.193 3.805.77.77 0 000 .516c2.853 8.041 12.37 9.784 18.12 5.235l2.273 1.364a1 1 0 101.03-1.714l-20-12a1 1 0 00-1.373.343Zm11.064 2.52L12 8c-.248 0-.49.022-.727.066l4.54 2.724a4 4 0 00-3.607-2.785ZM5.04 8.99l3.124 1.874C8.057 11.224 8 11.606 8 12l.005.206a4 4 0 003.79 3.79L12 16c1.05 0 2.057-.414 2.803-1.152l2.54 1.524C12.655 19.48 5.556 18.024 3.133 12A9.6 9.6 0 015.04 8.99ZM10 12v-.033l2.967 1.78a1.99 1.99 0 01-2.307-.262 2 2 0 01-.65-1.28L10 12Z");
        hide_svg.appendChild(hide_path1)
        readBtn.appendChild(hide_svg);
        if (tileClassList.contains("ytd-rich-item-renderer")) {
            // top page
            tile.parentElement.appendChild(readBtn);
        } else if (tileClassList.contains("ytd-item-section-renderer")) {
            // watch page
            tile.appendChild(readBtn);
        }

        // add eventlistener for the button
        function onReadButtonClick(ev) {
            ev.preventDefault();
            ev.stopPropagation();
            const menuBtn = tile.querySelector(MENU_BUTTON_SELECTOR);
            if (!menuBtn) {
                console.warn('menu button not found');
                return;
            }

            // Dispatch a tap to the menu button
            dispatchTapLike(menuBtn);

            // Repeat waiting for the element and tapping it
            (async () => {
                try {
                    // Wait for the menu to appear
                    const dropdown_el = await waitForElement(MENU_SELECTOR);
                    console.debug("dropdown_el:", dropdown_el);

                    console.debug("Wait for the 'Not Interested' item");
                    const svg_el = await waitForElement(SVG_SELECTOR, dropdown_el);
                    console.debug("The 'Not Interested' item has been found, so tap it.:", svg_el);
                    dispatchTapLike(svg_el.parentElement.parentElement);

                    console.debug("Wait for 'Tell us why' button to appear");
                    const TELL_ME_REASON_BUTTON = "div.ytNotificationMultiActionRendererButtonContainer div:nth-child(2) button-view-model button";
                    const send_reason_button = await waitForElement(TELL_ME_REASON_BUTTON, tile);

                    console.debug("Found the 'Tell us why' button. Then push it:", TELL_ME_REASON_BUTTON);
                    await new Promise(res => setTimeout(res, 200));

                    const sendReasonButtonResult = dispatchTapLike(send_reason_button);
                    if (!sendReasonButtonResult) {
                        console.warn("Can't push 'Tell us why' button");
                        return
                    }

                    console.debug("Wait for the checkbox to appear");
                    const REASON_DIALOG_SELECTOR = "tp-yt-paper-dialog";
                    const dialog_el = await waitForElement(REASON_DIALOG_SELECTOR);

                    const CHECKBOX_SELECTOR = "ytd-dismissal-follow-up-renderer div#content div#reasons ytd-dismissal-reason-text-renderer:nth-child(1) tp-yt-paper-checkbox:nth-child(1)";
                    const checkbox_el = await waitForElement(CHECKBOX_SELECTOR, dialog_el);
                    console.debug("click the checkbox:", checkbox_el);
                    dispatchTapLike(checkbox_el);

                    console.debug("Push the submit button");
                    const SUBMIT_BUTTON_SELECTOR = "ytd-dismissal-follow-up-renderer div#buttons ytd-button-renderer#submit"
                    const submit_button = await waitForElement(SUBMIT_BUTTON_SELECTOR, dialog_el);
                    const result = dispatchTapLike(submit_button);
                    showOverlay(result? 'Sent "Already Watched"':'Failed to send "Already Watched"');
                } catch (err) {
                    console.error("Error:", err);
                }
            })();
        }
        readBtn.addEventListener('click', function(ev) {
            onReadButtonClick(ev);
        });
    }

    // attach delete history button
    function attachDeleteHistoryButton(tile) {
        const tileClassList = tile.classList

        // Selector for 'Remove from watch history' icon
        var svgPathData = "M19 3h-4V2a1 1 0 00-1-1h-4a1 1 0 00-1 1v1H5a2 2 0 00-2 2h18a2 2 0 00-2-2ZM6 19V7H4v12a4 4 0 004 4h8a4 4 0 004-4V7h-2v12a2 2 0 01-2 2H8a2 2 0 01-2-2Zm4-11a1 1 0 00-1 1v8a1 1 0 102 0V9a1 1 0 00-1-1Zm4 0a1 1 0 00-1 1v8a1 1 0 002 0V9a1 1 0 00-1-1Z";
        var SVG_SELECTOR = `path[d="${svgPathData}"]`

        // add a custom 'Remove history' button
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'additional-btn delete-history-btn';
        const SVG_NS = "http://www.w3.org/2000/svg";
        const svg = document.createElementNS(SVG_NS, "svg");
        const path = document.createElementNS(SVG_NS, "path");
        path.setAttribute("d", "M12 1C5.925 1 1 5.925 1 12s4.925 11 11 11 11-4.925 11-11S18.075 1 12 1Zm0 2a9 9 0 018.246 12.605L4.755 6.661A8.99 8.99 0 0112 3ZM3.754 8.393l15.491 8.944A9 9 0 013.754 8.393Z");
        svg.appendChild(path);
        deleteBtn.appendChild(svg);
        if (tileClassList.contains("ytd-rich-item-renderer")) {
            // top page
            tile.parentElement.appendChild(deleteBtn);
        } else if (tileClassList.contains("ytd-item-section-renderer")) {
            // watch page
            tile.appendChild(deleteBtn);
        }

        // add event listener
        function onDeleteButtonClick(ev) {
            ev.preventDefault();
            ev.stopPropagation();
            const menuBtn = tile.querySelector(MENU_BUTTON_SELECTOR);
            if (!menuBtn) {
                console.warn('menu button not found');
                return;
            }

            // wait for menu to appear
            dispatchTapLike(menuBtn);

            // check if the menu is displayed
            waitForElement(MENU_SELECTOR).then(dropdown_el => {
                console.debug("dropdown_el:", dropdown_el)
                // Check if the target element has appeared
                waitForElement(SVG_SELECTOR, dropdown_el).then(svg_el => {
                    console.debug("svg_el:", svg_el)
                    const result = dispatchTapLike(svg_el.parentElement.parentElement)
                    if (result) {
                        showOverlay('Sent "Delete History"');
                    }
                });
            });
        };
        deleteBtn.addEventListener('click', function(ev) {
            onDeleteButtonClick(ev);
        });
    }

    // Attach custom buttons
    function attachButtons(tile, idx) {
        const tileRect = tile.getBoundingClientRect();

        if (!tile || tile.hasAttribute(PROCESSED_ATTR)) return;
        tile.setAttribute(PROCESSED_ATTR, '1');
        tile.style.position = 'relative';

        const url = location.href;
        const pathName = location.pathname;

        if (pathName == "/" || pathName == "/watch") {
            attachNotInterestedInButton(tile);
            attachWatchedButton(tile);
        } else if (pathName == "/feed/history") {
            attachDeleteHistoryButton(tile);
        }
    }

    function scanTiles() {
        document.querySelectorAll(TILE_SELECTOR).forEach((tile, idx) => attachButtons(tile, idx));
    }
    new MutationObserver(scanTiles).observe(document.body, { childList: true, subtree: true });

})();
