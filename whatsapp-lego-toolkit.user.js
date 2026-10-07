// ==UserScript==
// @name         WhatsApp Lego Toolkit
// @namespace    https://node-builder.local/
// @version      1.0.0
// @description  Compiled by Node Builder -- 22 block(s): Sidebar Plugin Manager, Dual Sidebar UI Shell, Menu Collapse Module, Menu Panel Switcher, Menu Card Reorder Module, Menu Card Pop-out Module, Header Toolbar Organizer, WhatsApp Layout Resizer, Sidebar-to-Resizer Sync, Text Library Height Fix, Reset Menus, Quick Chat Box, Shared Tree Styles, Saved Messages (Text Library), Saved Images (Image Library), Message Sequence Builder, Quick Commands, Google Sheets Sync, Highlighter, Text resizer, Contact Badge Renderer, Video Sender
// @author       You
// @match        https://web.whatsapp.com/*
// @grant        GM_xmlhttpRequest
// @connect      docs.google.com
// @connect      bunnycdn.com
// @connect      generativelanguage.googleapis.com
// @require      https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

/* ============================================================
   CORE ENGINE
   ============================================================ */
const LegoCore = (function () {
    let db;

    const DB_NAME = 'WA_Toolkit_Core_DB';
    const DB_VERSION = 1;

    const listeners = {};
    function on(event, fn) { (listeners[event] = listeners[event] || []).push(fn); }
    function emit(event, payload) {
        (listeners[event] || []).forEach(fn => {
            try { fn(payload); } catch (e) { console.error('[LegoCore] listener error:', e); }
        });
    }

    // 1. Initialize IndexedDB Database (saved text snippets + saved images)
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = e => console.error("WA Toolkit DB Error:", e);
    request.onupgradeneeded = e => {
        db = e.target.result;
        if (!db.objectStoreNames.contains('images')) {
            const imgStore = db.createObjectStore('images', { keyPath: 'id' });
            imgStore.createIndex('order', 'order', { unique: false });
        }
    };
    request.onsuccess = e => {
        db = e.target.result;
        db.onversionchange = () => { db.close(); window.location.reload(); };
        emit('db:ready', db);
    };

    // 2. SELECTOR: WhatsApp's main conversation panel -- used as the drop
    //    zone for images and as the anchor for "is a chat open" checks.
    function getMainPanel() {
        return document.querySelector('#main') || document.querySelector('[data-testid="conversation-panel-wrapper"]');
    }

    // 3. SELECTOR: the actual text compose box (contenteditable) in the
    //    chat footer. WhatsApp uses a contenteditable div here just like
    //    Instagram did, so the same execCommand('insertText') trick works.
    function getComposeBox() {
        const main = getMainPanel();
        if (!main) return null;
        const footer = main.querySelector('footer') || main;
        return footer.querySelector('div[contenteditable="true"][data-tab]')
            || footer.querySelector('div[contenteditable="true"]');
    }

    // 4. SELECTOR: a generic "Send" control -- used both for the main
    //    compose box and inside the image caption/preview modal.
    function findSendButton(scopeEl) {
        const scope = scopeEl || document;
        return scope.querySelector('button[aria-label="Send"]')
            || scope.querySelector('[data-icon="send"]')
            || scope.querySelector('[data-testid="send"]')
            || scope.querySelector('span[data-icon="wds-ic-send-filled"]');
    }

    function requireChatOpen() {
        if (!getMainPanel() || !getComposeBox()) {
            notifyError("Open an active WhatsApp chat first.");
            return false;
        }
        return true;
    }

    // ---- Visible failure notice ----
    // Errors used to only go to console.error, which meant a failure looked
    // like "nothing happened" with zero feedback. This shows a small
    // dismissible toast in the corner AND still logs to console for
    // debugging.
    function notifyError(message) {
        console.error('[LegoCore]', message);
        try {
            let toast = document.getElementById('wa-toolkit-error-toast');
            if (!toast) {
                toast = document.createElement('div');
                toast.id = 'wa-toolkit-error-toast';
                toast.style.cssText = 'position:fixed; bottom:50px; left:12px; z-index:2147483647; max-width:320px; background:#7f1d1d; color:#fff; border:1px solid #dc2626; border-radius:8px; padding:10px 12px; font-size:11px; font-family:-apple-system,sans-serif; box-shadow:0 6px 20px rgba(0,0,0,0.5); line-height:1.4;';
                document.body.appendChild(toast);
            }
            toast.textContent = '⚠️ ' + message;
            toast.style.display = 'block';
            clearTimeout(toast._hideTimer);
            toast._hideTimer = setTimeout(() => { toast.style.display = 'none'; }, 6000);
        } catch (e) { /* DOM not ready yet -- console.error above still fired */ }
    }

    // ---- Text-only send/paste ----
    function injectTextToChat(text, autoSend) {
        if (!requireChatOpen()) return;
        const box = getComposeBox();
        box.focus();
        document.execCommand('insertText', false, text);
        box.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
        if (autoSend) {
            setTimeout(() => {
                const sendBtn = findSendButton(box.closest('footer') || document);
                if (sendBtn) { sendBtn.click(); return; }
                const enterEvent = new KeyboardEvent('keydown', {
                    key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true
                });
                box.dispatchEvent(enterEvent);
            }, 150);
        }
    }

    // ---- Image preview + manual copy (replaces all programmatic attach) ----
    // Every attempt to programmatically attach an image (drag-drop, paste
    // simulation, file-input) risked triggering WhatsApp's own upload/
    // sticker/preview pipelines more than once per click, which is what
    // was driving RAM usage into the gigabytes and hanging the tab.
    // This is deliberately simple and safe instead: show the image (and
    // its caption text, if any) in a small modal, let the browser's own
    // clipboard API copy the image to the system clipboard on request, and
    // let the person paste it into WhatsApp themselves with Ctrl+V -- the
    // exact same action as doing it manually, so it can't misfire into the
    // wrong WhatsApp pipeline. Converts to PNG first for clipboard writes,
    // since browser clipboard image support is most reliable for PNG.
    // Resolves once the person closes the modal (used by the Sequence
    // Runner to pause between steps until each image has been handled).
    function toPngBlob(blob) {
        return new Promise((resolve, reject) => {
            const url = URL.createObjectURL(blob);
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width = img.naturalWidth;
                canvas.height = img.naturalHeight;
                canvas.getContext('2d').drawImage(img, 0, 0);
                canvas.toBlob((pngBlob) => {
                    URL.revokeObjectURL(url);
                    if (pngBlob) resolve(pngBlob); else reject(new Error('PNG conversion failed'));
                }, 'image/png');
            };
            img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not load the image for copying')); };
            img.src = url;
        });
    }

    function showImagePreview(blob, caption, filename) {
        return new Promise((resolve) => {
            const objectUrl = URL.createObjectURL(blob);
            const overlay = document.createElement('div');
            overlay.className = 'wa-tlp-modal-overlay';
            overlay.innerHTML = `
              <div class="wa-tlp-modal" style="align-items:center; text-align:center; width:360px;">
                <h3 style="word-break:break-all;">🖼️ ${filename || 'Image'}</h3>
                <img src="${objectUrl}" style="max-width:100%; max-height:45vh; border-radius:8px; align-self:center;">
                ${caption ? `<textarea readonly class="wa-tlp-input" style="min-height:60px; align-self:stretch;">${caption}</textarea>` : ''}
                <div style="font-size:10.5px; color:#94a3b8;">Copy the image (button below, or right-click it), then paste with Ctrl+V into WhatsApp.</div>
                <div class="wa-tlp-row" style="align-self:stretch;">
                  <button id="wa-img-preview-copy" class="wa-base-btn">📋 Copy Image</button>
                  ${caption ? '<button id="wa-img-preview-copy-text" class="wa-hide-btn" style="flex:1;">📋 Copy Text</button>' : ''}
                </div>
                <button id="wa-img-preview-close" class="wa-hide-btn" style="align-self:stretch;">Close</button>
              </div>
            `;
            document.body.appendChild(overlay);

            const copyBtn = overlay.querySelector('#wa-img-preview-copy');
            copyBtn.onclick = async () => {
                try {
                    const pngBlob = await toPngBlob(blob);
                    await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
                    copyBtn.textContent = '✅ Copied!';
                    setTimeout(() => { copyBtn.textContent = '📋 Copy Image'; }, 1500);
                } catch (e) {
                    notifyError('Could not copy automatically -- right-click the image above and choose "Copy Image" instead.');
                }
            };

            const copyTextBtn = overlay.querySelector('#wa-img-preview-copy-text');
            if (copyTextBtn) {
                copyTextBtn.onclick = async () => {
                    try {
                        await navigator.clipboard.writeText(caption);
                        copyTextBtn.textContent = '✅ Copied!';
                        setTimeout(() => { copyTextBtn.textContent = '📋 Copy Text'; }, 1500);
                    } catch (e) {
                        notifyError('Could not copy text automatically -- select it manually in the box above.');
                    }
                };
            }

            function close() {
                URL.revokeObjectURL(objectUrl);
                overlay.remove();
                resolve();
            }
            overlay.querySelector('#wa-img-preview-close').onclick = close;
            overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
        });
    }

    function wait(ms) { return new Promise(res => setTimeout(res, ms)); }

    // 6. Window Draggable Helper (shared by popout modals / floating panels)
    function makeDraggable(panelElement, headerElement, storageKey) {
        let isDragging = false;
        let startX, startY, initialLeft, initialTop;

        headerElement.onmousedown = e => {
            if (e.button !== 0) return;
            isDragging = true;
            headerElement.style.cursor = "grabbing";
            startX = e.clientX;
            startY = e.clientY;
            const rect = panelElement.getBoundingClientRect();
            initialLeft = rect.left;
            initialTop = rect.top;
            panelElement.style.bottom = "auto";
            panelElement.style.right = "auto";
            panelElement.style.left = `${initialLeft}px`;
            panelElement.style.top = `${initialTop}px`;

            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
            e.preventDefault();
        };

        function onMouseMove(e) {
            if (!isDragging) return;
            panelElement.style.left = `${initialLeft + (e.clientX - startX)}px`;
            panelElement.style.top = `${initialTop + (e.clientY - startY)}px`;
        }

        function onMouseUp() {
            if (!isDragging) return;
            isDragging = false;
            headerElement.style.cursor = "grab";
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            const rect = panelElement.getBoundingClientRect();
            if (storageKey) localStorage.setItem(storageKey, JSON.stringify({ bottom: 'auto', left: `${rect.left}px`, top: `${rect.top}px` }));
        }
    }

    // Block Registry
    const registeredBlocks = [];
    function registerBlock(block) { registeredBlocks.push(block); }
    function boot() {
        registeredBlocks.forEach(b => {
            try { b.init(api); } catch (e) { console.error('[LegoCore] Block init error:', b.id, e); }
        });
    }

    const api = {
        on, emit, registerBlock,
        getDb: () => db,
        getMainPanel, getComposeBox, findSendButton, notifyError,
        injectTextToChat, showImagePreview,
        wait,
        makeDraggable,
        boot
    };

    return api;
})();

/* ============================================================
   BLOCK: Sidebar Plugin Manager (v1)
   ============================================================ */
LegoCore.registerBlock({
  id: 'sidebarPluginManager',
  init(core) {
    function slugify(str) {
      return String(str).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'menu';
    }

    core.registerMenu = function (targetSide, title, contentElement, iconHTML = '⠿', menuKey = null) {
      const containerId = targetSide === 'right' ? 'wa-right-menu-container' : 'wa-left-menu-container';
      const key = menuKey || ('plugin-' + slugify(title));

      function mount(attemptsLeft) {
        const container = document.getElementById(containerId);
        if (!container) {
          if (attemptsLeft <= 0) {
            console.warn('[SidebarPluginManager] Could not find "' + containerId + '" -- the UI shell may not be loaded. Menu "' + title + '" was not mounted.');
            return;
          }
          setTimeout(() => mount(attemptsLeft - 1), 200);
          return;
        }
        const existing = container.querySelector('[data-key="' + key + '"]');
        if (existing) existing.remove();

        const card = document.createElement('div');
        card.className = 'wa-draggable-menu';
        card.dataset.key = key;
        card.innerHTML = `
          <div class="wa-menu-header">
            <span>${title}</span>
            <span class="wa-drag-handle">${iconHTML}</span>
          </div>
          <div class="wa-menu-content"></div>
        `;
        card.querySelector('.wa-menu-content').appendChild(contentElement);
        container.appendChild(card);
      }
      mount(10);
    };

    console.log('[SidebarPluginManager] Registry initialized.');
    core.emit('block:ready', { id: 'sidebarPluginManager' });
  }
});

/* ============================================================
   BLOCK: Dual Sidebar UI Shell (v1)
   ============================================================ */
LegoCore.registerBlock({
  id: 'waDualSidebarUI',
  init(core) {
    const PREF_KEY = 'wa_dual_sidebar_prefs_v1';
    let prefs = JSON.parse(localStorage.getItem(PREF_KEY)) || {
      leftWidth: 80, rightWidth: 300, uiScale: 100,
      leftHidden: false, rightHidden: false
    };

    const stylesheet = document.createElement('style');
    stylesheet.id = 'wa-dual-styles';

    function updateStyles() {
      const uiScaleVal = prefs.uiScale / 100;
      stylesheet.innerHTML = `
        :root {
          --wat-bg: #131318; --wat-surface: #17171d; --wat-surface-2: #1c1c23;
          --wat-border: rgba(255,255,255,0.07); --wat-border-strong: rgba(255,255,255,0.14);
          --wat-text: #ece9e4; --wat-text-dim: #96949c;
          --wat-accent: #25d366; --wat-accent-soft: rgba(37,211,102,0.14);
          --wat-shadow: rgba(0,0,0,0.5);
        }
        #wa-modular-left-panel, #wa-modular-right-panel {
          position: fixed; top: 0; height: 100vh;
          background: var(--wat-bg); color: var(--wat-text);
          z-index: 2147483647; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          display: flex; flex-direction: column; overflow-x: hidden;
          zoom: ${uiScaleVal} !important;
        }
        #wa-modular-left-panel {
          left: ${prefs.leftHidden ? `-${prefs.leftWidth}px` : '0'};
          width: ${prefs.leftWidth}px; border-right: 1px solid var(--wat-border);
          box-shadow: 24px 0 60px var(--wat-shadow);
          transition: left 0.28s cubic-bezier(0.22, 0.61, 0.36, 1);
        }
        #wa-modular-right-panel {
          right: ${prefs.rightHidden ? `-${prefs.rightWidth}px` : '0'};
          width: ${prefs.rightWidth}px; border-left: 1px solid var(--wat-border);
          box-shadow: -24px 0 60px var(--wat-shadow);
          transition: right 0.28s cubic-bezier(0.22, 0.61, 0.36, 1);
        }
        #wa-left-toggle-tab, #wa-right-toggle-tab {
          position: fixed; top: 50%; transform: translateY(-50%);
          background: var(--wat-surface); color: var(--wat-text-dim);
          border: 1px solid var(--wat-border); padding: 14px 7px;
          cursor: pointer; z-index: 2147483648; font-size: 10px; font-weight: 600;
          writing-mode: vertical-rl;
        }
        #wa-left-toggle-tab { left: 0; border-left: none; border-radius: 0 10px 10px 0; display: ${prefs.leftHidden ? 'flex' : 'none'}; }
        #wa-right-toggle-tab { right: 0; border-right: none; border-radius: 10px 0 0 10px; display: ${prefs.rightHidden ? 'flex' : 'none'}; }
        #wa-left-resizer, #wa-right-resizer { position: absolute; top: 0; width: 4px; height: 100%; cursor: ew-resize; z-index: 2147483648; }
        #wa-left-resizer { right: -2px; display: ${prefs.leftHidden ? 'none' : 'block'}; }
        #wa-right-resizer { left: -2px; display: ${prefs.rightHidden ? 'none' : 'block'}; }
        .wa-panel-header { padding: 16px 16px 14px; border-bottom: 1px solid var(--wat-border); display: flex; justify-content: space-between; align-items: center; flex-shrink: 0; gap: 10px; }
        .wa-panel-title { font-size: 10.5px; font-weight: 600; color: var(--wat-text-dim); text-transform: uppercase; }
        .wa-panel-body { padding: 12px; flex: 1; overflow-y: auto; overflow-x: hidden; display: flex; flex-direction: column; gap: 10px; }
        .wa-draggable-menu { background: var(--wat-surface); border: 1px solid var(--wat-border); border-radius: 11px; overflow: hidden; flex-shrink: 0; display: flex; flex-direction: column; }
        .wa-menu-header { padding: 10px 12px; font-size: 11.5px; font-weight: 600; color: var(--wat-text); display: flex; justify-content: space-between; align-items: center; cursor: grab; user-select: none; }
        .wa-menu-content { padding: 0 12px 12px; display: flex; flex-direction: column; gap: 8px; resize: vertical; overflow: auto; min-height: 50px; max-height: 80vh; }
        .wa-base-btn { background: var(--wat-accent); color: #06210f; border: none; padding: 8px 10px; border-radius: 8px; font-weight: 600; cursor: pointer; font-size: 11px; width: 100%; }
        .wa-hide-btn { background: transparent; color: var(--wat-text-dim); border: 1px solid var(--wat-border); padding: 5px 9px; border-radius: 6px; cursor: pointer; font-size: 10px; font-weight: 600; }
        select.wa-ui-scale-select { background: var(--wat-surface-2); color: var(--wat-text-dim); border: 1px solid var(--wat-border); border-radius: 6px; font-size: 10px; padding: 4px 6px; cursor: pointer; }
      `;
    }

    updateStyles();
    document.documentElement.appendChild(stylesheet);

    function buildModularUI() {
      if (document.getElementById('wa-modular-left-panel')) return;

      const leftPanel = document.createElement('div');
      leftPanel.id = 'wa-modular-left-panel';
      leftPanel.innerHTML = `
        <div id="wa-left-resizer"></div>
        <div class="wa-panel-header"><span class="wa-panel-title">Left</span><button class="wa-hide-btn" id="wa-hide-left-btn">Hide</button></div>
        <div class="wa-panel-body" id="wa-left-menu-container"></div>`;
      document.body.appendChild(leftPanel);

      const rightPanel = document.createElement('div');
      rightPanel.id = 'wa-modular-right-panel';
      rightPanel.innerHTML = `
        <div id="wa-right-resizer"></div>
        <div class="wa-panel-header">
          <button class="wa-hide-btn" id="wa-hide-right-btn">Hide</button>
          <span class="wa-panel-title">Right</span>
          <select id="wa-ui-scale-select" class="wa-ui-scale-select">
            <option value="80">80%</option><option value="90">90%</option><option value="100">100%</option><option value="110">110%</option><option value="120">120%</option>
          </select>
        </div>
        <div class="wa-panel-body" id="wa-right-menu-container"></div>`;
      document.body.appendChild(rightPanel);

      const leftTab = document.createElement('div'); leftTab.id = 'wa-left-toggle-tab'; leftTab.textContent = 'LEFT'; document.body.appendChild(leftTab);
      const rightTab = document.createElement('div'); rightTab.id = 'wa-right-toggle-tab'; rightTab.textContent = 'RIGHT'; document.body.appendChild(rightTab);

      document.getElementById('wa-hide-left-btn').addEventListener('click', () => { prefs.leftHidden = true; savePrefs(); });
      leftTab.addEventListener('click', () => { prefs.leftHidden = false; savePrefs(); });
      document.getElementById('wa-hide-right-btn').addEventListener('click', () => { prefs.rightHidden = true; savePrefs(); });
      rightTab.addEventListener('click', () => { prefs.rightHidden = false; savePrefs(); });

      const uiScaleSelect = document.getElementById('wa-ui-scale-select');
      uiScaleSelect.value = prefs.uiScale;
      uiScaleSelect.addEventListener('change', (e) => { prefs.uiScale = parseInt(e.target.value); savePrefs(); });

      const leftResizer = document.getElementById('wa-left-resizer');
      let isResizingLeft = false;
      leftResizer.addEventListener('mousedown', () => { isResizingLeft = true; });
      const rightResizer = document.getElementById('wa-right-resizer');
      let isResizingRight = false;
      rightResizer.addEventListener('mousedown', () => { isResizingRight = true; });

      window.addEventListener('mousemove', (e) => {
        if (isResizingLeft) { prefs.leftWidth = Math.min(500, Math.max(50, e.clientX)); updateStyles(); notifyChange(); }
        if (isResizingRight) { prefs.rightWidth = Math.min(500, Math.max(180, window.innerWidth - e.clientX)); updateStyles(); notifyChange(); }
      });
      window.addEventListener('mouseup', () => {
        if (isResizingLeft || isResizingRight) { isResizingLeft = isResizingRight = false; savePrefs(); notifyChange(); }
      });
    }

    function savePrefs() { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); updateStyles(); notifyChange(); }
    function notifyChange() {
      core.emit('sidebar:layout-changed', {
        leftWidth: prefs.leftHidden ? 0 : prefs.leftWidth,
        rightWidth: prefs.rightHidden ? 0 : prefs.rightWidth,
        leftHidden: prefs.leftHidden, rightHidden: prefs.rightHidden
      });
    }

    // WhatsApp Web is a single-page app under one route (no per-thread URL
    // segment like Instagram's "/direct/"), so the sidebar is simply always
    // on once WhatsApp's own #app root exists, rather than gated by URL.
    if (document.body) buildModularUI();
    else document.addEventListener('DOMContentLoaded', buildModularUI);

    core.getSidebarPrefs = () => prefs;
    core.emit('block:ready', { id: 'waDualSidebarUI' });
  }
});

/* ============================================================
   BLOCK: Menu Collapse Module (v1)
   ============================================================ */
LegoCore.registerBlock({
  id: 'menuCollapseModule',
  init(core) {
    const STORAGE_KEY = 'wa_menu_collapse_states_v1';
    let collapsedStates = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
    function saveStates() { localStorage.setItem(STORAGE_KEY, JSON.stringify(collapsedStates)); }

    const style = document.createElement('style');
    style.innerHTML = `
      .wa-collapse-btn { background: transparent; border: none; color: var(--wat-text-dim, #96949c); cursor: pointer; font-size: 13px; font-weight: bold; line-height: 1; padding: 0 4px; margin-left: 6px; border-radius: 3px; transition: color 0.2s, background 0.2s; }
      .wa-collapse-btn:hover { color: var(--wat-accent, #25d366); background: rgba(255,255,255,0.08); }
      .wa-draggable-menu.is-collapsed .wa-menu-content { display: none !important; }
      .wa-draggable-menu.is-collapsed { min-height: 0 !important; height: auto !important; }
    `;
    document.head.appendChild(style);

    function processCard(card) {
      const key = card.dataset.key;
      const header = card.querySelector('.wa-menu-header');
      if (!header || !key || header.querySelector('.wa-collapse-btn')) return;
      const dragHandle = header.querySelector('.wa-drag-handle');
      const btn = document.createElement('button');
      btn.className = 'wa-collapse-btn';
      btn.title = 'Collapse/Expand Menu';
      const isCollapsed = !!collapsedStates[key];
      if (isCollapsed) { card.classList.add('is-collapsed'); btn.innerText = '+'; } else { btn.innerText = '−'; }
      btn.addEventListener('mousedown', (e) => e.stopPropagation());
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const currentlyCollapsed = card.classList.toggle('is-collapsed');
        btn.innerText = currentlyCollapsed ? '+' : '−';
        collapsedStates[key] = currentlyCollapsed;
        saveStates();
      });
      if (dragHandle) header.insertBefore(btn, dragHandle); else header.appendChild(btn);
    }

    function attachToContainer(containerId) {
      const container = document.getElementById(containerId);
      if (!container) return;
      container.querySelectorAll('.wa-draggable-menu').forEach(processCard);
      const observer = new MutationObserver(() => container.querySelectorAll('.wa-draggable-menu').forEach(processCard));
      observer.observe(container, { childList: true, subtree: true });
    }

    function initWatcher(attempts) {
      const left = document.getElementById('wa-left-menu-container');
      const right = document.getElementById('wa-right-menu-container');
      if (left && right) { attachToContainer('wa-left-menu-container'); attachToContainer('wa-right-menu-container'); }
      else if (attempts > 0) setTimeout(() => initWatcher(attempts - 1), 200);
    }
    initWatcher(10);
    core.emit('block:ready', { id: 'menuCollapseModule' });
  }
});

/* ============================================================
   BLOCK: Menu Panel Switcher (v1)
   ============================================================ */
LegoCore.registerBlock({
  id: 'menuPanelSwitcherModule',
  init(core) {
    const STORAGE_KEY = 'wa_menu_panel_assignments_v1';
    let panelAssignments = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
    function saveAssignments() { localStorage.setItem(STORAGE_KEY, JSON.stringify(panelAssignments)); }

    const style = document.createElement('style');
    style.innerHTML = `
      .wa-switch-panel-btn { background: transparent; border: none; color: var(--wat-text-dim, #96949c); cursor: pointer; font-size: 12px; font-weight: bold; line-height: 1; padding: 2px 4px; margin-left: 4px; border-radius: 3px; transition: color 0.2s, background 0.2s; }
      .wa-switch-panel-btn:hover { color: var(--wat-accent, #25d366); background: rgba(255,255,255,0.08); }
    `;
    document.head.appendChild(style);

    function processCard(card) {
      const key = card.dataset.key;
      const header = card.querySelector('.wa-menu-header');
      if (!header || !key) return;
      const leftContainer = document.getElementById('wa-left-menu-container');
      const rightContainer = document.getElementById('wa-right-menu-container');
      if (!leftContainer || !rightContainer) return;

      const savedSide = panelAssignments[key];
      if (savedSide === 'left' && card.parentElement !== leftContainer) leftContainer.appendChild(card);
      else if (savedSide === 'right' && card.parentElement !== rightContainer) rightContainer.appendChild(card);

      if (header.querySelector('.wa-switch-panel-btn')) return;
      const btn = document.createElement('button');
      btn.className = 'wa-switch-panel-btn';
      btn.title = 'Switch Panel (Left <-> Right)';
      btn.innerText = '⇄';
      btn.addEventListener('mousedown', (e) => e.stopPropagation());
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const currentContainer = card.parentElement;
        const isCurrentlyLeft = currentContainer.id === 'wa-left-menu-container';
        const targetContainer = isCurrentlyLeft ? rightContainer : leftContainer;
        targetContainer.appendChild(card);
        panelAssignments[key] = isCurrentlyLeft ? 'right' : 'left';
        saveAssignments();
      });
      const collapseBtn = header.querySelector('.wa-collapse-btn');
      const dragHandle = header.querySelector('.wa-drag-handle');
      if (collapseBtn) header.insertBefore(btn, collapseBtn);
      else if (dragHandle) header.insertBefore(btn, dragHandle);
      else header.appendChild(btn);
    }

    function attachToContainer(containerId) {
      const container = document.getElementById(containerId);
      if (!container) return;
      container.querySelectorAll('.wa-draggable-menu').forEach(processCard);
      const observer = new MutationObserver(() => container.querySelectorAll('.wa-draggable-menu').forEach(processCard));
      observer.observe(container, { childList: true, subtree: true });
    }

    function initWatcher(attempts) {
      const left = document.getElementById('wa-left-menu-container');
      const right = document.getElementById('wa-right-menu-container');
      if (left && right) { attachToContainer('wa-left-menu-container'); attachToContainer('wa-right-menu-container'); }
      else if (attempts > 0) setTimeout(() => initWatcher(attempts - 1), 200);
    }
    initWatcher(10);
    core.emit('block:ready', { id: 'menuPanelSwitcherModule' });
  }
});

/* ============================================================
   BLOCK: Menu Card Reorder Module (v1)
   ============================================================ */
/* ============================================================
   BLOCK: Menu Card Reorder Module (v1) [FIXED]
   ============================================================ */
LegoCore.registerBlock({
  id: 'menuCardReorderModule',
  init(core) {
    const STORAGE_KEY = 'wa_menu_card_order_v1';
    let order = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
    function saveOrder() { localStorage.setItem(STORAGE_KEY, JSON.stringify(order)); }

    function applySavedOrder(containerId) {
      const container = document.getElementById(containerId);
      if (!container || !order[containerId]) return;
      order[containerId].forEach(key => {
        const el = container.querySelector('[data-key="' + key + '"]');
        // Minor optimization: only move the element if it isn't already the last child
        if (el && container.lastElementChild !== el) {
            container.appendChild(el);
        }
      });
    }

    function recordOrder(containerId) {
      const container = document.getElementById(containerId);
      if (!container) return;
      order[containerId] = Array.from(container.querySelectorAll('.wa-draggable-menu')).map(c => c.dataset.key);
      saveOrder();
    }

    function attachDragReorder(containerId) {
      const container = document.getElementById(containerId);
      if (!container) return;
      applySavedOrder(containerId);

      let draggingCard = null;
      container.addEventListener('mousedown', (e) => {
        const header = e.target.closest('.wa-menu-header');
        if (!header || e.target.closest('button')) return;
        draggingCard = header.closest('.wa-draggable-menu');
        if (draggingCard) draggingCard.style.opacity = '0.6';
      });
      document.addEventListener('mouseup', () => {
        if (draggingCard) { draggingCard.style.opacity = '1'; recordOrder(containerId); draggingCard = null; }
      });
      container.addEventListener('mousemove', (e) => {
        if (!draggingCard) return;
        const after = Array.from(container.querySelectorAll('.wa-draggable-menu')).find(card => {
          if (card === draggingCard) return false;
          const rect = card.getBoundingClientRect();
          return e.clientY < rect.top + rect.height / 2;
        });
        if (after) container.insertBefore(draggingCard, after);
        else container.appendChild(draggingCard);
      });

      // THE FIX: Disconnect the observer before rearranging the DOM to prevent infinite loops, then reconnect it.
      const observer = new MutationObserver((mutations, obs) => {
        obs.disconnect(); 
        applySavedOrder(containerId);
        obs.observe(container, { childList: true });
      });
      
      observer.observe(container, { childList: true });
    }

    function initWatcher(attempts) {
      const left = document.getElementById('wa-left-menu-container');
      const right = document.getElementById('wa-right-menu-container');
      if (left && right) { attachDragReorder('wa-left-menu-container'); attachDragReorder('wa-right-menu-container'); }
      else if (attempts > 0) setTimeout(() => initWatcher(attempts - 1), 200);
    }
    initWatcher(10);
    core.emit('block:ready', { id: 'menuCardReorderModule' });
  }
});

/* ============================================================
   BLOCK: Menu Card Pop-out Module (v2)
   ============================================================ */
/* ============================================================
   BLOCK: Menu Card Pop-out Module (v1)
   ============================================================ */
LegoCore.registerBlock({
  id: 'menuInPagePopoutModule',
  init(core) {
    const STORAGE_KEY = 'wa_menu_inpage_popouts_v1';
    let popoutStates = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
    function saveStates() { localStorage.setItem(STORAGE_KEY, JSON.stringify(popoutStates)); }

    const style = document.createElement('style');
    style.innerHTML = `
      .wa-popout-btn { background: transparent; border: none; color: var(--wat-text-dim, #96949c); cursor: pointer; font-size: 12px; padding: 2px 5px; border-radius: 4px; }
      .wa-popout-btn:hover { color: var(--wat-accent, #25d366); background: rgba(255,255,255,0.08); }
      .wa-floating-modal { position: fixed; z-index: 2147483647; background: var(--wat-surface, #17171d); border: 1px solid var(--wat-border-strong, rgba(255,255,255,0.2)); border-radius: 10px; box-shadow: 0 10px 30px rgba(0,0,0,0.7); display: flex; flex-direction: column; overflow: hidden; min-width: 220px; min-height: 150px; }
      .wa-floating-modal .wa-menu-header { cursor: grab; }
      .wa-fm-resizer { position: absolute; }
      .wa-fm-resizer.left { left: 0; top: 0; width: 6px; height: 100%; cursor: ew-resize; }
      .wa-fm-resizer.right { right: 0; top: 0; width: 6px; height: 100%; cursor: ew-resize; }
      .wa-fm-resizer.bottom { left: 0; bottom: 0; width: 100%; height: 6px; cursor: ns-resize; }
      .wa-fm-resizer.corner { right: 0; bottom: 0; width: 12px; height: 12px; cursor: nwse-resize; }
      .wa-fm-resizer.active { background: var(--wat-accent, #25d366); opacity: 0.4; }
      .wa-draggable-menu.is-popped-out { display: none; }
    `;
    document.head.appendChild(style);

    function createFloatingWindow(card) {
      const key = card.dataset.key;
      if (document.getElementById('wa-float-modal-' + key)) return;

      // Initialize state for this key if it doesn't exist, and mark it as popped out
      popoutStates[key] = popoutStates[key] || { top: 120, left: 220, width: 320 };
      popoutStates[key].isPoppedOut = true;
      saveStates();

      const state = popoutStates[key];
      const modal = document.createElement('div');
      modal.className = 'wa-floating-modal';
      modal.id = 'wa-float-modal-' + key;
      modal.style.top = state.top + 'px';
      modal.style.left = state.left + 'px';
      modal.style.width = (state.width || 320) + 'px';
      if (state.height) modal.style.height = state.height + 'px';

      const header = card.querySelector('.wa-menu-header').cloneNode(true);
      header.querySelectorAll('button').forEach(b => b.remove());
      const closeBtn = document.createElement('button');
      closeBtn.className = 'wa-popout-btn';
      closeBtn.innerText = '⤓';
      closeBtn.title = 'Dock back to sidebar';
      closeBtn.onclick = (e) => { e.stopPropagation(); dockBack(card, key); };
      header.appendChild(closeBtn);
      modal.appendChild(header);

      const content = card.querySelector('.wa-menu-content');
      modal.appendChild(content);

      const leftResizer = document.createElement('div'); leftResizer.className = 'wa-fm-resizer left';
      const rightResizer = document.createElement('div'); rightResizer.className = 'wa-fm-resizer right';
      const bottomResizer = document.createElement('div'); bottomResizer.className = 'wa-fm-resizer bottom';
      const cornerResizer = document.createElement('div'); cornerResizer.className = 'wa-fm-resizer corner';
      [leftResizer, rightResizer, bottomResizer, cornerResizer].forEach(r => modal.appendChild(r));

      document.body.appendChild(modal);
      card.classList.add('is-popped-out');
      makeModalDraggable(modal, header, key);
      makeModalResizable(modal, leftResizer, rightResizer, bottomResizer, cornerResizer, key);
    }

    function dockBack(card, key) {
      const modal = document.getElementById('wa-float-modal-' + key);
      if (!modal) return;
      const content = modal.querySelector('.wa-menu-content');
      if (content) card.appendChild(content);
      modal.remove();
      card.classList.remove('is-popped-out');
      
      // Update state instead of deleting, so it remembers size/position for next time
      if (popoutStates[key]) popoutStates[key].isPoppedOut = false;
      saveStates();
    }

    function makeModalDraggable(modal, header, key) {
      let isDragging = false, startX, startY, initLeft, initTop;
      header.addEventListener('mousedown', (e) => {
        if (e.button !== 0 || e.target.tagName === 'BUTTON') return;
        isDragging = true; startX = e.clientX; startY = e.clientY;
        initLeft = modal.offsetLeft; initTop = modal.offsetTop;
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        e.preventDefault();
      });
      function onMove(e) {
        if (!isDragging) return;
        modal.style.left = (initLeft + (e.clientX - startX)) + 'px';
        modal.style.top = (initTop + (e.clientY - startY)) + 'px';
      }
      function onUp() {
        if (!isDragging) return;
        isDragging = false;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        popoutStates[key] = Object.assign({}, popoutStates[key], { top: modal.offsetTop, left: modal.offsetLeft });
        saveStates();
      }
    }

    function makeModalResizable(modal, leftResizer, rightResizer, bottomResizer, cornerResizer, key) {
      const MIN_WIDTH = 220, MIN_HEIGHT = 150;
      function startResize(mode) {
        return function (e) {
          if (e.button !== 0) return;
          e.preventDefault(); e.stopPropagation();
          const startX = e.clientX, startY = e.clientY;
          const startWidth = modal.offsetWidth, startHeight = modal.offsetHeight, startLeft = modal.offsetLeft;
          const resizerEl = mode === 'left' ? leftResizer : mode === 'right' ? rightResizer : mode === 'bottom' ? bottomResizer : cornerResizer;
          resizerEl.classList.add('active');
          function onMove(ev) {
            const dx = ev.clientX - startX, dy = ev.clientY - startY;
            if (mode === 'right' || mode === 'corner') modal.style.width = Math.max(MIN_WIDTH, startWidth + dx) + 'px';
            else if (mode === 'left') {
              const newWidth = Math.max(MIN_WIDTH, startWidth - dx);
              modal.style.width = newWidth + 'px';
              modal.style.left = (startLeft - (newWidth - startWidth)) + 'px';
            }
            if (mode === 'bottom' || mode === 'corner') modal.style.height = Math.max(MIN_HEIGHT, startHeight + dy) + 'px';
          }
          function onUp() {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            resizerEl.classList.remove('active');
            popoutStates[key] = Object.assign({}, popoutStates[key], { top: modal.offsetTop, left: modal.offsetLeft, width: modal.offsetWidth, height: modal.offsetHeight });
            saveStates();
          }
          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', onUp);
        };
      }
      leftResizer.addEventListener('mousedown', startResize('left'));
      rightResizer.addEventListener('mousedown', startResize('right'));
      bottomResizer.addEventListener('mousedown', startResize('bottom'));
      cornerResizer.addEventListener('mousedown', startResize('corner'));
    }

    function processCard(card) {
      if (!card || !card.dataset) return;
      const key = card.dataset.key;
      const header = card.querySelector('.wa-menu-header');
      if (!header || !key || header.querySelector('.wa-popout-btn')) return;
      const btn = document.createElement('button');
      btn.className = 'wa-popout-btn';
      btn.title = 'Pop out as floating window';
      btn.innerText = '⧉';
      btn.addEventListener('mousedown', (e) => e.stopPropagation());
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        createFloatingWindow(card);
      });
      const switchBtn = header.querySelector('.wa-switch-panel-btn');
      const collapseBtn = header.querySelector('.wa-collapse-btn');
      const dragHandle = header.querySelector('.wa-drag-handle');
      if (switchBtn) header.insertBefore(btn, switchBtn);
      else if (collapseBtn) header.insertBefore(btn, collapseBtn);
      else if (dragHandle) header.insertBefore(btn, dragHandle);
      else header.appendChild(btn);

      // Restore pop-out state automatically if it was left popped out
      if (popoutStates[key] && (popoutStates[key].isPoppedOut === true || popoutStates[key].isPoppedOut === undefined)) {
        setTimeout(() => createFloatingWindow(card), 100);
      }
    }

    function attachToContainer(containerId) {
      const container = document.getElementById(containerId);
      if (!container) return;
      container.querySelectorAll('.wa-draggable-menu').forEach(processCard);
      const observer = new MutationObserver(() => container.querySelectorAll('.wa-draggable-menu').forEach(processCard));
      observer.observe(container, { childList: true, subtree: true });
    }

    function initWatcher(attempts) {
      const left = document.getElementById('wa-left-menu-container');
      const right = document.getElementById('wa-right-menu-container');
      if (left && right) { attachToContainer('wa-left-menu-container'); attachToContainer('wa-right-menu-container'); }
      else if (attempts > 0) setTimeout(() => initWatcher(attempts - 1), 200);
    }
    initWatcher(10);
    core.emit('block:ready', { id: 'menuInPagePopoutModule' });
  }
});

/* ============================================================
   BLOCK: Header Toolbar Organizer (v1)
   ============================================================ */
LegoCore.registerBlock({
  id: 'headerToolbarOrganizerModule',
  init(core) {
    const style = document.createElement('style');
    style.innerHTML = `
      .wa-drag-handle { display: none !important; }
      .wa-card-toolbar { display: flex; align-items: center; gap: 2px; background: rgba(255,255,255,0.05); border: 1px solid var(--wat-border, rgba(255,255,255,0.08)); border-radius: 6px; padding: 2px; margin-left: auto; }
      .wa-card-toolbar button { background: transparent !important; border: none !important; color: var(--wat-text-dim, #96949c) !important; cursor: pointer !important; font-size: 11px !important; padding: 4px 6px !important; margin: 0 !important; border-radius: 4px !important; }
      .wa-card-toolbar button:hover { color: var(--wat-accent, #25d366) !important; background: rgba(255,255,255,0.1) !important; }
    `;
    document.head.appendChild(style);

    function organizeCardHeader(card) {
      const header = card.querySelector('.wa-menu-header');
      if (!header) return;
      const dragHandle = header.querySelector('.wa-drag-handle');
      if (dragHandle) dragHandle.remove();
      let toolbar = header.querySelector('.wa-card-toolbar');
      if (!toolbar) { toolbar = document.createElement('div'); toolbar.className = 'wa-card-toolbar'; header.appendChild(toolbar); }
      const popBtn = header.querySelector('.wa-popout-btn');
      const switchBtn = header.querySelector('.wa-switch-panel-btn');
      const collapseBtn = header.querySelector('.wa-collapse-btn');
      if (popBtn && popBtn.parentElement !== toolbar) toolbar.appendChild(popBtn);
      if (switchBtn && switchBtn.parentElement !== toolbar) toolbar.appendChild(switchBtn);
      if (collapseBtn && collapseBtn.parentElement !== toolbar) toolbar.appendChild(collapseBtn);
    }

    function attachToContainer(containerId) {
      const container = document.getElementById(containerId);
      if (!container) return;
      container.querySelectorAll('.wa-draggable-menu').forEach(organizeCardHeader);
      const observer = new MutationObserver(() => container.querySelectorAll('.wa-draggable-menu').forEach(organizeCardHeader));
      observer.observe(container, { childList: true, subtree: true });
    }

    function initWatcher(attempts) {
      const left = document.getElementById('wa-left-menu-container');
      const right = document.getElementById('wa-right-menu-container');
      if (left && right) { attachToContainer('wa-left-menu-container'); attachToContainer('wa-right-menu-container'); }
      else if (attempts > 0) setTimeout(() => initWatcher(attempts - 1), 200);
    }
    initWatcher(10);
    core.emit('block:ready', { id: 'headerToolbarOrganizerModule' });
  }
});

/* ============================================================
   BLOCK: WhatsApp Layout Resizer (v2)
   ============================================================ */
/* ============================================================
   BLOCK: WhatsApp Layout Resizer (v1)
   ============================================================ */
LegoCore.registerBlock({
  id: 'waPageResizerFeature',
  init(core) {
    function applyOffsets(leftWidth, rightWidth) {
      let styleEl = document.getElementById('wa-layout-offsets');
      
      // If the style element doesn't exist yet, create it
      if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = 'wa-layout-offsets';
        document.head.appendChild(styleEl);
      }
      
      // Using a CSS stylesheet with !important prevents WhatsApp from wiping it out 
      // during React re-renders, and we don't have to wait for the DOM to load first.
      styleEl.innerHTML = `
        #app > div {
          margin-left: ${leftWidth}px !important;
          margin-right: ${rightWidth}px !important;
          width: calc(100% - ${leftWidth + rightWidth}px) !important;
          transition: margin 0.28s cubic-bezier(0.22, 0.61, 0.36, 1), width 0.28s cubic-bezier(0.22, 0.61, 0.36, 1) !important;
        }
      `;
    }

    // Listen for resize events from the sidebars
    window.addEventListener('wa-resizer-update', (e) => {
      applyOffsets(e.detail.leftWidth, e.detail.rightWidth);
    });

    // Apply the saved width preferences immediately on load
    function initialApply(attempts) {
      const prefs = core.getSidebarPrefs && core.getSidebarPrefs();
      if (prefs) {
        applyOffsets(prefs.leftHidden ? 0 : prefs.leftWidth, prefs.rightHidden ? 0 : prefs.rightWidth);
      } else if (attempts > 0) {
        setTimeout(() => initialApply(attempts - 1), 200);
      }
    }
    initialApply(10);

    core.emit('block:ready', { id: 'waPageResizerFeature' });
  }
});

/* ============================================================
   BLOCK: Sidebar-to-Resizer Sync (v1)
   ============================================================ */
LegoCore.registerBlock({
  id: 'waSidebarSyncFeature',
  init(core) {
    core.on('sidebar:layout-changed', (layout) => {
      const targetLeft = layout.leftHidden ? 0 : layout.leftWidth;
      const targetRight = layout.rightHidden ? 0 : layout.rightWidth;
      window.dispatchEvent(new CustomEvent('wa-resizer-update', { detail: { leftWidth: targetLeft, rightWidth: targetRight } }));
    });
    core.emit('block:ready', { id: 'waSidebarSyncFeature' });
  }
});

/* ============================================================
   BLOCK: Text Library Height Fix (v2)
   ============================================================ */
/* ============================================================
   BLOCK: Text Library Height Fix (v1)
   ============================================================ */
LegoCore.registerBlock({
  id: 'textLibraryHeightFix',
  init(core) {
    const style = document.createElement('style');
    style.innerHTML = `
      .wa-draggable-menu[data-key="text-library-module"] .wa-menu-content,
      .wa-draggable-menu[data-key="image-library-module"] .wa-menu-content {
        display: flex; flex-direction: column; height: auto; max-height: 80vh; min-height: 200px;
      }
      .wa-draggable-menu[data-key="text-library-module"] .wa-tln-tree,
      .wa-draggable-menu[data-key="image-library-module"] .wa-tln-tree {
        max-height: 50vh !important; flex: 1; min-height: 150px; overflow-y: auto;
      }
      .wa-floating-modal[id="wa-float-modal-text-library-module"],
      .wa-floating-modal[id="wa-float-modal-image-library-module"] { 
        height: auto; min-height: 300px; 
      }
    `;
    document.head.appendChild(style);
    core.emit('block:ready', { id: 'textLibraryHeightFix' });
  }
});

/* ============================================================
   BLOCK: Reset Menus (v1)
   ============================================================ */
LegoCore.registerBlock({
  id: 'floatingMenuRescueModule',
  init(core) {
    const resetBtn = document.createElement('button');
    resetBtn.innerText = '⛑️ Reset Menus';
    resetBtn.title = 'Click to reset all floating window positions if they get stuck off-screen';
    resetBtn.style.cssText = `
      position: fixed; bottom: 12px; left: 12px; z-index: 2147483647;
      background: rgba(220, 38, 38, 0.7); color: white; border: 1px solid #7f1d1d;
      border-radius: 6px; padding: 6px 10px; font-size: 11px; font-weight: bold; cursor: pointer;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; transition: opacity 0.2s, background 0.2s; opacity: 0.4;
    `;
    resetBtn.onmouseover = () => { resetBtn.style.opacity = '1'; resetBtn.style.background = 'rgba(220, 38, 38, 1)'; };
    resetBtn.onmouseout = () => { resetBtn.style.opacity = '0.4'; resetBtn.style.background = 'rgba(220, 38, 38, 0.7)'; };
    resetBtn.onclick = () => {
      if (confirm("Reset all floating menu positions? This will reload the page.")) {
        localStorage.removeItem('wa_menu_inpage_popouts_v1');
        localStorage.removeItem('wa_workspace_profile_window_pos_v1');
        localStorage.removeItem('wa_tl_notion_filter_pos');
        window.location.reload();
      }
    };
    document.body.appendChild(resetBtn);
    core.emit('block:ready', { id: 'floatingMenuRescueModule' });
  }
});

/* ============================================================
   BLOCK: Quick Chat Box (v2)
   ============================================================ */
LegoCore.registerBlock({
  id: 'quickChatBoxPlugin',
  init(core) {
    const chatUI = document.createElement('div');
    chatUI.style.cssText = 'display: flex; flex-direction: column; gap: 8px;';
    chatUI.innerHTML = `
      <textarea id="wa-quick-chat-input" placeholder="Type message... (Enter to send, Shift+Enter for new line)"
        style="width:100%; min-height:65px; max-height:250px; background:#0f172a; color:#fff; border:1px solid #334155; border-radius:6px; padding:8px; font-size:12px; resize:vertical; outline:none; font-family:-apple-system,sans-serif; box-sizing:border-box; line-height:1.4;"></textarea>
      <div id="wa-quick-chat-img-preview" style="display:none; align-items:center; gap:6px; font-size:10px; color:#94a3b8;">
        <img id="wa-quick-chat-img-thumb" style="width:32px; height:32px; object-fit:cover; border-radius:4px;">
        <span id="wa-quick-chat-img-name" style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"></span>
        <button id="wa-quick-chat-img-clear" class="wa-tln-btn" title="Remove image">✕</button>
      </div>
      <div style="display:flex; justify-content:space-between; align-items:center; gap:6px;">
        <input type="file" id="wa-quick-chat-img-input" accept="image/*" style="display:none;">
        <button id="wa-quick-chat-img-btn" class="wa-hide-btn" title="Attach an image to this message">🖼️ Image</button>
        <button id="wa-quick-chat-send" class="wa-base-btn" style="background:#25d366; width:auto; padding:6px 14px;">📤 Send</button>
      </div>
    `;

    const inputField = chatUI.querySelector('#wa-quick-chat-input');
    const sendBtn = chatUI.querySelector('#wa-quick-chat-send');
    const imgBtn = chatUI.querySelector('#wa-quick-chat-img-btn');
    const imgInput = chatUI.querySelector('#wa-quick-chat-img-input');
    const imgPreview = chatUI.querySelector('#wa-quick-chat-img-preview');
    const imgThumb = chatUI.querySelector('#wa-quick-chat-img-thumb');
    const imgName = chatUI.querySelector('#wa-quick-chat-img-name');
    const imgClear = chatUI.querySelector('#wa-quick-chat-img-clear');
    let pendingImageBlob = null;
    let pendingImageObjectUrl = null;

    function clearPendingImage() {
      pendingImageBlob = null;
      if (pendingImageObjectUrl) { URL.revokeObjectURL(pendingImageObjectUrl); pendingImageObjectUrl = null; }
      imgPreview.style.display = 'none';
    }

    imgBtn.onclick = () => imgInput.click();
    imgInput.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (pendingImageObjectUrl) URL.revokeObjectURL(pendingImageObjectUrl); // replace, don't leak the previous one
      pendingImageBlob = file;
      pendingImageObjectUrl = URL.createObjectURL(file);
      imgThumb.src = pendingImageObjectUrl;
      imgName.textContent = file.name;
      imgPreview.style.display = 'flex';
      imgInput.value = '';
    };
    imgClear.onclick = () => clearPendingImage();

    async function sendMessage() {
      const text = inputField.value.trim();
      if (!text && !pendingImageBlob) return;

      const originalText = sendBtn.innerText;
      sendBtn.innerText = '⏳ Working...';
      sendBtn.disabled = true;

      try {
        if (pendingImageBlob) {
          await core.showImagePreview(pendingImageBlob, text, 'quick_chat_image');
          sendBtn.innerText = '✅ Shown';
        } else {
          core.injectTextToChat(text, true);
          sendBtn.innerText = '✅ Sent!';
        }
        inputField.value = '';
        clearPendingImage();
      } catch (err) {
        core.notifyError('Failed: ' + err.message);
        sendBtn.innerText = '⚠️ Failed';
      }
      setTimeout(() => { sendBtn.innerText = originalText; sendBtn.disabled = false; }, 1000);
    }

    sendBtn.onclick = sendMessage;
    inputField.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });

    function mountCard(attemptsLeft) {
      attemptsLeft = attemptsLeft === undefined ? 10 : attemptsLeft;
      if (typeof core.registerMenu === 'function') {
        core.registerMenu('right', '💬 Quick Chat', chatUI, '⠿', 'quick-chat-box');
      } else if (attemptsLeft > 0) {
        setTimeout(() => mountCard(attemptsLeft - 1), 200);
      }
    }
    mountCard();
    core.emit('block:ready', { id: 'quickChatBoxPlugin' });
  }
});

/* ============================================================
   BLOCK: Shared Tree Styles (v1)
   ============================================================ */
LegoCore.registerBlock({
  id: 'waTreeSharedStyles',
  init(core) {
    const style = document.createElement('style');
    style.innerHTML = `
      .wa-tln-container { display: flex; flex-direction: column; gap: 8px; font-family: -apple-system, sans-serif; }
      .wa-tln-header-btns { display: flex; gap: 4px; flex-wrap: wrap; }
      .wa-tln-hbtn { flex: 1; background: var(--wat-surface-2, #1c1c23); color: #e2e8f0; border: 1px solid #334155; border-radius: 4px; padding: 6px 4px; font-size: 10px; font-weight: bold; cursor: pointer; min-width: 60px; }
      .wa-tln-hbtn:hover { background: #334155; color: #fff; }
      .wa-tln-tree { max-height: 350px; overflow-y: auto; padding-right: 4px; display: flex; flex-direction: column; }
      .wa-tln-drop-top { border-top: 2px solid #25d366 !important; }
      .wa-tln-drop-bottom { border-bottom: 2px solid #25d366 !important; }
      .wa-tln-drop-inside { background: rgba(37,211,102,0.15) !important; border: 1px dashed #25d366 !important; }
      .wa-tln-folder-head { display: flex; align-items: center; gap: 6px; font-weight: bold; font-size: 11px; color: #94a3b8; padding: 6px; background: rgba(0,0,0,0.2); border-bottom: 1px solid rgba(255,255,255,0.05); cursor: grab; }
      .wa-tln-caret { font-size: 9px; cursor: pointer; padding: 2px; width: 14px; text-align: center; transition: transform 0.2s; }
      .wa-tln-caret.collapsed { transform: rotate(-90deg); }
      .wa-tln-folder-content { display: flex; flex-direction: column; }
      .wa-tln-folder-content.collapsed { display: none; }
      .wa-tln-item { display: flex; flex-direction: column; border-bottom: 1px solid rgba(255,255,255,0.05); cursor: pointer; }
      .wa-tln-item.alt-bg { background: rgba(255,255,255,0.02); }
      .wa-tln-item:hover { background: rgba(255,255,255,0.06); }
      .wa-tln-row { display: flex; align-items: center; padding: 4px 6px; gap: 4px; }
      .wa-tln-drag-grip { color: #475569; font-size: 10px; cursor: grab; }
      .wa-tln-title-col { flex: 1; display: flex; align-items: center; font-size: 11px; color: #f8fafc; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; pointer-events: none; gap: 4px; }
      .wa-tln-tags { display: flex; gap: 4px; overflow: hidden; pointer-events: none; }
      .wa-tln-tag-pill { font-size: 9px; padding: 2px 6px; border-radius: 4px; font-weight: 600; white-space: nowrap; }
      .wa-tln-cmd-pill { font-size: 9px; padding: 2px 6px; border-radius: 4px; font-weight: 700; background: rgba(255,255,255,0.1); color: #25d366; flex-shrink: 0; }
      .wa-tln-img-pill { font-size: 9px; padding: 2px 6px; border-radius: 4px; font-weight: 700; background: rgba(37,211,102,0.15); color: #25d366; flex-shrink: 0; }
      .wa-tln-actions { display: flex; gap: 2px; align-items: center; margin-left: auto; }
      .wa-tln-btn { background: transparent; border: none; color: #64748b; cursor: pointer; font-size: 11px; padding: 4px; border-radius: 4px; }
      .wa-tln-btn:hover { background: rgba(255,255,255,0.1); color: #fff; }
      .wa-tln-btn.send-btn:hover { color: #25d366; }
      .wa-tln-preview { font-size: 10px; color: #94a3b8; padding: 0 8px 8px 24px; line-height: 1.4; display: none; white-space: pre-wrap; word-wrap: break-word; background: rgba(0,0,0,0.2); }
      .wa-tln-preview.visible { display: block; }
      .wa-tln-thumb { width: 28px; height: 28px; object-fit: cover; border-radius: 4px; flex-shrink: 0; }
      .wa-tlp-modal-overlay { position: fixed; top:0; left:0; right:0; bottom:0; background: rgba(0,0,0,0.6); z-index: 2147483647; display: flex; justify-content: center; align-items: center; }
      .wa-tlp-modal { background: #0f172a; border: 1px solid #334155; border-radius: 8px; width: 340px; max-width: 92vw; padding: 16px; display: flex; flex-direction: column; gap: 10px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
      .wa-tlp-modal h3 { margin: 0; font-size: 14px; color: #fff; }
      .wa-tlp-input { width: 100%; background: #1e293b; border: 1px solid #475569; color: #fff; padding: 8px; border-radius: 4px; font-size: 12px; box-sizing: border-box; outline: none; }
      .wa-tlp-input:focus { border-color: #25d366; }
      .wa-tlp-row { display: flex; gap: 6px; }
    `;
    document.head.appendChild(style);
    core.emit('block:ready', { id: 'waTreeSharedStyles' });
  }
});

/* ============================================================
   BLOCK: Saved Messages (Text Library) (v2)
   ============================================================ */
LegoCore.registerBlock({
  id: 'textLibraryModule',
  init(core) {
    const DATA_KEY = 'wa_text_library_v1';
    const FILTER_PREF_KEY = 'wa_tl_filter_pos';

    let libraryData = JSON.parse(localStorage.getItem(DATA_KEY)) || { items: [], tags: [] };
    function saveData() { localStorage.setItem(DATA_KEY, JSON.stringify(libraryData)); core.emit('textlib:changed', libraryData); }

    let activeFolderFilter = 'All';
    let activeTagFilter = 'All';
    let filterWindowPos = JSON.parse(localStorage.getItem(FILTER_PREF_KEY)) || { top: 150, left: 350, visible: false };
    let draggedItem = null;

    function hexToRgba(hex, alpha) {
      const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    core.getTextLibrary = () => libraryData;

    const libUI = document.createElement('div');
    libUI.className = 'wa-tln-container';
    libUI.innerHTML = `
      <div class="wa-tln-header-btns">
        <button id="wa-tlc-new-snip" class="wa-tln-hbtn">📝 New</button>
        <button id="wa-tlc-new-fold" class="wa-tln-hbtn">📁 Fold</button>
        <button id="wa-tlc-filter-btn" class="wa-tln-hbtn ${filterWindowPos.visible ? 'active-filter' : ''}">🔍 Filter</button>
      </div>
      <div id="wa-tlc-tree-root" class="wa-tln-tree"></div>
    `;

    // ---- Folder/Tag filter popup ----
    function buildFilterWindow() {
      if (document.getElementById('wa-tln-filter-win')) return;
      const win = document.createElement('div');
      win.id = 'wa-tln-filter-win';
      win.className = 'wa-floating-modal';
      win.style.top = filterWindowPos.top + 'px';
      win.style.left = filterWindowPos.left + 'px';
      win.style.width = '220px';
      win.style.display = filterWindowPos.visible ? 'flex' : 'none';
      win.style.padding = '10px';
      win.style.gap = '8px';

      const header = document.createElement('div');
      header.className = 'wa-menu-header';
      header.innerHTML = `<span>🔍 Filters</span><button id="wa-tln-close-filter" style="background:none;border:none;color:#94a3b8;cursor:pointer;">✕</button>`;

      const folderSelect = document.createElement('select'); folderSelect.className = 'wa-tlp-input';
      const tagSelect = document.createElement('select'); tagSelect.className = 'wa-tlp-input';

      function updateDropdowns() {
        folderSelect.innerHTML = `<option value="All">📁 All Folders</option>`;
        libraryData.items.filter(i => i.type === 'folder').forEach(f => {
          folderSelect.innerHTML += `<option value="${f.id}" ${activeFolderFilter === f.id ? 'selected' : ''}>${f.name}</option>`;
        });
        tagSelect.innerHTML = `<option value="All">🏷️ All Tags</option>`;
        libraryData.tags.forEach(t => { tagSelect.innerHTML += `<option value="${t.id}" ${activeTagFilter === t.id ? 'selected' : ''}>${t.name}</option>`; });
      }
      updateDropdowns();

      folderSelect.onchange = () => { activeFolderFilter = folderSelect.value; renderTree(); };
      tagSelect.onchange = () => { activeTagFilter = tagSelect.value; renderTree(); };

      win.appendChild(header); win.appendChild(folderSelect); win.appendChild(tagSelect);
      document.body.appendChild(win);

      win.querySelector('#wa-tln-close-filter').onclick = () => {
        filterWindowPos.visible = false; localStorage.setItem(FILTER_PREF_KEY, JSON.stringify(filterWindowPos));
        win.style.display = 'none';
        libUI.querySelector('#wa-tlc-filter-btn').classList.remove('active-filter');
      };
      core.makeDraggable(win, header, null);
      header.addEventListener('mouseup', () => {
        const rect = win.getBoundingClientRect();
        filterWindowPos.top = rect.top; filterWindowPos.left = rect.left;
        localStorage.setItem(FILTER_PREF_KEY, JSON.stringify(filterWindowPos));
      });
      core.on('textlib:changed', updateDropdowns);
      core.on('imglib:changed', updateDropdowns);
    }

    libUI.querySelector('#wa-tlc-filter-btn').onclick = () => {
      filterWindowPos.visible = !filterWindowPos.visible;
      localStorage.setItem(FILTER_PREF_KEY, JSON.stringify(filterWindowPos));
      const win = document.getElementById('wa-tln-filter-win');
      if (win) win.style.display = filterWindowPos.visible ? 'flex' : 'none';
      libUI.querySelector('#wa-tlc-filter-btn').classList.toggle('active-filter', filterWindowPos.visible);
    };

    // ---- New folder / new snippet ----
    libUI.querySelector('#wa-tlc-new-fold').onclick = () => {
      const name = prompt('Folder name:');
      if (!name || !name.trim()) return;
      libraryData.items.push({ id: 'fld_' + Date.now(), type: 'folder', parentId: 'root', name: name.trim(), collapsed: false, order: Date.now() });
      saveData(); renderTree();
    };

    function openSnippetEditor(item) {
      const isNew = !item;
      const draft = item || { id: 'snip_' + Date.now(), type: 'snippet', parentId: 'root', title: '', text: '', tags: [], customCommand: '', imageId: '', order: Date.now() };

      const overlay = document.createElement('div');
      overlay.className = 'wa-tlp-modal-overlay';
      const imageLib = core.getImageLibrary ? core.getImageLibrary() : { items: [] };
      const imageOptions = imageLib.items.filter(i => i.type === 'image').map(img =>
        `<option value="${img.id}" ${draft.imageId === img.id ? 'selected' : ''}>${img.name}</option>`).join('');

      overlay.innerHTML = `
        <div class="wa-tlp-modal">
          <h3>${isNew ? '📝 New Snippet' : '✏️ Edit Snippet'}</h3>
          <input type="text" id="wa-tlp-title" class="wa-tlp-input" placeholder="Title" value="${(draft.title || '').replace(/"/g, '&quot;')}">
          <textarea id="wa-tlp-text" class="wa-tlp-input" placeholder="Message text..." style="min-height:90px; resize:vertical;">${draft.text || ''}</textarea>
          <div class="wa-tlp-row">
            <input type="text" id="wa-tlp-command" class="wa-tlp-input" placeholder="/command (optional)" value="${draft.customCommand || ''}">
          </div>
          <div style="font-size:11px; color:#94a3b8;">Linked image (optional -- for combined text+image send):</div>
          <select id="wa-tlp-image" class="wa-tlp-input">
            <option value="">-- none --</option>
            ${imageOptions}
          </select>
          <div style="font-size:11px; color:#94a3b8;">Assign Tags:</div>
          <div id="wa-tlp-tags" style="display:flex; flex-wrap:wrap; gap:4px;"></div>
          <input type="text" id="wa-tlp-newtag" class="wa-tlp-input" placeholder="New tag name, press Enter">
          <div class="wa-tlp-row">
            <button id="wa-tlp-save" class="wa-base-btn">💾 Save</button>
            <button id="wa-tlp-cancel" class="wa-hide-btn" style="flex:1;">Cancel</button>
            ${isNew ? '' : '<button id="wa-tlp-delete" class="wa-hide-btn" style="flex:1; color:#f87171;">Delete</button>'}
          </div>
        </div>
      `;
      document.body.appendChild(overlay);

      const tagContainer = overlay.querySelector('#wa-tlp-tags');
      let selectedTags = new Set(draft.tags || []);
      function renderTagChips() {
        tagContainer.innerHTML = '';
        libraryData.tags.forEach(t => {
          const chip = document.createElement('span');
          chip.className = 'wa-tln-tag-pill';
          chip.style.cursor = 'pointer';
          chip.style.background = selectedTags.has(t.id) ? hexToRgba(t.color, 0.5) : hexToRgba(t.color, 0.15);
          chip.style.color = t.color;
          chip.textContent = t.name;
          chip.onclick = () => { selectedTags.has(t.id) ? selectedTags.delete(t.id) : selectedTags.add(t.id); renderTagChips(); };
          tagContainer.appendChild(chip);
        });
      }
      renderTagChips();

      overlay.querySelector('#wa-tlp-newtag').addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        const name = e.target.value.trim();
        if (!name) return;
        const palette = ['#25d366', '#0284c7', '#f77f00', '#9d0208', '#7209b7', '#10b981', '#f43f5e'];
        const tag = { id: 'tag_' + Date.now(), name, color: palette[libraryData.tags.length % palette.length] };
        libraryData.tags.push(tag);
        selectedTags.add(tag.id);
        e.target.value = '';
        renderTagChips();
      });

      overlay.querySelector('#wa-tlp-cancel').onclick = () => overlay.remove();
      if (!isNew) {
        overlay.querySelector('#wa-tlp-delete').onclick = () => {
          if (!confirm('Delete this snippet?')) return;
          libraryData.items = libraryData.items.filter(i => i.id !== draft.id);
          saveData(); renderTree(); overlay.remove();
        };
      }
      overlay.querySelector('#wa-tlp-save').onclick = () => {
        draft.title = overlay.querySelector('#wa-tlp-title').value.trim() || 'Untitled';
        draft.text = overlay.querySelector('#wa-tlp-text').value;
        draft.customCommand = overlay.querySelector('#wa-tlp-command').value.trim().replace(/^\//, '');
        draft.imageId = overlay.querySelector('#wa-tlp-image').value;
        draft.tags = Array.from(selectedTags);
        if (isNew) libraryData.items.push(draft);
        saveData(); renderTree(); overlay.remove();
      };
    }

    libUI.querySelector('#wa-tlc-new-snip').onclick = () => openSnippetEditor(null);

    // ---- Drag & drop reordering (folders + snippets, same tree) ----
    function handleDragStart(e, id) { draggedItem = id; e.target.style.opacity = '0.4'; e.dataTransfer.effectAllowed = 'move'; }
    function handleDragOver(e, targetId, targetType) {
      e.preventDefault();
      if (!draggedItem || draggedItem === targetId) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const offset = e.clientY - rect.top;
      e.currentTarget.classList.remove('wa-tln-drop-top', 'wa-tln-drop-bottom', 'wa-tln-drop-inside');
      if (targetType === 'folder' && offset > rect.height * 0.25 && offset < rect.height * 0.75) {
        e.currentTarget.classList.add('wa-tln-drop-inside');
      } else if (offset < rect.height / 2) {
        e.currentTarget.classList.add('wa-tln-drop-top');
      } else {
        e.currentTarget.classList.add('wa-tln-drop-bottom');
      }
    }
    function handleDrop(e, targetId, targetType) {
      e.preventDefault();
      e.currentTarget.classList.remove('wa-tln-drop-top', 'wa-tln-drop-bottom', 'wa-tln-drop-inside');
      if (!draggedItem || draggedItem === targetId) return;
      const dragged = libraryData.items.find(i => i.id === draggedItem);
      const target = libraryData.items.find(i => i.id === targetId);
      if (!dragged || !target) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const offset = e.clientY - rect.top;
      if (targetType === 'folder' && offset > rect.height * 0.25 && offset < rect.height * 0.75) {
        dragged.parentId = target.id;
      } else {
        dragged.parentId = target.parentId;
        dragged.order = offset < rect.height / 2 ? target.order - 1 : target.order + 1;
      }
      saveData(); renderTree();
    }

    function renderTree() {
      const rootContainer = libUI.querySelector('#wa-tlc-tree-root');
      if (!rootContainer) return;
      rootContainer.innerHTML = '';
      let counter = 0;

      function buildNode(parentId, containerElement) {
        const children = libraryData.items.filter(i => i.parentId === parentId).sort((a, b) => a.order - b.order);
        children.forEach(item => {
          if (item.type === 'snippet' && activeTagFilter !== 'All' && !(item.tags || []).includes(activeTagFilter)) return;

          const el = document.createElement('div');
          if (item.type === 'folder') {
            el.className = 'wa-tln-folder-head'; el.draggable = true;
            el.addEventListener('dragstart', (e) => handleDragStart(e, item.id));
            el.addEventListener('dragend', (e) => { e.target.style.opacity = '1'; draggedItem = null; });
            el.addEventListener('dragover', (e) => handleDragOver(e, item.id, 'folder'));
            el.addEventListener('dragleave', (e) => e.currentTarget.classList.remove('wa-tln-drop-top', 'wa-tln-drop-bottom', 'wa-tln-drop-inside'));
            el.addEventListener('drop', (e) => handleDrop(e, item.id, 'folder'));
            el.innerHTML = `<span class="wa-tln-caret ${item.collapsed ? 'collapsed' : ''}">▼</span><span>📁 ${item.name}</span><button class="wa-tln-btn" style="margin-left:auto;" title="Edit/Delete Folder">⚙️</button>`;
            const contentDiv = document.createElement('div');
            contentDiv.className = `wa-tln-folder-content ${item.collapsed ? 'collapsed' : ''}`;
            el.querySelector('.wa-tln-caret').onclick = () => { item.collapsed = !item.collapsed; saveData(); renderTree(); };
            el.querySelector('.wa-tln-btn').onclick = () => {
              const action = prompt(`Edit Folder: "${item.name}"\n\nType a new name to rename it.\nType "DELETE" (all caps) to delete it and its contents.`);
              if (!action) return;
              if (action === 'DELETE') {
                const deleteNodeAndChildren = (id) => { libraryData.items.filter(i => i.parentId === id).forEach(c => deleteNodeAndChildren(c.id)); libraryData.items = libraryData.items.filter(i => i.id !== id); };
                deleteNodeAndChildren(item.id);
              } else { item.name = action.trim(); }
              saveData(); renderTree();
            };
            containerElement.appendChild(el); containerElement.appendChild(contentDiv);
            buildNode(item.id, contentDiv);
          } else {
            counter++;
            el.className = `wa-tln-item ${counter % 2 === 0 ? 'alt-bg' : ''}`;
            el.dataset.id = item.id;
            const tagsHtml = (item.tags || []).map(tid => {
              const t = libraryData.tags.find(x => x.id === tid);
              return t ? `<span class="wa-tln-tag-pill" style="background:${hexToRgba(t.color, 0.2)}; color:${t.color};">${t.name}</span>` : '';
            }).join('');
            const cmdHtml = item.customCommand ? `<span class="wa-tln-cmd-pill">/${item.customCommand}</span>` : '';
            const imgHtml = item.imageId ? `<span class="wa-tln-img-pill" title="Sends with a linked image">🖼️</span>` : '';
            el.innerHTML = `
              <div class="wa-tln-row">
                <span class="wa-tln-drag-grip" draggable="true">⠿</span>
                <div class="wa-tln-title-col">${item.title}</div>
                ${cmdHtml}${imgHtml}
                <div class="wa-tln-tags">${tagsHtml}</div>
                <div class="wa-tln-actions">
                  <button class="wa-tln-btn preview-btn" title="Toggle Text Preview">👁️</button>
                  <button class="wa-tln-btn edit-btn" title="Edit Snippet">✏️</button>
                  <button class="wa-tln-btn send-btn" title="Send now (text${item.imageId ? ' + linked image' : ''})">▶️</button>
                </div>
              </div>
              <div class="wa-tln-preview">${item.text}</div>
            `;
            const grip = el.querySelector('.wa-tln-drag-grip');
            grip.addEventListener('dragstart', (e) => handleDragStart(e, item.id));
            grip.addEventListener('dragend', (e) => { e.target.style.opacity = '1'; draggedItem = null; });
            el.addEventListener('dragover', (e) => handleDragOver(e, item.id, 'snippet'));
            el.addEventListener('dragleave', (e) => e.currentTarget.classList.remove('wa-tln-drop-top', 'wa-tln-drop-bottom', 'wa-tln-drop-inside'));
            el.addEventListener('drop', (e) => handleDrop(e, item.id, 'snippet'));

            // Click = paste only (zero send logic, matches source toolkit)
            el.onclick = (e) => {
              e.stopPropagation();
              if (e.target.tagName === 'BUTTON' || e.target.classList.contains('wa-tln-drag-grip')) return;
              core.injectTextToChat(item.text, false);
              const original = el.style.background;
              el.style.background = 'rgba(37,211,102,0.2)';
              setTimeout(() => { el.style.background = original; }, 200);
            };
            el.querySelector('.preview-btn').onclick = (e) => { e.stopPropagation(); el.querySelector('.wa-tln-preview').classList.toggle('visible'); };
            el.querySelector('.edit-btn').onclick = (e) => { e.stopPropagation(); openSnippetEditor(item); };
            el.querySelector('.send-btn').onclick = async (e) => {
              e.stopPropagation();
              const sendBtn = e.currentTarget;
              sendBtn.disabled = true;
              try {
                if (item.imageId && core.getImageLibrary) {
                  const imgLib = core.getImageLibrary();
                  const imgItem = imgLib.items.find(i => i.id === item.imageId);
                  if (imgItem && core.getSavedImageBlob) {
                    const blob = await core.getSavedImageBlob(imgItem.id);
                    if (blob) { await core.showImagePreview(blob, item.text, imgItem.name); sendBtn.disabled = false; return; }
                  }
                }
                core.injectTextToChat(item.text, true);
              } catch (err) { core.notifyError('Send failed: ' + err.message); }
              sendBtn.disabled = false;
            };

            containerElement.appendChild(el);
          }
        });
      }

      const renderRoot = activeFolderFilter === 'All' ? 'root' : activeFolderFilter;
      buildNode(renderRoot, rootContainer);
      core.emit('tl:tree-rendered', libUI);
    }

    function mountCard(attemptsLeft) {
      attemptsLeft = attemptsLeft === undefined ? 10 : attemptsLeft;
      if (typeof core.registerMenu === 'function') {
        core.registerMenu('left', '📝 Saved Messages', libUI, '⠿', 'text-library-module');
        buildFilterWindow();
        renderTree();
      } else if (attemptsLeft > 0) {
        setTimeout(() => mountCard(attemptsLeft - 1), 200);
      }
    }
    mountCard();
    core.on('imglib:changed', () => renderTree());
    core.emit('block:ready', { id: 'textLibraryModule' });
  }
});

/* ============================================================
   BLOCK: Saved Images (Image Library) (v8)
   ============================================================ */
LegoCore.registerBlock({ 
  id: 'imageLibraryModule', 
  init(core) { 
    const DATA_KEY = 'wa_image_library_v1'; 
    let libraryData = JSON.parse(localStorage.getItem(DATA_KEY)) || { items: [], tags: [] }; 
    function saveData() { localStorage.setItem(DATA_KEY, JSON.stringify(libraryData)); core.emit('imglib:changed', libraryData); } 

    let activeFolderFilter = 'All'; 
    let draggedItem = null; 

    core.getImageLibrary = () => libraryData; 

    function compressImage(file, maxSize, quality) { 
      return new Promise((resolve) => { 
        const reader = new FileReader(); 
        reader.onload = (e) => { 
          const img = new Image(); 
          img.onload = () => { 
            const canvas = document.createElement('canvas'); 
            let w = img.width, h = img.height; 
            if (w > maxSize || h > maxSize) { const ratio = Math.min(maxSize / w, maxSize / h); w *= ratio; h *= ratio; } 
            canvas.width = w; canvas.height = h; 
            canvas.getContext('2d').drawImage(img, 0, 0, w, h); 
            resolve(canvas.toDataURL('image/jpeg', quality)); 
          }; 
          img.src = e.target.result; 
        }; 
        reader.readAsDataURL(file); 
      }); 
    } 

    function saveBlobToDb(id, blob) { 
      const db = core.getDb(); 
      if (!db) return; 
      const tx = db.transaction(['images'], 'readwrite'); 
      tx.objectStore('images').put({ id, blob, order: Date.now() }); 
    } 
    function deleteBlobFromDb(id) { 
      const db = core.getDb(); 
      if (!db) return; 
      const tx = db.transaction(['images'], 'readwrite'); 
      tx.objectStore('images').delete(id); 
    } 
    core.getSavedImageBlob = function (id) { 
      return new Promise((resolve) => { 
        const db = core.getDb(); 
        if (!db) { resolve(null); return; } 
        const tx = db.transaction(['images'], 'readonly'); 
        const req = tx.objectStore('images').get(id); 
        req.onsuccess = () => resolve(req.result ? req.result.blob : null); 
        req.onerror = () => resolve(null); 
      }); 
    }; 

    const libUI = document.createElement('div'); 
    libUI.className = 'wa-tln-container'; 
    libUI.innerHTML = ` 
      <div class="wa-tln-header-btns"> 
        <input type="file" id="wa-ilc-upload-input" accept="image/*" multiple style="display:none;"> 
        <button id="wa-ilc-upload-btn" class="wa-tln-hbtn">📤 Upload</button> 
        <button id="wa-ilc-new-fold" class="wa-tln-hbtn">📁 Fold</button> 
      </div> 
      <div id="wa-ilc-tree-root" class="wa-tln-tree"></div> 
    `; 

    libUI.querySelector('#wa-ilc-new-fold').onclick = () => { 
      const name = prompt('Folder name:'); 
      if (!name || !name.trim()) return; 
      libraryData.items.push({ id: 'ifld_' + Date.now(), type: 'folder', parentId: 'root', name: name.trim(), collapsed: false, order: Date.now() }); 
      saveData(); renderTree(); 
    }; 

    const uploadInput = libUI.querySelector('#wa-ilc-upload-input'); 
    libUI.querySelector('#wa-ilc-upload-btn').onclick = () => uploadInput.click(); 
    uploadInput.onchange = async (e) => { 
      const files = Array.from(e.target.files || []); 
      for (const file of files) { 
        const id = 'img_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7); 
        const thumbnail = await compressImage(file, 200, 0.7); 
        libraryData.items.push({ 
          id, type: 'image', parentId: activeFolderFilter === 'All' ? 'root' : activeFolderFilter, 
          name: file.name.replace(/\.[^/.]+$/, ''), caption: '', tags: [], thumbnail, order: Date.now() 
        }); 
        saveBlobToDb(id, file); 
      } 
      uploadInput.value = ''; 
      saveData(); renderTree(); 
    }; 

    function openImageEditor(item) { 
      const overlay = document.createElement('div'); 
      overlay.className = 'wa-tlp-modal-overlay'; 
      overlay.innerHTML = ` 
        <div class="wa-tlp-modal"> 
          <h3>✏️ Edit Image</h3> 
          <img src="${item.thumbnail}" style="max-height:120px; border-radius:6px; align-self:center;"> 
          <input type="text" id="wa-ilp-name" class="wa-tlp-input" placeholder="Name" value="${(item.name || '').replace(/"/g, '&quot;')}"> 
          <textarea id="wa-ilp-caption" class="wa-tlp-input" placeholder="Message / Link (Optional)" style="margin-top:8px; resize:vertical; min-height:60px; font-family:inherit;">${(item.caption || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</textarea>
          <div class="wa-tlp-row"> 
            <button id="wa-ilp-save" class="wa-base-btn">💾 Save</button> 
            <button id="wa-ilp-cancel" class="wa-hide-btn" style="flex:1;">Cancel</button> 
            <button id="wa-ilp-delete" class="wa-hide-btn" style="flex:1; color:#f87171;">Delete</button> 
          </div> 
        </div> 
      `; 
      document.body.appendChild(overlay); 
      overlay.querySelector('#wa-ilp-cancel').onclick = () => overlay.remove(); 
      overlay.querySelector('#wa-ilp-delete').onclick = () => { 
        if (!confirm('Delete this image?')) return; 
        libraryData.items = libraryData.items.filter(i => i.id !== item.id); 
        deleteBlobFromDb(item.id); 
        saveData(); renderTree(); overlay.remove(); 
      }; 
      overlay.querySelector('#wa-ilp-save').onclick = () => { 
        item.name = overlay.querySelector('#wa-ilp-name').value.trim() || item.name; 
        item.caption = overlay.querySelector('#wa-ilp-caption').value.trim();
        saveData(); renderTree(); overlay.remove(); 
      }; 
    } 

    function handleDragStart(e, id) { draggedItem = id; e.target.style.opacity = '0.4'; e.dataTransfer.effectAllowed = 'move'; } 
    function handleDragOver(e, targetId, targetType) { 
      e.preventDefault(); 
      if (!draggedItem || draggedItem === targetId) return; 
      const rect = e.currentTarget.getBoundingClientRect(); 
      const offset = e.clientY - rect.top; 
      e.currentTarget.classList.remove('wa-tln-drop-top', 'wa-tln-drop-bottom', 'wa-tln-drop-inside'); 
      if (targetType === 'folder' && offset > rect.height * 0.25 && offset < rect.height * 0.75) e.currentTarget.classList.add('wa-tln-drop-inside'); 
      else if (offset < rect.height / 2) e.currentTarget.classList.add('wa-tln-drop-top'); 
      else e.currentTarget.classList.add('wa-tln-drop-bottom'); 
    } 
    function handleDrop(e, targetId, targetType) { 
      e.preventDefault(); 
      e.currentTarget.classList.remove('wa-tln-drop-top', 'wa-tln-drop-bottom', 'wa-tln-drop-inside'); 
      if (!draggedItem || draggedItem === targetId) return; 
      const dragged = libraryData.items.find(i => i.id === draggedItem); 
      const target = libraryData.items.find(i => i.id === targetId); 
      if (!dragged || !target) return; 
      const rect = e.currentTarget.getBoundingClientRect(); 
      const offset = e.clientY - rect.top; 
      if (targetType === 'folder' && offset > rect.height * 0.25 && offset < rect.height * 0.75) dragged.parentId = target.id; 
      else { dragged.parentId = target.parentId; dragged.order = offset < rect.height / 2 ? target.order - 1 : target.order + 1; } 
      saveData(); renderTree(); 
    } 

    function renderTree() { 
      const rootContainer = libUI.querySelector('#wa-ilc-tree-root'); 
      if (!rootContainer) return; 
      rootContainer.innerHTML = ''; 
      let counter = 0; 

      function buildNode(parentId, containerElement) { 
        const children = libraryData.items.filter(i => i.parentId === parentId).sort((a, b) => a.order - b.order); 
        children.forEach(item => { 
          const el = document.createElement('div'); 
          if (item.type === 'folder') { 
            el.className = 'wa-tln-folder-head'; el.draggable = true; 
            el.addEventListener('dragstart', (e) => handleDragStart(e, item.id)); 
            el.addEventListener('dragend', (e) => { e.target.style.opacity = '1'; draggedItem = null; }); 
            el.addEventListener('dragover', (e) => handleDragOver(e, item.id, 'folder')); 
            el.addEventListener('dragleave', (e) => e.currentTarget.classList.remove('wa-tln-drop-top', 'wa-tln-drop-bottom', 'wa-tln-drop-inside')); 
            el.addEventListener('drop', (e) => handleDrop(e, item.id, 'folder')); 
            el.innerHTML = `<span class="wa-tln-caret ${item.collapsed ? 'collapsed' : ''}">▼</span><span>📁 ${item.name}</span><button class="wa-tln-btn" style="margin-left:auto;">⚙️</button>`; 
            const contentDiv = document.createElement('div'); 
            contentDiv.className = `wa-tln-folder-content ${item.collapsed ? 'collapsed' : ''}`; 
            el.querySelector('.wa-tln-caret').onclick = () => { item.collapsed = !item.collapsed; saveData(); renderTree(); }; 
            el.querySelector('.wa-tln-btn').onclick = () => { 
              const action = prompt(`Edit Folder: "${item.name}"\n\nType a new name to rename it.\nType "DELETE" (all caps) to delete it and its contents.`); 
              if (!action) return; 
              if (action === 'DELETE') { 
                const deleteNodeAndChildren = (id) => { 
                  libraryData.items.filter(i => i.parentId === id).forEach(c => { if (c.type === 'image') deleteBlobFromDb(c.id); deleteNodeAndChildren(c.id); }); 
                  libraryData.items = libraryData.items.filter(i => i.id !== id); 
                }; 
                deleteNodeAndChildren(item.id); 
              } else { item.name = action.trim(); } 
              saveData(); renderTree(); 
            }; 
            containerElement.appendChild(el); containerElement.appendChild(contentDiv); 
            buildNode(item.id, contentDiv); 
          } else { 
            counter++; 
            el.className = `wa-tln-item ${counter % 2 === 0 ? 'alt-bg' : ''}`; 
            el.dataset.id = item.id; 
            
            const captionIndicator = item.caption ? '<span style="font-size:10px; margin-left:4px;" title="Includes message">📝</span>' : '';

            el.innerHTML = ` 
              <div class="wa-tln-row"> 
                <span class="wa-tln-drag-grip" draggable="true">⠿</span> 
                <img class="wa-tln-thumb" src="${item.thumbnail}"> 
                <div class="wa-tln-title-col">${item.name}${captionIndicator}</div> 
                <div class="wa-tln-actions"> 
                  <button class="wa-tln-btn edit-btn" title="Edit / Delete">✏️</button> 
                  <button class="wa-tln-btn send-btn" title="Copy to clipboard" style="min-width: 40px;">▶️</button> 
                </div> 
              </div> 
            `; 
            
            const grip = el.querySelector('.wa-tln-drag-grip'); 
            grip.addEventListener('dragstart', (e) => handleDragStart(e, item.id)); 
            grip.addEventListener('dragend', (e) => { e.target.style.opacity = '1'; draggedItem = null; }); 
            el.addEventListener('dragover', (e) => handleDragOver(e, item.id, 'image')); 
            el.addEventListener('dragleave', (e) => e.currentTarget.classList.remove('wa-tln-drop-top', 'wa-tln-drop-bottom', 'wa-tln-drop-inside')); 
            el.addEventListener('drop', (e) => handleDrop(e, item.id, 'image')); 

            el.onclick = (e) => { e.stopPropagation(); }; 
            el.querySelector('.edit-btn').onclick = (e) => { e.stopPropagation(); openImageEditor(item); }; 
            
            el.querySelector('.send-btn').onclick = (e) => {
              e.stopPropagation();
              
              // STEP 1: Find the chat box and immediately inject the text
              const chatInput = document.querySelector('#main footer div[contenteditable="true"]') 
                             || document.querySelector('div[contenteditable="true"][data-tab="10"]')
                             || document.querySelector('div[contenteditable="true"]');
                             
              if (chatInput) {
                chatInput.focus();
                // If there's a caption, simulate a real user typing it into the chat box!
                if (item.caption) {
                  document.execCommand('insertText', false, item.caption);
                }
              }

              // STEP 2: Process the image for the clipboard
              const getPngBlobPromise = async () => {
                const blob = await core.getSavedImageBlob(item.id);
                if (!blob) throw new Error('Image not found');
                return new Promise((resolve, reject) => {
                  const img = new Image();
                  const url = URL.createObjectURL(blob);
                  img.onload = () => {
                    URL.revokeObjectURL(url);
                    const canvas = document.createElement('canvas');
                    canvas.width = img.width;
                    canvas.height = img.height;
                    canvas.getContext('2d').drawImage(img, 0, 0);
                    canvas.toBlob(pngBlob => {
                      if (pngBlob) resolve(pngBlob);
                      else reject(new Error('Canvas conversion failed'));
                    }, 'image/png');
                  };
                  img.onerror = () => reject(new Error('Failed to load image'));
                  img.src = url;
                });
              };

              try {
                // We ONLY copy the image to the clipboard now.
                navigator.clipboard.write([
                  new ClipboardItem({ 'image/png': getPngBlobPromise() })
                ]).then(() => {
                  const btn = el.querySelector('.send-btn');
                  const originalContent = btn.innerHTML;
                  btn.innerText = '✅ Copiado';
                  
                  setTimeout(() => btn.innerHTML = originalContent, 1500);
                  
                  if (!chatInput && core.notifyError) {
                    core.notifyError('Copied! Please open a chat to paste.');
                  }
                  
                }).catch(err => {
                  console.error('Clipboard write failed:', err);
                  if (core.notifyError) core.notifyError('Copy failed. Ensure your browser permits clipboard access.');
                });
              } catch (err) {
                console.error('ClipboardItem error:', err);
                if (core.notifyError) core.notifyError('Copy blocked by browser permissions.');
              }
            };

            containerElement.appendChild(el); 
          } 
        }); 
      } 

      const renderRoot = activeFolderFilter === 'All' ? 'root' : activeFolderFilter; 
      buildNode(renderRoot, rootContainer); 
      core.emit('il:tree-rendered', libUI); 
    } 

    function mountCard(attemptsLeft) { 
      attemptsLeft = attemptsLeft === undefined ? 10 : attemptsLeft; 
      if (typeof core.registerMenu === 'function') { 
        core.registerMenu('left', '🖼️ Saved Images', libUI, '⠿', 'image-library-module'); 
        renderTree(); 
      } else if (attemptsLeft > 0) { 
        setTimeout(() => mountCard(attemptsLeft - 1), 200); 
      } 
    } 
    mountCard(); 
    core.emit('block:ready', { id: 'imageLibraryModule' }); 
  } 
});

/* ============================================================
   BLOCK: Message Sequence Builder (v9)
   ============================================================ */
/* ============================================================
   BLOCK: Secuencias de Mensajes (v9.2 — lista simple con carpetas, tú presionas Enter)
   ------------------------------------------------------------
   REEMPLAZA a "Message Sequence Builder (v8)". Usa los mismos datos
   guardados (wa_sequences_v1), así que tus secuencias siguen ahí.

   CÓMO FUNCIONA
   - ▶ en una secuencia: el primer paso se CARGA en el chat abierto
     (texto en la caja de mensaje; imagen/video en la vista previa de
     WhatsApp con su texto). Nunca se envía solo.
   - Tú presionas Enter. Cuando WhatsApp realmente envió el mensaje,
     se carga el siguiente paso. Así hasta el final.
   - Barra inferior: "2 / 4 · Enter ↵" + Saltar + ■ Detener.
   - Carpetas: 📁 Carpeta crea una; arrastra ⠿ (aparece al pasar el
     mouse) para meter una secuencia en una carpeta; clic en la carpeta
     la abre/cierra; ⚙️ renombra o BORRAR (las secuencias pasan afuera).
   - Si cambias de chat a mitad de camino, la secuencia se detiene.
   - Ya no hay temporizadores ni "Auto-Send" (las esperas antiguas
     se eliminan al abrir).

   NECESITA (ya están en tu kit):
   - Saved Messages  (core.getTextLibrary)
   - Saved Images    (core.getImageLibrary / core.getSavedImageBlob)
   - Saved Videos    (core.getVideoLibrary / core.getSavedVideoBlob) — opcional
   ============================================================ */
LegoCore.registerBlock({
  id: 'sequenceBuilderModule',
  init(core) {
    const STORAGE_KEY = 'wa_sequences_v1';
    const METHOD_KEY = 'wa_seq_attach_method';
    const DEBUG = true;

    // ---------------- Selectores de WhatsApp (ajustar si cambian) ----------------
    const SEL = {
      composer: ['#main footer [contenteditable="true"][role="textbox"]', '#main footer [contenteditable="true"]', 'footer [contenteditable="true"]'],
      attachBtn: ['[data-icon="plus-rounded"]', '[data-icon="plus"]', '[data-icon="attach-menu-plus"]', '[data-icon="clip"]', '[aria-label="Attach"]', '[aria-label="Adjuntar"]', '[title="Attach"]', '[title="Adjuntar"]'],
      sendBtn: ['[data-icon="wds-ic-send-filled"]', '[data-icon="send"]', '[aria-label="Send"]', '[aria-label="Enviar"]'],
      chatTitle: ['#main header span[title]', '#main header [dir="auto"]']
    };

    // ---------------- Helpers ----------------
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const log = (...a) => { if (DEBUG) console.log('[secuencias]', ...a); };
    const notify = msg => { if (core.notifyError) core.notifyError(msg); else alert(msg); };
    const isVisible = el => !!el && el.isConnected && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    // UI del kit (no de WhatsApp). #wa-popovers-bucket es de WhatsApp aunque empiece con "wa-".
    const isOurUI = el => {
      if (!el) return false;
      if (el.closest('#wa-popovers-bucket')) return false;
      return !!el.closest('.wa-tln-container, .wa-tlp-modal-overlay, #wa-sq-bar, [class^="wa-"], [id^="wa-"]');
    };
    const clickable = el => el.closest('button, [role="button"]') || el;
    const qVisible = (list, filter = () => true) => {
      for (const s of list) {
        const el = [...document.querySelectorAll(s)].find(e => isVisible(e) && filter(e));
        if (el) return el;
      }
      return null;
    };
    const fold = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

    // ---------------- Datos ----------------
    let data;
    try { data = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; } catch (e) { data = {}; }
    if (!Array.isArray(data.list)) data.list = [];
    if (!Array.isArray(data.folders)) data.folders = []; // [{ id, name, collapsed, parentId, order }]
    data.list.forEach((s, i) => {
      if (!s.parentId) s.parentId = 'root';
      if (typeof s.order !== 'number') s.order = i;
    });
    // Sin temporizadores: se eliminan las esperas antiguas
    data.list.forEach(s => { s.steps = (s.steps || []).filter(st => st.type !== 'wait'); });
    function save() { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); }
    save();

    const libs = () => ({
      text: core.getTextLibrary ? core.getTextLibrary() : { items: [] },
      img: core.getImageLibrary ? core.getImageLibrary() : { items: [] },
      vid: core.getVideoLibrary ? core.getVideoLibrary() : { items: [] }
    });

    // Qué muestra cada paso: { label, icon, missing }
    function describe(step) {
      const { text, img, vid } = libs();
      if (step.type === 'snippet') {
        const s = (text.items || []).find(i => i.id === step.snippetId);
        return s ? { label: s.title || 'Sin título', icon: s.imageId ? '🖼' : '' } : { label: '(mensaje borrado)', icon: '⚠️', missing: true };
      }
      if (step.type === 'image') {
        const s = (img.items || []).find(i => i.id === step.imageId);
        return s ? { label: s.name || 'Imagen', icon: '🖼' } : { label: '(imagen borrada)', icon: '⚠️', missing: true };
      }
      if (step.type === 'video') {
        const s = (vid.items || []).find(i => i.id === step.videoId);
        return s ? { label: s.name || 'Video', icon: '🎬' } : { label: '(video borrado)', icon: '⚠️', missing: true };
      }
      return { label: '?', icon: '⚠️', missing: true };
    }

    // ---------------- Estilos ----------------
    const style = document.createElement('style');
    style.id = 'wa-sq-styles';
    style.textContent = `
      .wa-sq { display:flex; flex-direction:column; gap:6px; font-family:-apple-system,sans-serif; font-size:12px; color:var(--igls-text,#e2e8f0); }
      .wa-sq-empty { font-size:11px; color:var(--igls-text-dim,#94a3b8); text-align:center; padding:14px 6px; }
      .wa-sq-list { display:flex; flex-direction:column; }

      .wa-sq-row { display:flex; align-items:center; gap:8px; padding:8px 6px; border-radius:6px; cursor:pointer; min-height:20px; }
      .wa-sq-row:hover { background:rgba(255,255,255,.05); }
      .wa-sq-row + .wa-sq-row { border-top:1px solid rgba(255,255,255,.05); }
      .wa-sq-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .wa-sq-play { flex-shrink:0; width:26px; height:26px; border-radius:50%; border:none; cursor:pointer; font-size:11px;
        background:rgba(37,211,102,.15); color:var(--wat-accent,#25d366); display:flex; align-items:center; justify-content:center; }
      .wa-sq-play:hover { background:var(--wat-accent,#25d366); color:#06210f; }
      .wa-sq-play.stop { background:rgba(248,113,113,.15); color:#f87171; }
      .wa-sq-prog { font-size:10.5px; color:var(--wat-accent,#25d366); font-weight:700; }
      .wa-sq-row .wa-sq-grip, .wa-sq-fold .wa-sq-grip { display:inline-block; visibility:hidden; width:12px; margin-left:-4px; }
      .wa-sq-row:hover .wa-sq-grip, .wa-sq-fold:hover .wa-sq-grip { visibility:visible; }
      .wa-sq-fold { display:flex; align-items:center; gap:6px; cursor:pointer; }
      .wa-sq-fold .wa-sq-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .wa-sq-hover { display:none; gap:2px; }
      .wa-sq-fold:hover .wa-sq-hover { display:flex; }
      .wa-sq-count { font-size:10.5px; color:var(--igls-text-dim,#64748b); }
      .wa-tln-folder-content > .wa-sq-row { padding-left:18px; }
      .wa-sq-row.wa-tln-drop-top, .wa-sq-fold.wa-tln-drop-top { box-shadow:inset 0 2px 0 var(--wat-accent,#25d366); }
      .wa-sq-row.wa-tln-drop-bottom, .wa-sq-fold.wa-tln-drop-bottom { box-shadow:inset 0 -2px 0 var(--wat-accent,#25d366); }
      .wa-sq-fold.wa-tln-drop-inside { background:rgba(37,211,102,.12); }

      .wa-sq-top { display:flex; align-items:center; gap:6px; }
      .wa-sq-back, .wa-sq-more { background:none; border:none; color:var(--igls-text-dim,#94a3b8); cursor:pointer; font-size:14px; padding:4px 6px; border-radius:5px; }
      .wa-sq-back:hover, .wa-sq-more:hover { color:var(--igls-text,#e2e8f0); background:rgba(255,255,255,.06); }
      .wa-sq-title { flex:1; min-width:0; font-weight:700; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .wa-sq-menu { display:flex; gap:4px; }
      .wa-sq-menu button { flex:1; background:rgba(255,255,255,.05); border:1px solid rgba(255,255,255,.08); color:var(--igls-text,#e2e8f0); border-radius:6px; padding:5px; font-size:11px; cursor:pointer; }
      .wa-sq-menu button:hover { background:rgba(255,255,255,.1); }
      .wa-sq-menu button.danger { color:#f87171; }

      .wa-sq-step { display:flex; align-items:center; gap:8px; padding:7px 6px; border-radius:6px; position:relative; }
      .wa-sq-step + .wa-sq-step { border-top:1px solid rgba(255,255,255,.05); }
      .wa-sq-step:hover { background:rgba(255,255,255,.04); }
      .wa-sq-step.current { background:rgba(37,211,102,.08); box-shadow:inset 3px 0 0 var(--wat-accent,#25d366); }
      .wa-sq-step.missing .wa-sq-name { color:#f59e0b; }
      .wa-sq-num { width:16px; text-align:right; color:var(--igls-text-dim,#64748b); font-size:11px; flex-shrink:0; }
      .wa-sq-grip { display:none; width:16px; text-align:center; cursor:grab; color:var(--igls-text-dim,#64748b); flex-shrink:0; }
      .wa-sq-step:hover .wa-sq-grip { display:inline-block; }
      .wa-sq-step:hover .wa-sq-num { display:none; }
      .wa-sq-icon { flex-shrink:0; font-size:11px; }
      .wa-sq-del { display:none; background:none; border:none; color:var(--igls-text-dim,#94a3b8); cursor:pointer; font-size:12px; padding:0 2px; }
      .wa-sq-del:hover { color:#f87171; }
      .wa-sq-step:hover .wa-sq-del { display:inline-block; }
      .wa-sq-step.drop-top { box-shadow:inset 0 2px 0 var(--wat-accent,#25d366); }
      .wa-sq-step.drop-bottom { box-shadow:inset 0 -2px 0 var(--wat-accent,#25d366); }

      .wa-sq-add { background:none; border:1px dashed rgba(255,255,255,.15); color:var(--igls-text-dim,#94a3b8); border-radius:6px; padding:7px; cursor:pointer; font-size:12px; }
      .wa-sq-add:hover { color:var(--igls-text,#e2e8f0); border-color:rgba(255,255,255,.3); }

      .wa-sq-picker { display:flex; flex-direction:column; gap:6px; border:1px solid rgba(255,255,255,.1); border-radius:8px; padding:8px; background:rgba(0,0,0,.15); }
      .wa-sq-tabs { display:flex; gap:4px; }
      .wa-sq-tab { flex:1; background:none; border:none; border-bottom:2px solid transparent; color:var(--igls-text-dim,#94a3b8); padding:4px; font-size:11px; cursor:pointer; }
      .wa-sq-tab.active { color:var(--igls-text,#e2e8f0); border-bottom-color:var(--wat-accent,#25d366); font-weight:700; }
      .wa-sq-search { width:100%; box-sizing:border-box; background:rgba(255,255,255,.05); border:1px solid rgba(255,255,255,.1); color:var(--igls-text,#e2e8f0); border-radius:6px; padding:6px 8px; font-size:12px; outline:none; }
      .wa-sq-search:focus { border-color:var(--wat-accent,#25d366); }
      .wa-sq-results { max-height:220px; overflow-y:auto; display:flex; flex-direction:column; }
      .wa-sq-folder { font-size:10px; color:var(--igls-text-dim,#64748b); padding:6px 4px 2px; }
      .wa-sq-pick { padding:6px 6px; border-radius:5px; cursor:pointer; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .wa-sq-pick:hover { background:rgba(37,211,102,.12); }

      #wa-sq-bar { position:fixed; left:50%; bottom:96px; transform:translateX(-50%); z-index:2147483647; display:flex; align-items:center; gap:10px;
        background:#111b21; color:#e9edef; border:1px solid rgba(255,255,255,.12); border-radius:24px; padding:8px 8px 8px 16px;
        font-family:-apple-system,sans-serif; font-size:13px; box-shadow:0 8px 24px rgba(0,0,0,.45); max-width:90vw; }
      #wa-sq-bar .count { font-weight:800; color:var(--wat-accent,#25d366); }
      #wa-sq-bar .msg { white-space:nowrap; }
      #wa-sq-bar .key { display:inline-block; border:1px solid rgba(255,255,255,.3); border-radius:4px; padding:0 5px; font-size:11px; margin-left:2px; }
      #wa-sq-bar button { background:rgba(255,255,255,.08); border:none; color:#e9edef; border-radius:16px; padding:5px 11px; font-size:12px; cursor:pointer; }
      #wa-sq-bar button:hover { background:rgba(255,255,255,.16); }
      #wa-sq-bar button.stop { color:#f87171; }
      #wa-sq-bar.warn { border-color:#f59e0b; }
      #wa-sq-bar.done { border-color:var(--wat-accent,#25d366); }
    `;
    if (!document.getElementById('wa-sq-styles')) document.head.appendChild(style);

    // ---------------- UI ----------------
    const ui = document.createElement('div');
    ui.className = 'wa-tln-container wa-sq';
    let view = { name: 'home', seqId: null, menu: false, picker: null };
    // picker: null | { tab: 'text'|'img'|'vid', query: '' }

    function render() {
      ui.innerHTML = '';
      if (view.name === 'edit' && data.list.some(s => s.id === view.seqId)) renderEdit();
      else { view = { name: 'home', seqId: null, menu: false, picker: null }; renderHome(); }
    }

    function playButton(seq) {
      const b = document.createElement('button');
      const running = run && run.seqId === seq.id;
      b.className = 'wa-sq-play' + (running ? ' stop' : '');
      b.textContent = running ? '■' : '▶';
      b.title = running ? 'Detener' : 'Cargar en el chat abierto';
      b.onclick = e => { e.stopPropagation(); running ? stopRun('Detenida.') : startRun(seq); };
      return b;
    }

    // ---------------- Inicio: carpetas + secuencias ----------------
    const findFolder = id => data.folders.find(f => f.id === id);
    const parentOf = it => (it.parentId && it.parentId !== 'root' && findFolder(it.parentId)) ? it.parentId : 'root';
    function isInside(folderId, ancestorId) {
      let cur = findFolder(folderId), guard = 0;
      while (cur && guard++ < 50) { if (cur.id === ancestorId) return true; cur = findFolder(parentOf(cur)); }
      return false;
    }
    const countIn = folderId => data.list.filter(s => { const p = parentOf(s); return p === folderId || (p !== 'root' && isInside(p, folderId)); }).length;

    let homeDrag = null; // { kind: 'seq'|'fld', id }
    function homeDropHandlers(el, target) {
      // target: { kind, item }
      const zone = e => {
        const r = el.getBoundingClientRect(), off = e.clientY - r.top;
        if (target.kind === 'fld' && off > r.height * 0.25 && off < r.height * 0.75) return 'inside';
        return off < r.height / 2 ? 'top' : 'bottom';
      };
      const clear = () => el.classList.remove('wa-tln-drop-top', 'wa-tln-drop-bottom', 'wa-tln-drop-inside');
      el.addEventListener('dragover', e => {
        if (!homeDrag || homeDrag.id === target.item.id) return;
        e.preventDefault();
        clear();
        el.classList.add('wa-tln-drop-' + zone(e));
      });
      el.addEventListener('dragleave', clear);
      el.addEventListener('drop', e => {
        e.preventDefault();
        clear();
        if (!homeDrag || homeDrag.id === target.item.id) return;
        const moving = homeDrag.kind === 'seq' ? data.list.find(s => s.id === homeDrag.id) : findFolder(homeDrag.id);
        if (!moving) return;
        const z = zone(e);
        const newParent = z === 'inside' ? target.item.id : parentOf(target.item);
        // Una carpeta no puede ir dentro de sí misma
        if (homeDrag.kind === 'fld' && newParent !== 'root' && (newParent === moving.id || isInside(newParent, moving.id))) return;
        moving.parentId = newParent;
        moving.order = z === 'inside' ? Date.now() : target.item.order + (z === 'top' ? -0.5 : 0.5);
        if (z === 'inside') target.item.collapsed = false;
        homeDrag = null;
        save(); render();
      });
    }
    function makeGrip(kind, item, rowEl) {
      const g = document.createElement('span');
      g.className = 'wa-sq-grip';
      g.textContent = '⠿';
      g.title = 'Arrastra para mover / meter en carpeta';
      g.draggable = true;
      g.addEventListener('click', e => e.stopPropagation());
      g.addEventListener('dragstart', e => {
        homeDrag = { kind, id: item.id };
        rowEl.style.opacity = '0.4';
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', item.id); } catch (err) { /* ignore */ }
      });
      g.addEventListener('dragend', () => { rowEl.style.opacity = ''; homeDrag = null; });
      return g;
    }

    function newSequence(parentId) {
      const name = (prompt('Nombre de la secuencia:') || '').trim();
      if (!name) return;
      const seq = { id: 'seq_' + Date.now(), name, steps: [], parentId, order: Date.now() };
      data.list.push(seq);
      if (parentId !== 'root') { const f = findFolder(parentId); if (f) f.collapsed = false; }
      save();
      view = { name: 'edit', seqId: seq.id, menu: false, picker: { tab: 'text', query: '' } };
      render();
    }

    function renderHome() {
      const head = document.createElement('div');
      head.className = 'wa-tln-header-btns';
      head.innerHTML = '<button class="wa-tln-hbtn" data-a="seq">＋ Nueva</button><button class="wa-tln-hbtn" data-a="fld">📁 Carpeta</button>';
      head.querySelector('[data-a="seq"]').onclick = () => newSequence('root');
      head.querySelector('[data-a="fld"]').onclick = () => {
        const name = (prompt('Nombre de la carpeta:') || '').trim();
        if (!name) return;
        data.folders.push({ id: 'sqf_' + Date.now(), name, collapsed: false, parentId: 'root', order: Date.now() });
        save(); render();
      };
      ui.appendChild(head);

      if (!data.list.length && !data.folders.length) {
        const empty = document.createElement('div');
        empty.className = 'wa-sq-empty';
        empty.textContent = 'Aún no hay secuencias.';
        ui.appendChild(empty);
        return;
      }

      const tree = document.createElement('div');
      tree.className = 'wa-sq-list';
      ui.appendChild(tree);

      (function build(parentId, container) {
        const children = [
          ...data.folders.filter(f => parentOf(f) === parentId).map(item => ({ kind: 'fld', item })),
          ...data.list.filter(s => parentOf(s) === parentId).map(item => ({ kind: 'seq', item }))
        ].sort((a, b) => a.item.order - b.item.order);

        children.forEach(({ kind, item }) => {
          if (kind === 'fld') {
            const headEl = document.createElement('div');
            headEl.className = 'wa-tln-folder-head wa-sq-fold';
            headEl.innerHTML = '<span class="wa-tln-caret">▼</span><span class="wa-sq-name"></span><span class="wa-sq-hover"><button class="wa-tln-btn" data-a="add" title="Nueva secuencia aquí">＋</button><button class="wa-tln-btn" data-a="edit" title="Renombrar / eliminar">⚙️</button></span>';
            if (item.collapsed) headEl.querySelector('.wa-tln-caret').classList.add('collapsed');
            headEl.querySelector('.wa-sq-name').textContent = `📁 ${item.name}`;
            headEl.insertBefore(makeGrip('fld', item, headEl), headEl.firstChild);
            const content = document.createElement('div');
            content.className = 'wa-tln-folder-content' + (item.collapsed ? ' collapsed' : '');
            if (item.collapsed) content.style.display = 'none';

            headEl.onclick = e => {
              if (e.target.closest('button')) return;
              item.collapsed = !item.collapsed; save(); render();
            };
            headEl.querySelector('[data-a="add"]').onclick = e => { e.stopPropagation(); newSequence(item.id); };
            headEl.querySelector('[data-a="edit"]').onclick = e => {
              e.stopPropagation();
              const action = prompt(`Carpeta: "${item.name}"\n\nEscribe un nombre nuevo para renombrarla.\nEscribe BORRAR para eliminar la carpeta (las secuencias NO se borran, pasan afuera).`);
              if (!action || !action.trim()) return;
              if (action.trim() === 'BORRAR') {
                const up = parentOf(item);
                data.list.forEach(s => { if (s.parentId === item.id) s.parentId = up; });
                data.folders.forEach(f => { if (f.parentId === item.id) f.parentId = up; });
                data.folders = data.folders.filter(f => f !== item);
              } else item.name = action.trim();
              save(); render();
            };
            homeDropHandlers(headEl, { kind: 'fld', item });
            // Muestra el número de secuencias solo si la carpeta está cerrada
            if (item.collapsed) {
              const n = countIn(item.id);
              if (n) { const c = document.createElement('span'); c.className = 'wa-sq-count'; c.textContent = n; headEl.querySelector('.wa-sq-name').after(c); }
            }
            container.appendChild(headEl);
            container.appendChild(content);
            build(item.id, content);
            return;
          }

          const seq = item;
          const row = document.createElement('div');
          row.className = 'wa-sq-row';
          row.title = 'Abrir';
          row.appendChild(makeGrip('seq', seq, row));
          const name = document.createElement('span');
          name.className = 'wa-sq-name';
          name.textContent = seq.name;
          row.appendChild(name);
          if (run && run.seqId === seq.id) {
            const p = document.createElement('span');
            p.className = 'wa-sq-prog';
            p.textContent = `${run.idx + 1}/${run.steps.length}`;
            row.appendChild(p);
          }
          row.appendChild(playButton(seq));
          row.onclick = () => { view = { name: 'edit', seqId: seq.id, menu: false, picker: null }; render(); };
          homeDropHandlers(row, { kind: 'seq', item: seq });
          container.appendChild(row);
        });
      })('root', tree);
    }

    function renderEdit() {
      const seq = data.list.find(s => s.id === view.seqId);

      // Barra superior: ← nombre ▶ ⋯
      const top = document.createElement('div');
      top.className = 'wa-sq-top';
      top.innerHTML = '<button class="wa-sq-back" title="Volver">←</button><span class="wa-sq-title"></span>';
      top.querySelector('.wa-sq-title').textContent = seq.name;
      top.querySelector('.wa-sq-back').onclick = () => { view = { name: 'home' }; render(); };
      top.appendChild(playButton(seq));
      const more = document.createElement('button');
      more.className = 'wa-sq-more';
      more.textContent = '⋯';
      more.title = 'Más opciones';
      more.onclick = () => { view.menu = !view.menu; render(); };
      top.appendChild(more);
      ui.appendChild(top);

      if (view.menu) {
        const menu = document.createElement('div');
        menu.className = 'wa-sq-menu';
        menu.innerHTML = '<button data-a="ren">Renombrar</button><button data-a="dup">Duplicar</button><button data-a="del" class="danger">Eliminar</button>';
        menu.querySelector('[data-a="ren"]').onclick = () => {
          const name = (prompt('Nuevo nombre:', seq.name) || '').trim();
          if (name) { seq.name = name; save(); }
          view.menu = false; render();
        };
        menu.querySelector('[data-a="dup"]').onclick = () => {
          const copy = { id: 'seq_' + Date.now(), name: seq.name + ' (copia)', steps: JSON.parse(JSON.stringify(seq.steps)), parentId: seq.parentId || 'root', order: (seq.order || 0) + 0.5 };
          data.list.splice(data.list.indexOf(seq) + 1, 0, copy);
          save();
          view = { name: 'edit', seqId: copy.id, menu: false, picker: null };
          render();
        };
        menu.querySelector('[data-a="del"]').onclick = () => {
          if (!confirm(`¿Eliminar "${seq.name}"?`)) return;
          if (run && run.seqId === seq.id) stopRun('Detenida.');
          data.list = data.list.filter(s => s !== seq);
          save();
          view = { name: 'home' }; render();
        };
        ui.appendChild(menu);
      }

      // Pasos
      const list = document.createElement('div');
      list.className = 'wa-sq-list';
      if (!seq.steps.length) {
        const empty = document.createElement('div');
        empty.className = 'wa-sq-empty';
        empty.textContent = 'Sin pasos todavía.';
        list.appendChild(empty);
      }
      seq.steps.forEach((step, idx) => {
        const d = describe(step);
        const row = document.createElement('div');
        const isCurrent = run && run.seqId === seq.id && run.idx === idx;
        row.className = 'wa-sq-step' + (isCurrent ? ' current' : '') + (d.missing ? ' missing' : '');
        row.innerHTML = '<span class="wa-sq-num"></span><span class="wa-sq-grip" draggable="true" title="Arrastra para mover">⠿</span><span class="wa-sq-name"></span><span class="wa-sq-icon"></span><button class="wa-sq-del" title="Quitar">✕</button>';
        row.querySelector('.wa-sq-num').textContent = idx + 1;
        row.querySelector('.wa-sq-name').textContent = d.label;
        row.querySelector('.wa-sq-icon').textContent = d.icon;
        row.querySelector('.wa-sq-del').onclick = () => {
          if (run && run.seqId === seq.id) { notify('Detén la secuencia antes de editarla.'); return; }
          seq.steps.splice(idx, 1); save(); render();
        };

        // Arrastrar para reordenar
        const grip = row.querySelector('.wa-sq-grip');
        grip.addEventListener('dragstart', e => {
          dragIdx = idx; row.style.opacity = '0.4';
          e.dataTransfer.effectAllowed = 'move';
          try { e.dataTransfer.setData('text/plain', String(idx)); } catch (err) { /* ignore */ }
        });
        grip.addEventListener('dragend', () => { row.style.opacity = ''; dragIdx = null; });
        row.addEventListener('dragover', e => {
          if (dragIdx === null) return;
          e.preventDefault();
          const r = row.getBoundingClientRect();
          const above = e.clientY - r.top < r.height / 2;
          row.classList.toggle('drop-top', above);
          row.classList.toggle('drop-bottom', !above);
        });
        row.addEventListener('dragleave', () => row.classList.remove('drop-top', 'drop-bottom'));
        row.addEventListener('drop', e => {
          e.preventDefault();
          row.classList.remove('drop-top', 'drop-bottom');
          if (dragIdx === null || dragIdx === idx) return;
          if (run && run.seqId === seq.id) { notify('Detén la secuencia antes de editarla.'); return; }
          const r = row.getBoundingClientRect();
          const above = e.clientY - r.top < r.height / 2;
          const [moved] = seq.steps.splice(dragIdx, 1);
          let to = idx + (above ? 0 : 1);
          if (dragIdx < idx) to--;
          seq.steps.splice(to, 0, moved);
          dragIdx = null;
          save(); render();
        });
        list.appendChild(row);
      });
      ui.appendChild(list);

      if (view.picker) ui.appendChild(renderPicker(seq));
      else {
        const add = document.createElement('button');
        add.className = 'wa-sq-add';
        add.textContent = '＋ Agregar paso';
        add.onclick = () => { view.picker = { tab: 'text', query: '' }; render(); };
        ui.appendChild(add);
      }
    }
    let dragIdx = null;

    // ---------------- Selector de pasos (Mensajes · Imágenes · Videos) ----------------
    function folderPath(items, parentId) {
      const parts = [];
      let cur = items.find(i => i.type === 'folder' && i.id === parentId);
      let guard = 0;
      while (cur && guard++ < 20) {
        parts.unshift(cur.name);
        cur = items.find(i => i.type === 'folder' && i.id === cur.parentId);
      }
      return parts.join(' / ');
    }

    function renderPicker(seq) {
      const { text, img, vid } = libs();
      const tabs = [
        { key: 'text', label: 'Mensajes', items: (text.items || []), type: 'snippet', name: i => i.title, all: text.items || [] },
        { key: 'img', label: 'Imágenes', items: (img.items || []), type: 'image', name: i => i.name, all: img.items || [] }
      ];
      if (core.getVideoLibrary) tabs.push({ key: 'vid', label: 'Videos', items: (vid.items || []), type: 'video', name: i => i.name, all: vid.items || [] });
      const tab = tabs.find(t => t.key === view.picker.tab) || tabs[0];

      const box = document.createElement('div');
      box.className = 'wa-sq-picker';

      const tabRow = document.createElement('div');
      tabRow.className = 'wa-sq-tabs';
      tabs.forEach(t => {
        const b = document.createElement('button');
        b.className = 'wa-sq-tab' + (t === tab ? ' active' : '');
        b.textContent = t.label;
        b.onclick = () => { view.picker.tab = t.key; render(); };
        tabRow.appendChild(b);
      });
      const close = document.createElement('button');
      close.className = 'wa-sq-back';
      close.textContent = '✕';
      close.title = 'Cerrar';
      close.onclick = () => { view.picker = null; render(); };
      tabRow.appendChild(close);
      box.appendChild(tabRow);

      const search = document.createElement('input');
      search.className = 'wa-sq-search';
      search.placeholder = 'Buscar…';
      search.value = view.picker.query;
      box.appendChild(search);

      const results = document.createElement('div');
      results.className = 'wa-sq-results';
      box.appendChild(results);

      function fill() {
        results.innerHTML = '';
        const q = fold(view.picker.query.trim());
        const entries = tab.items
          .filter(i => i.type === tab.type)
          .filter(i => !q || fold(tab.name(i)).includes(q))
          .map(i => ({ item: i, path: folderPath(tab.all, i.parentId) }))
          .sort((a, b) => a.path.localeCompare(b.path) || (a.item.order || 0) - (b.item.order || 0));
        if (!entries.length) {
          const e = document.createElement('div');
          e.className = 'wa-sq-empty';
          e.textContent = q ? 'Nada coincide.' : 'Esta biblioteca está vacía.';
          results.appendChild(e);
          return;
        }
        let lastPath = null;
        entries.forEach(({ item, path }) => {
          if (path !== lastPath) {
            if (path) {
              const f = document.createElement('div');
              f.className = 'wa-sq-folder';
              f.textContent = '📁 ' + path;
              results.appendChild(f);
            }
            lastPath = path;
          }
          const p = document.createElement('div');
          p.className = 'wa-sq-pick';
          p.textContent = tab.name(item) || '(sin nombre)';
          p.onclick = () => {
            if (run && run.seqId === seq.id) { notify('Detén la secuencia antes de editarla.'); return; }
            const step = tab.type === 'snippet' ? { type: 'snippet', snippetId: item.id }
              : tab.type === 'image' ? { type: 'image', imageId: item.id }
              : { type: 'video', videoId: item.id };
            seq.steps.push(step);
            save();
            view.picker = null;
            render();
          };
          results.appendChild(p);
        });
      }
      fill();
      search.addEventListener('input', () => { view.picker.query = search.value; fill(); });
      search.addEventListener('keydown', e => { if (e.key === 'Escape') { view.picker = null; render(); } });
      setTimeout(() => search.focus(), 0);
      return box;
    }

    // ================= WhatsApp: cargar pasos =================
    const findComposer = () => qVisible(SEL.composer, e => !isOurUI(e));
    const composerText = () => { const c = findComposer(); return c ? (c.textContent || '').trim() : ''; };
    const findPreviewSendBtn = () => qVisible(SEL.sendBtn, e => !e.closest('#main footer') && !isOurUI(e));
    const visibleEditables = () => new Set([...document.querySelectorAll('[contenteditable="true"]')].filter(isVisible));
    const visibleSendBtns = () => new Set(SEL.sendBtn.flatMap(s => [...document.querySelectorAll(s)]).filter(isVisible));

    function chatKey() {
      const el = qVisible(SEL.chatTitle);
      return el ? (el.getAttribute('title') || el.textContent || '').trim() : (document.querySelector('#main') ? '#main' : '');
    }

    // Último mensaje SALIENTE del chat (para saber cuándo WhatsApp realmente envió)
    function lastOutgoing() {
      const els = document.querySelectorAll('#main [data-id^="true_"], #main .message-out');
      if (!els.length) return null;
      const el = els[els.length - 1];
      return (el.getAttribute('data-id') || (el.closest('[data-id]') && el.closest('[data-id]').getAttribute('data-id'))) || el;
    }

    async function loadText(text) {
      const before = composerText();
      if (core.injectTextToChat) core.injectTextToChat(text, false);
      else {
        const box = findComposer();
        if (!box) return false;
        box.focus();
        await sleep(60);
        document.execCommand('insertText', false, text);
      }
      // Confirma que el texto quedó en la caja
      const t0 = Date.now();
      while (Date.now() - t0 < 1500) {
        if (composerText() && composerText() !== before) return true;
        await sleep(100);
      }
      return !!composerText();
    }

    function clearComposer() {
      const box = findComposer();
      if (!box) return;
      box.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
    }

    function pressEscape() {
      const opts = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true };
      (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', opts));
    }

    // --- adjuntar archivo (mismo método que el bloque de videos: pegar → menú → arrastrar) ---
    function makeDT(file) { const dt = new DataTransfer(); dt.items.add(file); return dt; }

    async function viaPaste(file) {
      const box = findComposer();
      if (!box) return null;
      box.focus();
      await sleep(80);
      const dt = makeDT(file);
      let ev;
      try { ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }); } catch (e) { ev = null; }
      if (!ev || !ev.clipboardData || !ev.clipboardData.files || !ev.clipboardData.files.length) {
        ev = new Event('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'clipboardData', { value: dt });
      }
      box.dispatchEvent(ev);
      return () => {};
    }
    function findMediaInput(file) {
      const want = file.type.startsWith('video') ? /video/ : /image/;
      return [...document.querySelectorAll('input[type="file"]')].find(i => want.test(i.accept || '') && !isOurUI(i));
    }
    async function viaInput(file) {
      let input = findMediaInput(file);
      if (!input) {
        const btn = qVisible(SEL.attachBtn, e => !isOurUI(e));
        if (!btn) return null;
        clickable(btn).click();
        const t0 = Date.now();
        while (!input && Date.now() - t0 < 1500) { await sleep(100); input = findMediaInput(file); }
      }
      if (!input) { pressEscape(); return null; }
      input.files = makeDT(file).files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return () => pressEscape();
    }
    async function viaDrop(file) {
      const main = document.querySelector('#main');
      if (!main) return null;
      const r = main.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      let target = document.elementFromPoint(x, y);
      if (!target || !main.contains(target)) target = main;
      const dt = makeDT(file);
      const fire = (el, type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, dataTransfer: dt }));
      fire(target, 'dragenter'); fire(target, 'dragover');
      await sleep(250);
      let dropEl = document.elementFromPoint(x, y) || target;
      if (isOurUI(dropEl)) dropEl = target;
      fire(dropEl, 'dragenter'); fire(dropEl, 'dragover'); fire(dropEl, 'drop');
      return () => { try { fire(dropEl, 'dragleave'); fire(target, 'dragleave'); } catch (e) { /* ignore */ } };
    }
    const METHODS = { paste: viaPaste, input: viaInput, drop: viaDrop };

    async function waitForPreview(beforeEdit, beforeSend, timeout) {
      const t0 = Date.now();
      let seenAt = 0;
      while (Date.now() - t0 < timeout) {
        const fresh = [...document.querySelectorAll('[contenteditable="true"]')]
          .find(el => isVisible(el) && !beforeEdit.has(el) && !el.closest('#main footer') && !isOurUI(el));
        if (fresh) return { opened: true, captionEl: fresh };
        const btn = findPreviewSendBtn();
        if (btn && !beforeSend.has(btn)) {
          if (!seenAt) seenAt = Date.now();
          else if (Date.now() - seenAt > 800) return { opened: true, captionEl: null };
        }
        await sleep(200);
      }
      return { opened: false, captionEl: null };
    }

    async function attachFile(file, caption) {
      const remembered = localStorage.getItem(METHOD_KEY);
      const order = ['paste', 'input', 'drop'];
      if (order.includes(remembered)) order.sort((a, b) => (b === remembered) - (a === remembered));
      const timeout = Math.min(20000, 6000 + (file.size / 1048576) * 150);
      log(`adjuntando "${file.name}" (${(file.size / 1048576).toFixed(1)} MB) — orden: ${order.join(' → ')}`);

      for (const method of order) {
        const beforeEdit = visibleEditables(), beforeSend = visibleSendBtns();
        let cleanup = null;
        try { cleanup = await METHODS[method](file); } catch (e) { log(`${method}: error`, e.message); pressEscape(); continue; }
        if (!cleanup) { log(`${method}: no disponible`); continue; }
        let preview = await waitForPreview(beforeEdit, beforeSend, timeout);
        if (!preview.opened) {
          cleanup();
          await sleep(400);
          const late = findPreviewSendBtn();
          if (!(late && !beforeSend.has(late))) { log(`${method}: no abrió la vista previa`); continue; }
          preview = { opened: true, captionEl: null };
        }
        localStorage.setItem(METHOD_KEY, method);
        log(`vista previa abierta con "${method}"`);
        if (caption) {
          let capEl = preview.captionEl;
          if (!capEl) {
            await sleep(300);
            capEl = [...document.querySelectorAll('[contenteditable="true"]')].find(el => isVisible(el) && !el.closest('#main footer') && !isOurUI(el));
          }
          if (capEl) {
            capEl.focus();
            await sleep(60);
            document.execCommand('insertText', false, caption);
          } else {
            try { await navigator.clipboard.writeText(caption); notify('El texto quedó copiado: pégalo en la descripción.'); } catch (e) { /* ignore */ }
          }
          preview.captionEl = capEl || null;
        }
        return preview;
      }
      return { opened: false, captionEl: null };
    }
    const previewOpen = p => (p.captionEl && isVisible(p.captionEl)) || !!findPreviewSendBtn();

    function extFor(type) {
      const m = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/3gpp': '.3gp' };
      return m[type] || '';
    }

    // Carga un paso en el chat SIN enviarlo. → { ok, kind:'text'|'media', preview?, reason? }
    async function loadStep(step) {
      const { text, img, vid } = libs();
      let caption = '', blob = null, fileName = 'archivo', mime = '';

      if (step.type === 'snippet') {
        const s = (text.items || []).find(i => i.id === step.snippetId);
        if (!s) return { ok: false, reason: 'Este mensaje fue borrado.' };
        if (s.imageId) {
          const im = (img.items || []).find(i => i.id === s.imageId);
          if (im && core.getSavedImageBlob) { blob = await core.getSavedImageBlob(im.id); fileName = im.name || 'imagen'; }
          caption = s.text || '';
          if (!blob) return (await loadText(s.text || '')) ? { ok: true, kind: 'text' } : { ok: false, reason: 'No encontré la caja de mensaje.' };
        } else {
          return (await loadText(s.text || '')) ? { ok: true, kind: 'text' } : { ok: false, reason: 'No encontré la caja de mensaje.' };
        }
      } else if (step.type === 'image') {
        const im = (img.items || []).find(i => i.id === step.imageId);
        if (!im) return { ok: false, reason: 'Esta imagen fue borrada.' };
        blob = core.getSavedImageBlob ? await core.getSavedImageBlob(im.id) : null;
        if (!blob) return { ok: false, reason: 'No encontré el archivo de la imagen.' };
        caption = im.caption || ''; fileName = im.name || 'imagen';
      } else if (step.type === 'video') {
        const v = (vid.items || []).find(i => i.id === step.videoId);
        if (!v) return { ok: false, reason: 'Este video fue borrado.' };
        blob = core.getSavedVideoBlob ? await core.getSavedVideoBlob(v.id) : null;
        if (!blob) return { ok: false, reason: 'No encontré el archivo del video.' };
        caption = v.caption || ''; fileName = v.fileName || v.name || 'video'; mime = v.mime || '';
      }

      mime = mime || blob.type || (step.type === 'video' ? 'video/mp4' : 'image/jpeg');
      if (!/\.[a-z0-9]{2,4}$/i.test(fileName)) fileName += extFor(mime);
      const file = new File([blob], fileName, { type: mime });
      const preview = await attachFile(file, caption);
      if (!preview.opened) return { ok: false, reason: 'WhatsApp no abrió la vista previa.' };
      return { ok: true, kind: 'media', preview };
    }

    // ================= Ejecución (tú presionas Enter) =================
    let run = null; // { seqId, steps, idx, chat, action }

    function startRun(seq) {
      if (run) { notify('Ya hay una secuencia en curso.'); return; }
      if (!document.querySelector('#main')) { notify('Abre un chat primero.'); return; }
      const steps = seq.steps.slice();
      if (!steps.length) { notify('Esta secuencia no tiene pasos.'); return; }
      run = { seqId: seq.id, name: seq.name, steps, idx: 0, chat: chatKey(), action: null };
      log(`inicio "${seq.name}" en chat "${run.chat}"`);
      execute(run);
    }

    function stopRun(msg) {
      if (!run) return;
      run.action = 'stop';
      if (msg) showBar({ text: msg, done: true });
    }

    // Espera a que ocurra algo: enviado / saltar / detener / cambio de chat / no enviado
    // ---- Detectar que TÚ enviaste: Enter (sin Shift) o clic en el botón enviar ----
    let sendIntentAt = 0;
    document.addEventListener('keydown', e => {
      if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
      const t = e.target;
      if (t && t.closest && t.closest('[contenteditable="true"]') && !isOurUI(t)) sendIntentAt = Date.now();
    }, true);
    document.addEventListener('mousedown', e => {
      const t = e.target;
      if (!t || !t.closest || isOurUI(t)) return;
      if (SEL.sendBtn.some(sel => t.closest(sel))) sendIntentAt = Date.now();
    }, true);

    // Espera a que ocurra algo: enviado / saltar / detener / cambio de chat / no enviado
    async function waitOutcome(r, loaded, beforeOut) {
      const loadedAt = Date.now();
      let goneSince = 0;
      while (true) {
        if (r.action) { const a = r.action; r.action = null; return a; }
        if (chatKey() !== r.chat) return 'chat-changed';

        // Señal extra: apareció un mensaje saliente nuevo
        const out = lastOutgoing();
        if (out && beforeOut && out !== beforeOut) { log('enviado (mensaje nuevo en el chat)'); return 'sent'; }

        // Señal principal: lo cargado desapareció (caja vacía / vista previa cerrada)
        const gone = loaded.kind === 'text' ? !composerText() : !previewOpen(loaded.preview);
        if (gone) {
          if (!goneSince) goneSince = Date.now();
          // …justo después de tu Enter o clic en enviar → enviado
          if (sendIntentAt >= loadedAt && goneSince - sendIntentAt < 4000) { log('enviado (Enter / botón enviar)'); return 'sent'; }
          // Desapareció sin Enter: espera un poco por si el mensaje aparece, si no → no se envió
          if (Date.now() - goneSince > (loaded.kind === 'media' ? 15000 : 3000)) return 'not-sent';
        } else goneSince = 0;
        await sleep(150);
      }
    }

    async function waitChoice(r) {
      while (!r.action) {
        if (chatKey() !== r.chat) return 'chat-changed';
        await sleep(150);
      }
      const a = r.action; r.action = null; return a;
    }

    async function execute(r) {
      renderSafe();
      try {
        while (r.idx < r.steps.length) {
          const step = r.steps[r.idx];
          const label = describe(step).label;
          showBar({ count: true, text: 'Cargando…', label });
          renderSafe();

          const beforeOut = lastOutgoing();
          const loaded = await loadStep(step);
          if (r.action === 'stop') break;

          if (!loaded.ok) {
            log(`paso ${r.idx + 1} no se pudo cargar: ${loaded.reason}`);
            showBar({ count: true, text: loaded.reason, label, warn: true, retry: true });
            const a = await waitChoice(r);
            if (a === 'retry') continue;
            if (a === 'skip') { r.idx++; continue; }
            if (a === 'chat-changed') { showBar({ text: 'Cambiaste de chat — secuencia detenida.', warn: true, done: true }); return; }
            break;
          }

          showBar({ count: true, enter: true, label });
          const outcome = await waitOutcome(r, loaded, beforeOut);
          log(`paso ${r.idx + 1}: ${outcome}`);

          if (outcome === 'sent') {
            r.idx++;
            // Cambia la barra al instante para que no parezca que hay que volver a presionar Enter
            if (r.idx < r.steps.length) { showBar({ count: true, text: 'Cargando…' }); renderSafe(); await sleep(700); }
            continue;
          }
          if (outcome === 'skip') {
            if (loaded.kind === 'text') clearComposer(); else if (previewOpen(loaded.preview)) pressEscape();
            await sleep(400);
            r.idx++; continue;
          }
          if (outcome === 'chat-changed') { showBar({ text: 'Cambiaste de chat — secuencia detenida.', warn: true, done: true }); return; }
          if (outcome === 'not-sent') {
            showBar({ count: true, text: '¿No se envió?', label, warn: true, retry: true, cont: true });
            const a = await waitChoice(r);
            if (a === 'retry') continue;
            if (a === 'skip') { r.idx++; continue; }
            if (a === 'chat-changed') { showBar({ text: 'Cambiaste de chat — secuencia detenida.', warn: true, done: true }); return; }
            break;
          }
          break; // stop
        }
        if (r.idx >= r.steps.length) showBar({ text: '✅ Listo', done: true });
        else showBar({ text: 'Detenida.', done: true });
      } catch (err) {
        console.error('[secuencias]', err);
        showBar({ text: 'Error: ' + err.message, warn: true, done: true });
      } finally {
        if (run === r) run = null;
        renderSafe();
      }
    }

    // ---------------- Barra inferior ----------------
    let barTimer = null;
    function showBar(o) {
      let bar = document.getElementById('wa-sq-bar');
      if (!bar) { bar = document.createElement('div'); bar.id = 'wa-sq-bar'; document.body.appendChild(bar); }
      clearTimeout(barTimer);
      bar.className = (o.warn ? 'warn ' : '') + (o.done ? 'done' : '');
      bar.innerHTML = '';
      const r = run;

      if (o.count && r) {
        const c = document.createElement('span');
        c.className = 'count';
        c.textContent = `${r.idx + 1} / ${r.steps.length}`;
        c.title = o.label || '';
        bar.appendChild(c);
      }
      const msg = document.createElement('span');
      msg.className = 'msg';
      if (o.enter) msg.innerHTML = 'Presiona <span class="key">Enter ↵</span>';
      else msg.textContent = o.text || '';
      bar.appendChild(msg);

      const btn = (txt, action, cls) => {
        const b = document.createElement('button');
        b.textContent = txt;
        if (cls) b.className = cls;
        b.onclick = () => { if (run) run.action = action; };
        bar.appendChild(b);
      };
      if (!o.done) {
        if (o.cont) btn('✓ Sí se envió', 'skip');   // por si la detección falla: seguir con el siguiente
        if (o.retry) btn('↻ Reintentar', 'retry');
        if (!o.cont) btn('Saltar', 'skip');
        btn('■', 'stop', 'stop');
      } else {
        barTimer = setTimeout(() => bar.remove(), 2500);
      }
    }

    function renderSafe() {
      // No redibujar mientras escribes en el buscador
      if (view.picker && document.activeElement && document.activeElement.classList.contains('wa-sq-search')) return;
      render();
    }

    // ---------------- Montaje ----------------
    function mountCard(attemptsLeft) {
      attemptsLeft = attemptsLeft === undefined ? 10 : attemptsLeft;
      if (typeof core.registerMenu === 'function') {
        core.registerMenu('right', '🔗 Secuencias', ui, '⠿', 'sequence-builder');
        render();
      } else if (attemptsLeft > 0) {
        setTimeout(() => mountCard(attemptsLeft - 1), 200);
      }
    }
    mountCard();

    if (core.on) {
      ['textlib:changed', 'imglib:changed', 'vidlib:changed'].forEach(evt => core.on(evt, () => renderSafe()));
    }
    core.emit('block:ready', { id: 'sequenceBuilderModule' });
  }
});

/* ============================================================
   BLOCK: Quick Commands (v1)
   ============================================================ */
LegoCore.registerBlock({
  id: 'quickCommandModule',
  init(core) {
    function findMatchingSnippet(command) {
      const lib = core.getTextLibrary ? core.getTextLibrary() : { items: [] };
      return lib.items.find(i => i.type === 'snippet' && i.customCommand && i.customCommand.toLowerCase() === command.toLowerCase());
    }

    function tryReplaceCommand(box) {
      const sel = window.getSelection();
      if (!sel.rangeCount) return;
      const range = sel.getRangeAt(0);
      if (!box.contains(range.startContainer)) return;

      // Look at the text immediately before the caret inside this node.
      const node = range.startContainer;
      const textBefore = node.nodeType === 3 ? node.textContent.slice(0, range.startOffset) : '';
      const match = textBefore.match(/\/(\w+)\s$/);
      if (!match) return;

      const snippet = findMatchingSnippet(match[1]);
      if (!snippet) return;

      // Select and delete the "/command " token, then insert the snippet text.
      const tokenLength = match[0].length;
      const deleteRange = document.createRange();
      deleteRange.setStart(node, range.startOffset - tokenLength);
      deleteRange.setEnd(node, range.startOffset);
      sel.removeAllRanges();
      sel.addRange(deleteRange);
      document.execCommand('delete', false);
      document.execCommand('insertText', false, snippet.text);
      box.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    }

    function attachListener() {
      const box = core.getComposeBox();
      if (!box) { setTimeout(attachListener, 500); return; }
      if (box.dataset.qcAttached) return;
      box.dataset.qcAttached = '1';
      box.addEventListener('keyup', (e) => { if (e.key === ' ') tryReplaceCommand(box); });
    }

    // Compose box gets torn down/rebuilt by WhatsApp's own React re-renders
    // whenever you switch chats, so re-check periodically rather than once.
    setInterval(attachListener, 1000);
    attachListener();

    core.emit('block:ready', { id: 'quickCommandModule' });
  }
});

/* ============================================================
   BLOCK: Google Sheets Sync (v4)
   ============================================================ */
/* ============================================================
   BLOCK: Sync Center WhatsApp (v1 — bunny.net)
   ------------------------------------------------------------
   Mismos botones que el Sync Center de Instagram:
     📝 Master  → ☁️ Push / 📥 Pull
     🖼️ Images  → ☁️ Smart Backup / 📥 Pull / ♻️ Force
     🎬 Videos  → ☁️ Smart Backup / 📥 Pull / ♻️ Force

   QUÉ SE SINCRONIZA
   - Master (un JSON): TODAS las claves del kit que empiezan con "wa_"
     (secuencias, mensajes, lista de imágenes, lista de videos,
     etiquetas, layout del sidebar, posiciones…). Excepto:
       · la contraseña de bunny (wa_bunny_sync_prefs_v1)
       · "qué método de adjuntar funciona" (es propio de cada PC)
   - Images: los archivos de imagen (base de datos del kit, "images")
   - Videos: los archivos de video (base "wa_video_library_db")
   Los archivos se identifican por su ID permanente (img_…, vid_…):
   renombrar o mover algo nunca lo vuelve a subir.

   EN BUNNY (misma zona que Instagram sirve; todo va en wa_toolkit/)
     wa_toolkit/master_config.json
     wa_toolkit/images/<id>.jpg|png|webp
     wa_toolkit/videos/<id>.mp4|mov

   EN UN PC NUEVO: 1) Pull Master (recarga)  2) Pull Images  3) Pull Videos

   ENCABEZADO TAMPERMONKEY (ya lo tienes):
     // @grant   GM_xmlhttpRequest
     // @connect bunnycdn.com
   ============================================================ */
LegoCore.registerBlock({
  id: 'waCloudSyncCenterModule',
  init(core) {
    const PREFS_KEY = 'wa_bunny_sync_prefs_v1';
    const ROOT = 'wa_toolkit';
    const EXCLUDED_KEYS = new Set([PREFS_KEY, 'wa_seq_attach_method', 'wa_vlc_attach_method']);

    const IMG_LIST_KEY = 'wa_image_library_v1';
    const VID_LIST_KEY = 'wa_video_library_v1';
    const VIDEO_DB_NAME = 'wa_video_library_db';
    const VIDEO_STORE = 'videos';

    let prefs;
    try { prefs = JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch (e) { prefs = {}; }
    prefs = Object.assign({ zoneName: '', apiKey: '', region: 'default' }, prefs);
    const savePrefs = () => localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));

    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const fmtMB = b => ((b || 0) / 1048576).toFixed(1) + ' MB';

    // ================= Bunny API =================
    class ReadOnlyError extends Error {}

    function bunnyRequest(method, path, data = null, responseType = '', onProgress = null) {
      return new Promise((resolve, reject) => {
        if (!prefs.zoneName || !prefs.apiKey) return reject(new Error('Faltan la zona o la contraseña.'));
        if (typeof GM_xmlhttpRequest === 'undefined') return reject(new Error('Falta "// @grant GM_xmlhttpRequest" en el encabezado.'));
        const host = prefs.region === 'default' ? 'storage.bunnycdn.com' : `${prefs.region}.storage.bunnycdn.com`;
        const url = `https://${host}/${encodeURIComponent(prefs.zoneName)}/${String(path || '').replace(/^\/+/, '')}`;

        const opts = {
          method, url,
          headers: { AccessKey: prefs.apiKey, accept: 'application/json' },
          onload: res => {
            if (res.status >= 200 && res.status < 300) {
              if (responseType) return resolve(res.response);
              try { resolve(res.responseText ? JSON.parse(res.responseText) : null); } catch (e) { resolve(res.responseText); }
            } else if (res.status === 401 && method !== 'GET') {
              reject(new ReadOnlyError('Esta contraseña es solo de lectura: Pull funciona, Push/Backup no.'));
            } else if (res.status === 401) {
              reject(new Error('Contraseña o zona incorrecta (401).'));
            } else if (res.status === 404) {
              const err = new Error('No existe en la nube (404).'); err.status = 404; reject(err);
            } else {
              reject(new Error(`Error ${res.status} de bunny.`));
            }
          },
          onerror: () => reject(new Error('Error de red. ¿Está "@connect bunnycdn.com" en el encabezado?')),
          ontimeout: () => reject(new Error('Bunny tardó demasiado en responder.'))
        };
        if (data) {
          opts.data = data;
          opts.headers['Content-Type'] = 'application/octet-stream';
          if (onProgress) opts.upload = { onprogress: e => { if (e.lengthComputable) onProgress(e.loaded / e.total); } };
        } else if (onProgress) {
          opts.onprogress = e => { if (e.lengthComputable && e.total) onProgress(e.loaded / e.total); };
        }
        if (responseType) opts.responseType = responseType;
        GM_xmlhttpRequest(opts);
      });
    }

    // Lista los archivos de una carpeta → [{ id, name, path }]
    async function listCloud(folder) {
      let items;
      try { items = await bunnyRequest('GET', `${ROOT}/${folder}/`); }
      catch (e) { if (e.status === 404) return []; throw e; }
      if (!Array.isArray(items)) return [];
      return items.filter(i => !i.IsDirectory).map(i => ({
        id: i.ObjectName.replace(/\.[^.]+$/, ''),
        name: i.ObjectName,
        size: i.Length || 0,
        path: `${ROOT}/${folder}/${encodeURIComponent(i.ObjectName)}`
      }));
    }

    function blobToArrayBuffer(blob) {
      if (blob && typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
      return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(new Error('No se pudo leer el archivo local.'));
        r.readAsArrayBuffer(blob);
      });
    }

    const EXT = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
                  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/3gpp': '3gp', 'video/webm': 'webm' };
    const MIME = Object.fromEntries(Object.entries(EXT).map(([m, e]) => [e, m]));
    MIME.jpg = 'image/jpeg';
    const extFor = (type, fallback) => EXT[(type || '').toLowerCase()] || fallback;

    // ================= Datos locales =================
    function readList(key, getter) {
      if (getter) { try { const d = getter(); if (d && Array.isArray(d.items)) return d; } catch (e) { /* ignore */ } }
      try { const d = JSON.parse(localStorage.getItem(key)); if (d && Array.isArray(d.items)) return d; } catch (e) { /* ignore */ }
      return { items: [] };
    }
    const imageIds = () => readList(IMG_LIST_KEY, core.getImageLibrary).items.filter(i => i.type === 'image').map(i => i.id);
    const videoIds = () => readList(VID_LIST_KEY, core.getVideoLibrary).items.filter(i => i.type === 'video').map(i => i.id);

    // Imágenes: base del kit (core.getDb), almacén "images" → { id, blob, order }
    const imageStore = {
      label: 'Img',
      ids: imageIds,
      async getAll() {
        const db = core.getDb && core.getDb();
        if (!db || !db.objectStoreNames.contains('images')) return new Map();
        return new Promise(resolve => {
          const map = new Map();
          const req = db.transaction(['images'], 'readonly').objectStore('images').openCursor();
          req.onsuccess = () => {
            const cur = req.result;
            if (!cur) return resolve(map);
            if (cur.value && cur.value.blob) map.set(cur.value.id, cur.value.blob);
            cur.continue();
          };
          req.onerror = () => resolve(map);
        });
      },
      async put(id, blob) {
        const db = core.getDb && core.getDb();
        if (!db) throw new Error('La base de imágenes no está lista. Recarga WhatsApp.');
        return new Promise((resolve, reject) => {
          const tx = db.transaction(['images'], 'readwrite');
          tx.objectStore('images').put({ id, blob, order: Date.now() });
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error || new Error('No se pudo guardar la imagen.'));
        });
      }
    };

    // Videos: base propia del bloque de videos
    let vdb = null;
    function openVideoDb() {
      if (vdb) return Promise.resolve(vdb);
      return new Promise((resolve, reject) => {
        const req = indexedDB.open(VIDEO_DB_NAME, 1);
        req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(VIDEO_STORE)) req.result.createObjectStore(VIDEO_STORE, { keyPath: 'id' }); };
        req.onsuccess = () => { vdb = req.result; resolve(vdb); };
        req.onerror = () => reject(req.error || new Error('No se pudo abrir la base de videos.'));
      });
    }
    const videoStore = {
      label: 'Video',
      ids: videoIds,
      async getAll() {
        const db = await openVideoDb();
        // Solo las claves (no carga los videos a memoria todavía)
        const keys = await new Promise(resolve => {
          const req = db.transaction([VIDEO_STORE], 'readonly').objectStore(VIDEO_STORE).getAllKeys();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => resolve([]);
        });
        const map = new Map();
        keys.forEach(k => map.set(k, null)); // null = cargar cuando haga falta
        return map;
      },
      async getBlob(id) {
        const db = await openVideoDb();
        return new Promise(resolve => {
          const req = db.transaction([VIDEO_STORE], 'readonly').objectStore(VIDEO_STORE).get(id);
          req.onsuccess = () => resolve(req.result ? req.result.blob : null);
          req.onerror = () => resolve(null);
        });
      },
      async put(id, blob) {
        const db = await openVideoDb();
        return new Promise((resolve, reject) => {
          const tx = db.transaction([VIDEO_STORE], 'readwrite');
          tx.objectStore(VIDEO_STORE).put({ id, blob });
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error || new Error('No se pudo guardar el video.'));
          tx.onabort = () => reject(tx.error || new Error('No hay espacio para guardar el video.'));
        });
      }
    };

    // ================= UI =================
    const style = document.createElement('style');
    style.id = 'wa-csc-styles';
    style.textContent = `
      .wa-csc-wrap { display:flex; flex-direction:column; gap:10px; font-size:11px; color:#fff; font-family:-apple-system,sans-serif; }
      .wa-csc-box { background:#18181b; padding:10px; border-radius:6px; border:1px solid #334155; display:flex; flex-direction:column; gap:6px; }
      .wa-csc-title { color:#94a3b8; font-size:10px; font-weight:bold; text-transform:uppercase; letter-spacing:0.03em; margin-bottom:2px; }
      .wa-csc-input { background:#0f172a; color:#fff; border:1px solid #334155; border-radius:4px; padding:6px; font-size:11px; outline:none; width:100%; box-sizing:border-box; }
      .wa-csc-input:focus { border-color:#6366f1; }
      .wa-csc-row { display:flex; gap:6px; }
      .wa-csc-btn { flex:1; border:none; border-radius:4px; padding:6px; font-size:10px; font-weight:bold; cursor:pointer; text-align:center; transition:0.15s; }
      .wa-csc-btn:disabled { opacity:0.5; cursor:not-allowed; }
      .wa-csc-btn-green { background:#10b981; color:#fff; } .wa-csc-btn-green:hover:not(:disabled){ background:#059669; }
      .wa-csc-btn-blue { background:#0284c7; color:#fff; }  .wa-csc-btn-blue:hover:not(:disabled){ background:#0369a1; }
      .wa-csc-btn-red { background:#dc2626; color:#fff; }   .wa-csc-btn-red:hover:not(:disabled){ background:#b91c1c; }
      .wa-csc-status { font-size:10px; text-align:center; margin-top:2px; color:#c9a876; min-height:14px; font-weight:bold; line-height:1.4; }
      .wa-csc-cred-line { display:flex; align-items:center; gap:6px; color:#94a3b8; font-size:11px; }
      .wa-csc-cred-line span { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .wa-csc-gear { background:none; border:none; cursor:pointer; font-size:13px; padding:0 2px; opacity:.8; }
      .wa-csc-gear:hover { opacity:1; }
    `;
    if (!document.getElementById('wa-csc-styles')) document.head.appendChild(style);

    const REGIONS = [
      ['default', 'Falkenstein (Default)'], ['ny', 'New York (ny)'], ['la', 'Los Angeles (la)'],
      ['br', 'São Paulo (br)'], ['uk', 'United Kingdom (uk)'], ['se', 'Stockholm (se)'],
      ['sg', 'Singapore (sg)'], ['syd', 'Sydney (syd)'], ['jh', 'Johannesburg (jh)']
    ];

    const wrap = document.createElement('div');
    wrap.className = 'wa-csc-wrap';
    wrap.innerHTML = `
      <div class="wa-csc-box" id="wa-csc-cred-box">
        <div class="wa-csc-cred-line" id="wa-csc-cred-line"><span id="wa-csc-cred-summary"></span><button class="wa-csc-gear" id="wa-csc-cred-edit" title="Editar credenciales">⚙️</button></div>
        <div id="wa-csc-cred-form" style="display:flex; flex-direction:column; gap:6px;">
          <div class="wa-csc-title">Credentials</div>
          <input type="text" id="wa-csc-zone" class="wa-csc-input" placeholder="Storage Zone Name">
          <input type="password" id="wa-csc-key" class="wa-csc-input" placeholder="Zone Password">
          <select id="wa-csc-region" class="wa-csc-input">${REGIONS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
          <button class="wa-csc-btn wa-csc-btn-blue" id="wa-csc-cred-save">Guardar</button>
        </div>
      </div>

      <div class="wa-csc-box">
        <div class="wa-csc-title" title="Secuencias, mensajes, listas de imágenes y videos, etiquetas y layout">📝 Text & Settings Master</div>
        <div class="wa-csc-row">
          <button class="wa-csc-btn wa-csc-btn-green" id="wa-csc-push-master" title="Subir tus listas y ajustes a la nube">☁️ Push</button>
          <button class="wa-csc-btn wa-csc-btn-blue" id="wa-csc-pull-master" title="Bajar listas y ajustes de la nube (reemplaza los locales)">📥 Pull</button>
        </div>
      </div>

      <div class="wa-csc-box">
        <div class="wa-csc-title">🖼️ Images</div>
        <div class="wa-csc-row">
          <button class="wa-csc-btn wa-csc-btn-green" data-kind="img" data-op="push" title="Sube las nuevas y borra de la nube las que ya no tienes">☁️ Smart Backup</button>
          <button class="wa-csc-btn wa-csc-btn-blue" data-kind="img" data-op="pull" title="Baja las que te faltan">📥 Pull</button>
          <button class="wa-csc-btn wa-csc-btn-red" data-kind="img" data-op="force" title="Borra la nube y vuelve a subir todo">♻️ Force</button>
        </div>
      </div>

      <div class="wa-csc-box">
        <div class="wa-csc-title">🎬 Videos</div>
        <div class="wa-csc-row">
          <button class="wa-csc-btn wa-csc-btn-green" data-kind="vid" data-op="push" title="Sube los nuevos y borra de la nube los que ya no tienes">☁️ Smart Backup</button>
          <button class="wa-csc-btn wa-csc-btn-blue" data-kind="vid" data-op="pull" title="Baja los que te faltan">📥 Pull</button>
          <button class="wa-csc-btn wa-csc-btn-red" data-kind="vid" data-op="force" title="Borra la nube y vuelve a subir todo">♻️ Force</button>
        </div>
      </div>

      <div id="wa-csc-status" class="wa-csc-status">Ready.</div>
    `;
    const $ = s => wrap.querySelector(s);

    // ---- Credenciales: se pliegan a una línea cuando están guardadas ----
    function renderCreds(forceOpen) {
      $('#wa-csc-zone').value = prefs.zoneName;
      $('#wa-csc-key').value = prefs.apiKey;
      $('#wa-csc-region').value = prefs.region;
      const has = prefs.zoneName && prefs.apiKey;
      const open = forceOpen || !has;
      $('#wa-csc-cred-form').style.display = open ? 'flex' : 'none';
      $('#wa-csc-cred-line').style.display = has ? 'flex' : 'none';
      const reg = (REGIONS.find(r => r[0] === prefs.region) || REGIONS[0])[1].replace(/\s*\(.*\)/, '');
      $('#wa-csc-cred-summary').textContent = `🔑 ${prefs.zoneName} · ${reg}`;
    }
    $('#wa-csc-cred-edit').onclick = () => {
      const formOpen = $('#wa-csc-cred-form').style.display !== 'none';
      renderCreds(!formOpen);
    };
    $('#wa-csc-cred-save').onclick = () => {
      prefs.zoneName = $('#wa-csc-zone').value.trim();
      prefs.apiKey = $('#wa-csc-key').value.trim();
      prefs.region = $('#wa-csc-region').value;
      savePrefs();
      renderCreds(false);
      setStatus(prefs.zoneName && prefs.apiKey ? '✅ Credenciales guardadas.' : '❌ Faltan datos.', !(prefs.zoneName && prefs.apiKey));
    };

    // ---- Estado / bloqueo ----
    const statusEl = $('#wa-csc-status');
    const allBtns = () => [...wrap.querySelectorAll('.wa-csc-btn')];
    function setStatus(msg, isError) { statusEl.style.color = isError ? '#f43f5e' : '#10b981'; statusEl.textContent = msg; }
    function lockUI(msg) { allBtns().forEach(b => { b.disabled = true; }); statusEl.style.color = '#c9a876'; statusEl.textContent = msg; }
    function unlockUI(msg, isError) { allBtns().forEach(b => { b.disabled = false; }); setStatus(msg, isError); }
    const ready = () => prefs.zoneName && prefs.apiKey;

    // ================= MASTER =================
    function masterKeys() {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('wa_') && !EXCLUDED_KEYS.has(k)) keys.push(k);
      }
      return keys.sort();
    }

    $('#wa-csc-push-master').onclick = async () => {
      if (!ready()) return unlockUI('❌ Faltan credenciales.', true);
      lockUI('☁️ Push Master…');
      try {
        const keys = masterKeys();
        const payload = { __meta: { app: 'wa_toolkit', version: 1, pushedAt: new Date().toISOString() }, keys: {} };
        keys.forEach(k => { payload.keys[k] = localStorage.getItem(k); });
        const buf = await blobToArrayBuffer(new Blob([JSON.stringify(payload)], { type: 'application/json' }));
        await bunnyRequest('PUT', `${ROOT}/master_config.json`, buf);
        console.log('[waSync] master push:', keys);
        unlockUI(`✅ Master subido (${keys.length} ajustes · ${fmtMB(buf.byteLength)}).`);
      } catch (e) { unlockUI('❌ ' + e.message, true); }
    };

    $('#wa-csc-pull-master').onclick = async () => {
      if (!ready()) return unlockUI('❌ Faltan credenciales.', true);
      lockUI('📥 Pull Master…');
      let data;
      try { data = await bunnyRequest('GET', `${ROOT}/master_config.json`); }
      catch (e) { return unlockUI(e.status === 404 ? '❌ No hay Master en la nube todavía. Haz Push primero.' : '❌ ' + e.message, true); }
      if (!data || typeof data !== 'object') return unlockUI('❌ Archivo de la nube inválido.', true);
      // Acepta el formato {keys:{...}} y también el plano {clave: valor}
      const entries = Object.entries(data.keys && typeof data.keys === 'object' ? data.keys : data)
        .filter(([k, v]) => k.startsWith('wa_') && !EXCLUDED_KEYS.has(k) && typeof v === 'string');
      const when = data.__meta && data.__meta.pushedAt ? new Date(data.__meta.pushedAt).toLocaleString() : 'fecha desconocida';
      if (!confirm(`⚠️ Reemplazar tus listas y ajustes locales con la nube?\n\n${entries.length} ajustes · subidos: ${when}\n\nLa página se recargará.`)) return unlockUI('Cancelado.');
      entries.forEach(([k, v]) => localStorage.setItem(k, v));
      console.log('[waSync] master pull:', entries.map(e => e[0]));
      unlockUI('✅ Master importado. Recargando…');
      setTimeout(() => location.reload(), 1000);
    };

    // ================= IMAGES / VIDEOS =================
    const KINDS = {
      img: { folder: 'images', store: imageStore, icon: '🖼️', fallbackExt: 'jpg' },
      vid: { folder: 'videos', store: videoStore, icon: '🎬', fallbackExt: 'mp4' }
    };

    async function getLocalBlob(kind, id, localMap) {
      const b = localMap.get(id);
      if (b) return b;
      return kind.store.getBlob ? kind.store.getBlob(id) : null;
    }

    async function uploadOne(kind, id, blob, n, total) {
      const ext = extFor(blob.type, kind.fallbackExt);
      const buf = await blobToArrayBuffer(blob);
      const label = `${kind.icon} Push ${n}/${total}`;
      lockUI(`${label}…`);
      await bunnyRequest('PUT', `${ROOT}/${kind.folder}/${encodeURIComponent(id)}.${ext}`, buf, '',
        buf.byteLength > 2 * 1048576 ? p => lockUI(`${label} · ${Math.round(p * 100)}%`) : null);
    }

    async function smartBackup(k) {
      const kind = KINDS[k];
      lockUI(`${kind.icon} Revisando…`);
      const listed = new Set(kind.store.ids());
      const local = await kind.store.getAll();
      const cloud = await listCloud(kind.folder);
      const cloudIds = new Set(cloud.map(c => c.id));

      const toUpload = [...listed].filter(id => local.has(id) && !cloudIds.has(id));
      const toDelete = cloud.filter(c => !listed.has(c.id));
      const missingLocal = [...listed].filter(id => !local.has(id)).length;

      if (!toUpload.length && !toDelete.length) {
        return unlockUI(`✅ ${kind.icon} Al día.` + (missingLocal ? ` (${missingLocal} sin archivo en este PC: usa Pull)` : ''));
      }
      if (toDelete.length && !confirm(`${kind.icon} Smart Backup\n\nSubir: ${toUpload.length}\nBorrar de la nube: ${toDelete.length} (ya no están en tu lista)\n\n¿Continuar?`)) {
        return unlockUI('Cancelado.');
      }
      for (let i = 0; i < toDelete.length; i++) {
        lockUI(`🗑️ Borrando ${i + 1}/${toDelete.length}…`);
        await bunnyRequest('DELETE', toDelete[i].path);
      }
      for (let i = 0; i < toUpload.length; i++) {
        const blob = await getLocalBlob(kind, toUpload[i], local);
        if (blob) await uploadOne(kind, toUpload[i], blob, i + 1, toUpload.length);
        await sleep(80);
      }
      unlockUI(`✅ ${kind.icon} Backup: subidos ${toUpload.length}, borrados ${toDelete.length}.`);
    }

    async function pull(k) {
      const kind = KINDS[k];
      lockUI(`${kind.icon} Revisando…`);
      const listed = kind.store.ids();
      const local = await kind.store.getAll();
      const cloud = await listCloud(kind.folder);
      const byId = new Map(cloud.map(c => [c.id, c]));

      if (!listed.length && cloud.length) {
        return unlockUI(`⚠️ Tu lista está vacía pero la nube tiene ${cloud.length}. Primero haz 📥 Pull del Master.`, true);
      }
      const toDownload = listed.filter(id => !local.has(id) && byId.has(id));
      const notInCloud = listed.filter(id => !local.has(id) && !byId.has(id)).length;
      if (!toDownload.length) return unlockUI(`✅ ${kind.icon} Ya tienes todo.` + (notInCloud ? ` (${notInCloud} no están en la nube)` : ''));

      for (let i = 0; i < toDownload.length; i++) {
        const c = byId.get(toDownload[i]);
        const label = `${kind.icon} Pull ${i + 1}/${toDownload.length}`;
        lockUI(`${label}…`);
        const raw = await bunnyRequest('GET', c.path, null, 'blob', c.size > 2 * 1048576 ? p => lockUI(`${label} · ${Math.round(p * 100)}%`) : null);
        const ext = (c.name.match(/\.([^.]+)$/) || [])[1] || kind.fallbackExt;
        const blob = raw && raw.type ? raw : new Blob([raw], { type: MIME[ext.toLowerCase()] || '' });
        await kind.store.put(c.id, blob);
        await sleep(60);
      }
      unlockUI(`✅ ${kind.icon} Pull: ${toDownload.length} descargados.` + (notInCloud ? ` (${notInCloud} no están en la nube)` : ''));
      if (k === 'img' && core.getImageLibrary) core.emit('imglib:changed', core.getImageLibrary());
      if (k === 'vid' && core.getVideoLibrary) core.emit('vidlib:changed', core.getVideoLibrary());
    }

    async function force(k) {
      const kind = KINDS[k];
      if (!confirm(`⚠️ ${kind.icon} Force\n\nBorra TODO lo de la nube en "${kind.folder}" y vuelve a subir lo de este PC.\n¿Continuar?`)) return unlockUI('Cancelado.');
      lockUI(`♻️ Revisando…`);
      const listed = kind.store.ids();
      const local = await kind.store.getAll();
      const cloud = await listCloud(kind.folder);
      for (let i = 0; i < cloud.length; i++) {
        lockUI(`♻️ Borrando ${i + 1}/${cloud.length}…`);
        await bunnyRequest('DELETE', cloud[i].path);
      }
      const ids = listed.filter(id => local.has(id));
      for (let i = 0; i < ids.length; i++) {
        const blob = await getLocalBlob(kind, ids[i], local);
        if (blob) await uploadOne(kind, ids[i], blob, i + 1, ids.length);
        await sleep(80);
      }
      unlockUI(`✅ ${kind.icon} Force: subidos ${ids.length}.`);
    }

    wrap.querySelectorAll('[data-kind]').forEach(btn => {
      btn.onclick = async () => {
        if (!ready()) return unlockUI('❌ Faltan credenciales.', true);
        const { kind, op } = btn.dataset;
        try {
          if (op === 'push') await smartBackup(kind);
          else if (op === 'pull') await pull(kind);
          else await force(kind);
        } catch (e) {
          console.error('[waSync]', e);
          unlockUI('❌ ' + e.message, true);
        }
      };
    });

    // ================= Montaje =================
    function mountCard(attemptsLeft) {
      attemptsLeft = attemptsLeft === undefined ? 10 : attemptsLeft;
      if (typeof core.registerMenu === 'function') {
        core.registerMenu('left', '☁️ Sync Center', wrap, '⠿', 'wa-cloud-sync-center');
        renderCreds(false);
      } else if (attemptsLeft > 0) {
        setTimeout(() => mountCard(attemptsLeft - 1), 200);
      }
    }
    mountCard();
    core.emit('block:ready', { id: 'waCloudSyncCenterModule' });
  }
});

/* ============================================================
   BLOCK: Highlighter (v1)
   ============================================================ */
/* ============================================================
   BLOCK: Text Highlighter (v1)
   ------------------------------------------------------------
   Standalone plugin -- no dependency on any other block. Mounts
   its own card into the Dual Sidebar via core.registerMenu, same
   as your other cards.

   Replaces your bookmarklet with:
   - A saved list of highlight rules (term + color + on/off),
     persisted across sessions
   - Each rule gets its own color, chosen via a native color
     swatch, from a rotating default palette when you add one
   - A live match count per rule (how many currently-visible
     elements match it right now)
   - A master pause toggle
   - Clean un-highlighting: turning a rule off or deleting it
     removes exactly the styling it applied (tracked per element
     via a data attribute), rather than just piling more styles
     on top like the bookmarklet did
   ============================================================ */
LegoCore.registerBlock({
  id: 'textHighlighterPlugin',
  init(core) {
    const RULES_KEY = 'ig_text_highlighter_rules_v1';
    const MASTER_KEY = 'ig_text_highlighter_master_v1';
    const PALETTE = ['#f6c344', '#7ee787', '#ff8fa3', '#8ecae6', '#c9a876', '#ff9770', '#c792ea', '#94e2c4'];

    let rules = [];
    try { rules = JSON.parse(localStorage.getItem(RULES_KEY)) || []; } catch (e) { rules = []; }

    let masterEnabled = localStorage.getItem(MASTER_KEY) !== 'false';

    function saveRules() { localStorage.setItem(RULES_KEY, JSON.stringify(rules)); }
    function saveMaster() { localStorage.setItem(MASTER_KEY, String(masterEnabled)); }

    function nextPaletteColor() {
      const used = rules.map(r => r.color);
      const free = PALETTE.find(c => !used.includes(c));
      return free || PALETTE[rules.length % PALETTE.length];
    }

    function contrastColor(hex) {
      const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
      const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      return luminance > 0.6 ? '#000000' : '#ffffff';
    }

    function uid() { return 'hlrule_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

    // ---------------- Styles ----------------
    function injectStyles() {
      if (document.getElementById('ig-hl-styles')) return;
      const style = document.createElement('style');
      style.id = 'ig-hl-styles';
      style.innerHTML = `
        .ig-hl-wrap { display:flex; flex-direction:column; gap:8px; font-family:-apple-system,sans-serif; font-size:11px; }
        .ig-hl-master { display:flex; align-items:center; justify-content:space-between; background:var(--igls-surface-2,#1c1c23); border:1px solid var(--igls-border,rgba(255,255,255,.07)); border-radius:6px; padding:6px 8px; }
        .ig-hl-master label { display:flex; align-items:center; gap:6px; cursor:pointer; font-size:10.5px; color:var(--igls-text-dim,#96949c); }
        .ig-hl-add-row { display:flex; gap:4px; align-items:center; }
        .ig-hl-input { flex:1; background:var(--igls-surface-2,#1c1c23); color:var(--igls-text,#ece9e4); border:1px solid var(--igls-border,rgba(255,255,255,.08)); border-radius:6px; padding:6px 8px; font-size:11px; outline:none; }
        .ig-hl-input:focus { border-color:var(--igls-accent,#c9a876); }
        .ig-hl-color-input { width:26px; height:26px; border:1px solid var(--igls-border,rgba(255,255,255,.1)); border-radius:6px; cursor:pointer; background:transparent; padding:0; flex-shrink:0; }
        .ig-hl-add-btn { background:var(--igls-accent,#c9a876); color:#171208; border:none; border-radius:6px; padding:6px 10px; font-size:11px; font-weight:700; cursor:pointer; flex-shrink:0; }
        .ig-hl-add-btn:hover { filter:brightness(1.08); }

        .ig-hl-list { display:flex; flex-direction:column; gap:4px; max-height:280px; overflow-y:auto; }
        .ig-hl-row { display:flex; align-items:center; gap:6px; background:rgba(255,255,255,.03); border:1px solid var(--igls-border,rgba(255,255,255,.06)); border-radius:6px; padding:5px 6px; }
        .ig-hl-row.disabled { opacity:.45; }
        .ig-hl-term { flex:1; font-size:11px; color:var(--igls-text,#ece9e4); font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; cursor:pointer; }
        .ig-hl-term:hover { text-decoration:underline; }
        .ig-hl-count { font-size:9px; color:var(--igls-text-dim,#96949c); background:rgba(255,255,255,.06); padding:1px 6px; border-radius:8px; flex-shrink:0; min-width:14px; text-align:center; }
        .ig-hl-btn { background:transparent; border:none; color:var(--igls-text-dim,#96949c); cursor:pointer; font-size:11px; padding:3px; border-radius:4px; flex-shrink:0; }
        .ig-hl-btn:hover { color:var(--igls-accent,#c9a876); background:rgba(255,255,255,.08); }
        .ig-hl-empty { padding:14px; text-align:center; font-size:10.5px; color:var(--igls-text-dim,#96949c); }
      `;
      document.head.appendChild(style);
    }

    // ---------------- UI ----------------
    const wrap = document.createElement('div');
    wrap.className = 'ig-hl-wrap';
    wrap.innerHTML = `
      <div class="ig-hl-master">
        <label><input type="checkbox" id="ig-hl-master-chk" ${masterEnabled ? 'checked' : ''}> Highlighting active</label>
      </div>
      <div class="ig-hl-add-row">
        <input type="text" id="ig-hl-new-term" class="ig-hl-input" placeholder="Name or word to highlight...">
        <input type="color" id="ig-hl-new-color" class="ig-hl-color-input" value="${nextPaletteColor()}">
        <button id="ig-hl-add-btn" class="ig-hl-add-btn">+ Add</button>
      </div>
      <div id="ig-hl-list" class="ig-hl-list"></div>
    `;

    function renderList() {
      const list = wrap.querySelector('#ig-hl-list');
      list.innerHTML = '';
      if (!rules.length) {
        list.innerHTML = '<div class="ig-hl-empty">No highlights yet. Add a name or word above.</div>';
        return;
      }
      rules.forEach(rule => {
        const row = document.createElement('div');
        row.className = 'ig-hl-row' + (rule.enabled ? '' : ' disabled');
        row.dataset.ruleId = rule.id;
        row.innerHTML = `
          <input type="checkbox" class="ig-hl-toggle" ${rule.enabled ? 'checked' : ''} title="On/off">
          <input type="color" class="ig-hl-color-input ig-hl-row-color" value="${rule.color}">
          <span class="ig-hl-term" title="Click to rename">${rule.term}</span>
          <span class="ig-hl-count" data-count-for="${rule.id}">0</span>
          <button class="ig-hl-btn ig-hl-del" title="Delete">❌</button>
        `;

        row.querySelector('.ig-hl-toggle').onchange = e => {
          rule.enabled = e.target.checked;
          row.classList.toggle('disabled', !rule.enabled);
          saveRules();
          scanAndHighlight();
        };

        row.querySelector('.ig-hl-row-color').onchange = e => {
          rule.color = e.target.value;
          saveRules();
          // Force a fresh pass so already-highlighted elements pick up the new color
          document.querySelectorAll(`[data-ig-hl-id="${rule.id}"]`).forEach(el => {
            el.style.backgroundColor = rule.color;
            el.style.color = contrastColor(rule.color);
          });
        };

        row.querySelector('.ig-hl-term').onclick = () => {
          const name = prompt('Rename highlight:', rule.term);
          if (!name || !name.trim()) return;
          rule.term = name.trim();
          saveRules();
          renderList();
        };

        row.querySelector('.ig-hl-del').onclick = () => {
          if (!confirm(`Remove highlight "${rule.term}"?`)) return;
          document.querySelectorAll(`[data-ig-hl-id="${rule.id}"]`).forEach(el => clearHighlight(el));
          rules = rules.filter(r => r.id !== rule.id);
          saveRules();
          renderList();
        };

        list.appendChild(row);
      });
    }

    wrap.querySelector('#ig-hl-master-chk').onchange = e => {
      masterEnabled = e.target.checked;
      saveMaster();
      if (!masterEnabled) {
        document.querySelectorAll('[data-ig-hl-id]').forEach(el => clearHighlight(el));
      }
    };

    wrap.querySelector('#ig-hl-add-btn').onclick = () => {
      const input = wrap.querySelector('#ig-hl-new-term');
      const colorInput = wrap.querySelector('#ig-hl-new-color');
      const term = input.value.trim();
      if (!term) return;
      rules.push({ id: uid(), term, color: colorInput.value, enabled: true });
      saveRules();
      input.value = '';
      colorInput.value = nextPaletteColor();
      renderList();
      scanAndHighlight();
    };

    wrap.querySelector('#ig-hl-new-term').addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); wrap.querySelector('#ig-hl-add-btn').click(); }
    });

    // ---------------- Scan & highlight ----------------
    function clearHighlight(el) {
      delete el.dataset.igHlId;
      el.style.backgroundColor = '';
      el.style.color = '';
      el.style.fontWeight = '';
      el.style.borderRadius = '';
      el.style.padding = '';
    }

    function scanAndHighlight() {
      if (!masterEnabled) return;
      const enabledRules = rules.filter(r => r.enabled && r.term.trim());
      const counts = {};
      enabledRules.forEach(r => { counts[r.id] = 0; });

      const spans = document.querySelectorAll('div[role="link"] span, div[role="button"] span');
      spans.forEach(s => {
        const text = (s.innerText || '').toLowerCase();
        if (!text) { if (s.dataset.igHlId) clearHighlight(s); return; }

        let matched = null;
        for (const r of enabledRules) {
          if (text.includes(r.term.toLowerCase())) { matched = r; break; }
        }

        if (matched) {
          counts[matched.id] = (counts[matched.id] || 0) + 1;
          if (s.dataset.igHlId !== matched.id) {
            s.dataset.igHlId = matched.id;
            s.style.backgroundColor = matched.color;
            s.style.color = contrastColor(matched.color);
            s.style.fontWeight = 'bold';
            s.style.borderRadius = '3px';
            s.style.padding = '0 2px';
          }
        } else if (s.dataset.igHlId) {
          clearHighlight(s);
        }
      });

      Object.keys(counts).forEach(id => {
        const badge = wrap.querySelector(`[data-count-for="${id}"]`);
        if (badge) badge.innerText = counts[id];
      });
    }

    setInterval(scanAndHighlight, 500);

    // ---------------- Mount ----------------
    function mountCard(attemptsLeft) {
      attemptsLeft = attemptsLeft === undefined ? 10 : attemptsLeft;
      if (typeof core.registerMenu === 'function') {
        injectStyles();
        core.registerMenu('left', '🖍️ Text Highlighter', wrap, '⠿', 'text-highlighter');
        renderList();
      } else if (attemptsLeft > 0) {
        setTimeout(() => mountCard(attemptsLeft - 1), 200);
      }
    }
    mountCard();

    core.emit('block:ready', { id: 'textHighlighterPlugin' });
  }
});

/* ============================================================
   BLOCK: Text resizer (v1)
   ============================================================ */
/* ============================================================
   BLOCK: Chat List Text Resizer (v1)
   ------------------------------------------------------------
   Adds a slider card to the sidebar to globally shrink or 
   enlarge the contact names and message previews.
   - Saves your exact size preference across refreshes
   - Updates instantly as you drag the slider
   - Automatically applies to new chats as you scroll
   ============================================================ */
LegoCore.registerBlock({
  id: 'waTextResizerPlugin',
  init(core) {
    const PREFS_KEY = 'wa_chat_text_size_v1';
    // WhatsApp's default is roughly 16px. We'll default to 12px since you prefer it smaller.
    let currentSize = parseInt(localStorage.getItem(PREFS_KEY)) || 12; 

    function saveSize(size) {
      localStorage.setItem(PREFS_KEY, size.toString());
    }

    // ---------------- UI Setup ----------------
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex; flex-direction:column; gap:12px; padding:4px 8px; font-family:-apple-system,sans-serif; color:var(--wat-text,#ece9e4);';
    
    wrap.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; font-size:11px;">
        <span>Chat List Font Size</span>
        <span id="wa-ts-val" style="font-weight:bold; color:var(--wat-accent,#25d366); background:rgba(37,211,102,0.15); padding:2px 6px; border-radius:4px;">${currentSize}px</span>
      </div>
      <input type="range" id="wa-ts-slider" min="9" max="18" step="1" value="${currentSize}" 
             style="width:100%; cursor:pointer;">
      <div style="display:flex; justify-content:space-between; font-size:9px; color:var(--wat-text-dim,#96949c);">
        <span>Small (9px)</span>
        <span>Default (16px)</span>
      </div>
    `;

    const slider = wrap.querySelector('#wa-ts-slider');
    const valDisplay = wrap.querySelector('#wa-ts-val');

    // Update dynamically as you drag the slider
    slider.addEventListener('input', (e) => {
      currentSize = parseInt(e.target.value);
      valDisplay.textContent = currentSize + 'px';
      saveSize(currentSize);
      applySize(); // Instant feedback
    });

    // ---------------- Logic ----------------
    function applySize() {
      const sizeStr = currentSize + 'px';
      const rows = document.querySelectorAll('div[role="row"], div[role="listitem"]');
      
      rows.forEach(row => {
        row.querySelectorAll('span[dir="auto"], span[dir="ltr"]').forEach(textEl => {
          // Only re-apply if it doesn't match, saving browser performance
          if (textEl.style.fontSize !== sizeStr) {
            textEl.style.fontSize = sizeStr;
          }
        });
      });
    }

    // WhatsApp recycles DOM elements as you scroll, so this loop ensures 
    // newly visible contacts are instantly resized.
    setInterval(applySize, 800);

    // ---------------- Mount ----------------
    function mountCard(attemptsLeft) {
      attemptsLeft = attemptsLeft === undefined ? 10 : attemptsLeft;
      if (typeof core.registerMenu === 'function') {
        core.registerMenu('left', '🔎 Text Resizer', wrap, '⠿', 'wa-text-resizer');
        // Initial application once the menu is mounted
        applySize();
      } else if (attemptsLeft > 0) {
        setTimeout(() => mountCard(attemptsLeft - 1), 200);
      }
    }
    
    mountCard();
    core.emit('block:ready', { id: 'waTextResizerPlugin' });
  }
});

/* ============================================================
   BLOCK: Contact Badge Renderer (v9)
   ============================================================ */
/* ============================================================
   BLOCK: Etiquetas Simples (v1.5)
   ------------------------------------------------------------
   v1.5: botón "A" junto al color de cada etiqueta (y de Números /
   Otras) para elegir texto negro o blanco en la burbuja.
   v1.4: interfaz mínima -- la vista principal es solo la lista.
   ⚙️ abre los ajustes (burbujas, apariencia y Excel).
   v1.3: CARPETAS -- la lista de etiquetas se organiza en carpetas
   (mismo formato visual que "Saved Messages"): 📁 Carpeta crea una,
   arrastra ⠿ para mover etiquetas dentro/fuera, ⚙️ renombra o borra
   (BORRAR solo elimina la carpeta, las etiquetas suben un nivel),
   👁 en la carpeta oculta/muestra todas sus etiquetas a la vez.
   Las carpetas viajan en Exportar/Importar etiquetas (columna Carpeta).

   REEMPLAZA los bloques anteriores:
     - BLOCK 1: Contact Tag Editor
     - BLOCK 2: Contact Badge Renderer
     - BLOCK 3: Contact Tag Dashboard
   Bórralos del script antes de pegar este (si no, se pisan).

   CÓMO FUNCIONA
   - Todo lo que esté entre paréntesis en el nombre de un contacto
     se muestra como burbuja:
       "Pablo Perez (ACN) (50000) (Pagado)"
        -> Pablo Perez [ACN] [50000] [Pagado]
   - Las etiquetas de tu lista usan su color. Los números usan el
     color de "Números". Cualquier otra cosa usa el color de "Otras".
   - 👁 / 🙈 oculta una etiqueta: no se ve como burbuja, pero aparece
     al pasar el cursor sobre el contacto. Un "+N" pequeño avisa
     cuántas hay ocultas.
   - El formato antiguo con corchetes [C:ACN] ya NO se muestra como
     burbuja (queda como texto normal, así es fácil encontrarlos y
     cambiarlos).

   EXCEL
   - Exportar / Importar lista de etiquetas (para compartir con el
     equipo: mismo nombre, color y oculto/visible).
   - Exportar contactos: recorre todos los chats y genera un Excel
     con los contactos que tienen etiquetas.
   - Necesita esta línea en el encabezado de Tampermonkey:
       // @require https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js
     Sin ella, todo funciona igual pero en formato CSV.
   ============================================================ */
LegoCore.registerBlock({
  id: 'simpleTagsPlugin',
  init(core) {
    // ---------------- SELECTORS -- ADJUST IF NEEDED ----------------
    // Igual que el antiguo Block 2: se buscan todos los span[title] dentro
    // de la lista de chats (no depende del rol de la fila, que WhatsApp cambia).
    const LIST_ROOT_SELECTOR = '#pane-side';
    const SCROLL_CONTAINER_SELECTOR = '#pane-side [role="grid"], #pane-side';
    const ROWISH_SELECTOR = '[role="listitem"], [role="row"], [role="gridcell"], [role="option"]';
    const DEBUG = true; // muestra en la consola cuántos nombres encontró
    // -----------------------------------------------------------------

    // Devuelve solo los span[title] que son NOMBRES de contacto (no la vista
    // previa del último mensaje). Sube desde cada span hasta el primer
    // contenedor que tenga más de un span[title]; el nombre es siempre el primero.
    function isNameSpan(span, root) {
      let el = span.parentElement;
      while (el && el !== root) {
        const titled = el.querySelectorAll('span[title]');
        if (titled.length > 1) return titled[0] === span;
        el = el.parentElement;
      }
      return true;
    }
    function getNameSpans() {
      const root = document.querySelector(LIST_ROOT_SELECTOR);
      if (!root) return [];
      return Array.from(root.querySelectorAll('span[title]')).filter(s => isNameSpan(s, root));
    }

    const STORE_KEY = 'wa_simple_tags_v1';
    const PALETTE = ['#8ecae6', '#7ee787', '#f6c344', '#ff9770', '#c792ea', '#ff8fa3', '#94e2c4', '#c9a876', '#a0c4ff', '#ffd6a5'];
    const NUMBERS_LABEL = '(números)';
    const OTHERS_LABEL = '(otras)';

    // ---------------- Config ----------------
    function defaultConfig() {
      return {
        enabled: true,
        tags: [],    // [{ id, name, color, hidden, parentId, order }]
        folders: [], // [{ id, name, collapsed, parentId, order }]
        numbers: { color: '#c9a876', hidden: false },
        others: { color: '#6b6873', hidden: false },
        look: { font: 10, pad: 7, radius: 9 } // tamaño de texto, relleno, radio de esquina (px)
      };
    }
    let idSeq = 0;
    const newId = prefix => prefix + Date.now() + '_' + (idSeq++);

    function loadConfig() {
      try {
        const c = JSON.parse(localStorage.getItem(STORE_KEY));
        if (c && Array.isArray(c.tags)) {
          const merged = Object.assign(defaultConfig(), c);
          merged.look = Object.assign(defaultConfig().look, c.look || {});
          if (!Array.isArray(merged.folders)) merged.folders = [];
          // Migración v1.x -> carpetas: las etiquetas antiguas van a la raíz
          merged.tags.forEach((t, i) => {
            if (!t.id) t.id = newId('tag_');
            if (!t.parentId) t.parentId = 'root';
            if (typeof t.order !== 'number') t.order = i;
          });
          return merged;
        }
      } catch (e) { /* ignore */ }
      return defaultConfig();
    }
    let config = loadConfig();
    let configVersion = 0;
    // redraw=false: guarda sin redibujar las burbujas (ej: abrir/cerrar carpeta)
    function save(redraw) {
      localStorage.setItem(STORE_KEY, JSON.stringify(config));
      if (redraw !== false) configVersion++;
    }

    const norm = s => String(s || '').trim().toLowerCase();
    const findTag = name => config.tags.find(t => norm(t.name) === norm(name));
    const isNumber = s => /^[$\s]*\d[\d.,\s]*$/.test(s);

    function nextPaletteColor() {
      const used = config.tags.map(t => t.color);
      return PALETTE.find(c => !used.includes(c)) || PALETTE[config.tags.length % PALETTE.length];
    }

    function styleFor(text) {
      const tag = findTag(text);
      if (tag) return tag;
      if (isNumber(text)) return config.numbers;
      return config.others;
    }

    // ---------------- Color del texto (negro / blanco) ----------------
    // entry.text: 'black' | 'white' | (vacío = automático según el fondo)
    const BLACK = '#000000', WHITE = '#ffffff';
    function textFor(entry) {
      if (entry.text === 'black') return BLACK;
      if (entry.text === 'white') return WHITE;
      return contrastColor(entry.color);
    }
    // Botón "A" con el fondo de la etiqueta y su color de texto; clic = alterna negro/blanco
    function makeTextToggle(entry, onChange) {
      const btn = document.createElement('button');
      btn.className = 'wa-tg-txt';
      btn.textContent = 'A';
      btn.repaint = () => {
        const isBlack = textFor(entry) === BLACK;
        btn.style.background = entry.color;
        btn.style.color = isBlack ? BLACK : WHITE;
        btn.title = isBlack ? 'Texto negro · clic para blanco' : 'Texto blanco · clic para negro';
      };
      btn.repaint();
      btn.onclick = e => {
        e.stopPropagation();
        entry.text = textFor(entry) === BLACK ? 'white' : 'black';
        btn.repaint();
        onChange();
      };
      return btn;
    }

    function contrastColor(hex) {
      if (!hex || hex[0] !== '#' || hex.length < 7) return '#000000';
      const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
      return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? '#000000' : '#ffffff';
    }

    // ---------------- Parsing ----------------
    function parseName(raw) {
      const tags = [];
      const re = /\(([^()]*)\)/g;
      let m;
      while ((m = re.exec(raw)) !== null) {
        const t = m[1].trim();
        if (t) tags.push(t);
      }
      const base = raw.replace(/\([^()]*\)/g, ' ').replace(/\s+/g, ' ').trim();
      return { base, tags };
    }

    // ---------------- Styles ----------------
    function injectStyles() {
      if (document.getElementById('wa-tg-styles')) return;
      const style = document.createElement('style');
      style.id = 'wa-tg-styles';
      style.innerHTML = `
        .wa-tg-bubble { display:inline-flex; align-items:center; font-size:10px; font-weight:700; line-height:1.5; padding:0 7px; border-radius:9px; white-space:nowrap; }
        .wa-tg-bubble-hidden { display:none; opacity:.75; }
        .wa-tg-more { font-size:9.5px; color:#96949c; white-space:nowrap; }
        [data-wa-tg-row]:hover .wa-tg-bubble-hidden, span[data-wa-tg-key]:hover .wa-tg-bubble-hidden { display:inline-flex; }
        [data-wa-tg-row]:hover .wa-tg-more, span[data-wa-tg-key]:hover .wa-tg-more { display:none; }

        .wa-tg-wrap { display:flex; flex-direction:column; gap:8px; font-family:-apple-system,sans-serif; font-size:11px; color:var(--igls-text,#ece9e4); }
        .wa-tg-input { flex:1; background:var(--igls-surface-2,#1c1c23); color:var(--igls-text,#ece9e4); border:1px solid var(--igls-border,rgba(255,255,255,.08)); border-radius:6px; padding:7px 8px; font-size:11px; outline:none; min-width:0; }
        .wa-tg-input:focus { border-color:var(--igls-accent,#c9a876); }
        .wa-tg-btn { background:rgba(255,255,255,.06); color:var(--igls-text,#ece9e4); border:1px solid var(--igls-border,rgba(255,255,255,.08)); border-radius:6px; padding:6px 10px; font-size:11px; font-weight:600; cursor:pointer; }
        .wa-tg-btn:hover { filter:brightness(1.15); }
        .wa-tg-btn-accent { background:var(--igls-accent,#c9a876); color:#171208; border:none; font-weight:700; }
        .wa-tg-row { display:flex; gap:6px; align-items:center; }
        .wa-tg-hint { font-size:10px; color:var(--igls-text-dim,#96949c); line-height:1.4; }
        .wa-tg-list { display:flex; flex-direction:column; gap:4px; }
        .wa-tg-item { display:flex; align-items:center; gap:6px; padding:3px 4px; border-radius:6px; }
        .wa-tg-item:hover { background:rgba(255,255,255,.04); }
        .wa-tg-color { width:20px; height:20px; border:none; border-radius:50%; padding:0; cursor:pointer; background:transparent; flex-shrink:0; }
        .wa-tg-color::-webkit-color-swatch-wrapper { padding:0; }
        .wa-tg-color::-webkit-color-swatch { border:none; border-radius:50%; }
        .wa-tg-txt { width:20px; height:20px; flex-shrink:0; padding:0; border:1px solid rgba(255,255,255,.18); border-radius:5px; font-size:11px; font-weight:800; line-height:1; cursor:pointer; font-family:-apple-system,sans-serif; }
        .wa-tg-txt:hover { outline:1px solid var(--igls-accent,#c9a876); }
        .wa-tg-chip { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; cursor:pointer; }
        .wa-tg-chip-dim { color:var(--igls-text-dim,#96949c); font-style:italic; cursor:default; }
        .wa-tg-icon { background:transparent; border:none; cursor:pointer; font-size:12px; padding:2px 4px; border-radius:4px; opacity:.75; }
        .wa-tg-icon:hover { opacity:1; background:rgba(255,255,255,.08); }
        .wa-tg-empty { font-size:10px; color:var(--igls-text-dim,#96949c); padding:8px; border:1px dashed var(--igls-border,rgba(255,255,255,.15)); border-radius:6px; text-align:center; }
        .wa-tg-divider { border-top:1px solid var(--igls-border,rgba(255,255,255,.08)); padding-top:8px; display:flex; flex-direction:column; gap:6px; }
        .wa-tg-label { font-size:9.5px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:var(--igls-text-dim,#96949c); }
        .wa-tg-check { display:flex; align-items:center; gap:6px; font-size:10.5px; color:var(--igls-text-dim,#96949c); cursor:pointer; }
        .wa-tg-gear { flex:0 0 auto !important; padding-left:9px; padding-right:9px; }
        .wa-tg-settings { display:flex; flex-direction:column; gap:12px; }
        .wa-tg-sec { display:flex; flex-direction:column; gap:5px; }
        .wa-tg-sec + .wa-tg-sec { border-top:1px solid var(--igls-border,rgba(255,255,255,.08)); padding-top:10px; }
        .wa-tg-link { background:none; border:none; padding:0; color:var(--igls-text-dim,#96949c); font-size:10px; cursor:pointer; text-align:left; text-decoration:underline; }
        .wa-tg-link:hover { color:var(--igls-accent,#c9a876); }
        #wa-tg-status:empty { display:none; }
        .wa-tg-step { display:flex; align-items:center; justify-content:space-between; gap:6px; font-size:10.5px; color:var(--igls-text-dim,#96949c); }
        .wa-tg-step-btns { display:flex; gap:4px; }
        .wa-tg-step-btn { width:24px; height:24px; border-radius:5px; background:rgba(255,255,255,.06); border:1px solid var(--igls-border,rgba(255,255,255,.08)); color:var(--igls-text,#ece9e4); cursor:pointer; font-size:13px; font-weight:700; line-height:1; }
        .wa-tg-step-btn:hover { color:var(--igls-accent,#c9a876); }
        .wa-tg-preview { display:flex; align-items:center; gap:4px; flex-wrap:wrap; padding:8px; border-radius:6px; background:var(--igls-surface-2,#1c1c23); font-size:12px; }
      `;
      document.head.appendChild(style);
    }

    // ---------------- Bubble rendering in the chat list ----------------
    function renderName(span, raw) {
      const { base, tags } = parseName(raw);

      span.style.whiteSpace = 'normal';
      span.style.overflow = 'visible';
      span.style.textOverflow = 'unset';
      span.style.maxWidth = 'none';
      span.style.display = 'inline-flex';
      span.style.flexWrap = 'wrap';
      span.style.alignItems = 'center';
      span.style.gap = '4px';

      span.textContent = '';
      span.appendChild(document.createTextNode(base));

      let hiddenCount = 0;
      tags.forEach(t => {
        const st = styleFor(t);
        const b = document.createElement('span');
        b.className = 'wa-tg-bubble' + (st.hidden ? ' wa-tg-bubble-hidden' : '');
        b.textContent = t;
        b.style.backgroundColor = st.color;
        b.style.color = textFor(st);
        applyLook(b);
        span.appendChild(b);
        if (st.hidden) hiddenCount++;
      });

      if (hiddenCount) {
        const more = document.createElement('span');
        more.className = 'wa-tg-more';
        more.textContent = '+' + hiddenCount;
        span.appendChild(more);
      }
    }

    function applyLook(el) {
      const { font, pad, radius } = config.look;
      el.style.fontSize = font + 'px';
      el.style.padding = `${Math.max(1, Math.round(pad / 3))}px ${pad}px`;
      el.style.borderRadius = radius + 'px';
    }

    function revertName(span) {
      ['whiteSpace', 'overflow', 'textOverflow', 'maxWidth', 'display', 'flexWrap', 'alignItems', 'gap'].forEach(p => { span.style[p] = ''; });
      span.textContent = span.getAttribute('title') || '';
      delete span.dataset.waTgKey;
    }

    let lastDebug = '';
    function scanAndRender() {
      if (!config.enabled) return;
      const spans = getNameSpans();
      let tagged = 0;
      spans.forEach(span => {
        const raw = span.getAttribute('title') || '';
        const hasTags = /\([^()]*\S[^()]*\)/.test(raw);
        if (!hasTags) {
          if (span.dataset.waTgKey) revertName(span);
          return;
        }
        tagged++;
        // Marca la fila completa para que el hover muestre las ocultas
        const row = span.closest(ROWISH_SELECTOR);
        if (row && !row.hasAttribute('data-wa-tg-row')) row.setAttribute('data-wa-tg-row', '');

        const key = raw + '|' + configVersion;
        // Skip if already rendered (and WhatsApp hasn't overwritten our content)
        if (span.dataset.waTgKey === key && span.querySelector('.wa-tg-bubble')) return;
        renderName(span, raw);
        span.dataset.waTgKey = key;
      });
      if (DEBUG) {
        const msg = `[etiquetas] ${spans.length} nombres en la lista, ${tagged} con (etiquetas)`;
        if (msg !== lastDebug) { console.log(msg); lastDebug = msg; }
      }
    }
    setInterval(scanAndRender, 700);

    function revertAll() {
      document.querySelectorAll('span[data-wa-tg-key]').forEach(revertName);
    }

    // ---------------- Panel ----------------
    const wrap = document.createElement('div');
    wrap.className = 'wa-tg-wrap';
    wrap.innerHTML = `
      <div class="wa-tln-header-btns">
        <button id="wa-tg-new-tag" class="wa-tln-hbtn">🏷️ Nueva</button>
        <button id="wa-tg-new-fold" class="wa-tln-hbtn">📁 Carpeta</button>
        <button id="wa-tg-gear" class="wa-tln-hbtn wa-tg-gear" title="Ajustes">⚙️</button>
      </div>

      <!-- Vista principal: solo el árbol -->
      <div id="wa-tg-main">
        <div id="wa-tg-tree" class="wa-tln-tree"></div>
      </div>

      <!-- Vista de ajustes (⚙️) -->
      <div id="wa-tg-settings" class="wa-tg-settings" style="display:none;">
        <div class="wa-tg-sec">
          <div class="wa-tg-label">Burbujas</div>
          <label class="wa-tg-check"><input type="checkbox" id="wa-tg-enabled"> Mostrar burbujas</label>
          <div id="wa-tg-special" class="wa-tg-list"></div>
        </div>

        <div class="wa-tg-sec">
          <div class="wa-tg-label">Apariencia</div>
          <div class="wa-tg-step"><span>Tamaño <b data-look-val="font"></b></span>
            <div class="wa-tg-step-btns"><button class="wa-tg-step-btn" data-look="font" data-d="-0.5">−</button><button class="wa-tg-step-btn" data-look="font" data-d="0.5">+</button></div></div>
          <div class="wa-tg-step"><span>Relleno <b data-look-val="pad"></b></span>
            <div class="wa-tg-step-btns"><button class="wa-tg-step-btn" data-look="pad" data-d="-1">−</button><button class="wa-tg-step-btn" data-look="pad" data-d="1">+</button></div></div>
          <div class="wa-tg-step"><span>Redondez <b data-look-val="radius"></b></span>
            <div class="wa-tg-step-btns"><button class="wa-tg-step-btn" data-look="radius" data-d="-1">−</button><button class="wa-tg-step-btn" data-look="radius" data-d="1">+</button></div></div>
          <div class="wa-tg-preview" id="wa-tg-preview"></div>
          <button id="wa-tg-look-reset" class="wa-tg-link">Restablecer apariencia</button>
        </div>

        <div class="wa-tg-sec">
          <div class="wa-tg-label">Excel</div>
          <div class="wa-tg-row">
            <button id="wa-tg-export-tags" class="wa-tg-btn" style="flex:1;">⬇️ Etiquetas</button>
            <button id="wa-tg-import-tags" class="wa-tg-btn" style="flex:1;">⬆️ Importar</button>
            <input type="file" id="wa-tg-import-file" accept=".xlsx,.xls,.csv" style="display:none;">
          </div>
          <button id="wa-tg-export-contacts" class="wa-tg-btn">⬇️ Contactos etiquetados</button>
        </div>
      </div>

      <div id="wa-tg-status" class="wa-tg-hint"></div>
    `;

    const $ = sel => wrap.querySelector(sel);
    // Mensaje breve bajo la lista; se borra solo (salvo durante el escaneo)
    let statusTimer = null;
    const setStatus = (msg, sticky) => {
      $('#wa-tg-status').textContent = msg || '';
      clearTimeout(statusTimer);
      if (msg && !sticky) statusTimer = setTimeout(() => { $('#wa-tg-status').textContent = ''; }, 5000);
    };

    function makeItem({ label, entry, hidden, copyable, dim, onColor, onToggleHidden, onDelete }) {
      const item = document.createElement('div');
      item.className = 'wa-tg-item';

      const txt = makeTextToggle(entry, () => { save(); renderLook(); });
      const sw = document.createElement('input');
      sw.type = 'color';
      sw.className = 'wa-tg-color';
      sw.value = entry.color;
      sw.title = 'Cambiar color';
      sw.addEventListener('change', () => { onColor(sw.value); txt.repaint(); });
      item.appendChild(sw);
      item.appendChild(txt);

      const chip = document.createElement('span');
      chip.className = 'wa-tg-chip' + (dim ? ' wa-tg-chip-dim' : '');
      chip.textContent = label;
      if (copyable) {
        chip.title = `Copiar (${label})`;
        chip.onclick = () => copyText(`(${label})`, () => {
          chip.textContent = '✅ Copiado';
          setTimeout(() => { chip.textContent = label; }, 900);
        });
      }
      item.appendChild(chip);

      const eye = document.createElement('button');
      eye.className = 'wa-tg-icon';
      eye.textContent = hidden ? '🙈' : '👁';
      eye.title = hidden ? 'Oculta (se ve al pasar el cursor). Clic para mostrar.' : 'Visible. Clic para ocultar.';
      eye.onclick = onToggleHidden;
      item.appendChild(eye);

      if (onDelete) {
        const del = document.createElement('button');
        del.className = 'wa-tg-icon';
        del.textContent = '🗑️';
        del.title = 'Eliminar de la lista';
        del.onclick = onDelete;
        item.appendChild(del);
      }
      return item;
    }

    // ---------------- Árbol de carpetas + etiquetas (mismo formato que Saved Messages) ----------------
    let draggedItem = null;

    const findFolder = id => config.folders.find(f => f.id === id);
    const findAny = id => config.tags.find(t => t.id === id) || findFolder(id);
    // Si la carpeta padre ya no existe, el elemento se muestra en la raíz
    const parentOf = item => (item.parentId && item.parentId !== 'root' && findFolder(item.parentId)) ? item.parentId : 'root';

    function isInside(folderId, maybeAncestorId) {
      let cur = findFolder(folderId);
      while (cur) {
        if (cur.id === maybeAncestorId) return true;
        cur = findFolder(parentOf(cur));
      }
      return false;
    }
    function tagsUnder(folderId) {
      return config.tags.filter(t => {
        const p = parentOf(t);
        return p === folderId || (p !== 'root' && isInside(p, folderId));
      });
    }

    function clearDropMarks(el) { el.classList.remove('wa-tln-drop-top', 'wa-tln-drop-bottom', 'wa-tln-drop-inside'); }
    function handleDragStart(e, id) { draggedItem = id; e.target.style.opacity = '0.4'; e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', id); } catch (err) { /* ignore */ } }
    function handleDragOver(e, targetId, targetType) {
      e.preventDefault();
      if (!draggedItem || draggedItem === targetId) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const offset = e.clientY - rect.top;
      clearDropMarks(e.currentTarget);
      if (targetType === 'folder' && offset > rect.height * 0.25 && offset < rect.height * 0.75) e.currentTarget.classList.add('wa-tln-drop-inside');
      else if (offset < rect.height / 2) e.currentTarget.classList.add('wa-tln-drop-top');
      else e.currentTarget.classList.add('wa-tln-drop-bottom');
    }
    function handleDrop(e, targetId, targetType) {
      e.preventDefault();
      clearDropMarks(e.currentTarget);
      if (!draggedItem || draggedItem === targetId) return;
      const dragged = findAny(draggedItem);
      const target = findAny(targetId);
      if (!dragged || !target) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const offset = e.clientY - rect.top;
      const draggedIsFolder = !!findFolder(dragged.id);

      let newParent, newOrder = dragged.order;
      if (targetType === 'folder' && offset > rect.height * 0.25 && offset < rect.height * 0.75) {
        newParent = target.id;
        newOrder = Date.now();
      } else {
        newParent = parentOf(target);
        newOrder = offset < rect.height / 2 ? target.order - 0.5 : target.order + 0.5;
      }
      // Una carpeta no puede ir dentro de sí misma ni de sus subcarpetas
      if (draggedIsFolder && newParent !== 'root' && (newParent === dragged.id || isInside(newParent, dragged.id))) return;

      dragged.parentId = newParent;
      dragged.order = newOrder;
      save(false);
      renderTree();
    }
    function bindDropTarget(el, id, type) {
      el.addEventListener('dragover', e => handleDragOver(e, id, type));
      el.addEventListener('dragleave', e => clearDropMarks(e.currentTarget));
      el.addEventListener('drop', e => handleDrop(e, id, type));
    }

    function renderTree() {
      const root = $('#wa-tg-tree');
      root.innerHTML = '';
      let counter = 0;

      if (!config.tags.length && !config.folders.length) {
        const empty = document.createElement('div');
        empty.className = 'wa-tg-empty';
        empty.textContent = 'Aún no hay etiquetas. Usa 🏷️ Nueva para crear una y 📁 Carpeta para organizarlas.';
        root.appendChild(empty);
        return;
      }

      function buildNode(parentId, container) {
        const children = [
          ...config.folders.filter(f => parentOf(f) === parentId).map(f => ({ item: f, type: 'folder' })),
          ...config.tags.filter(t => parentOf(t) === parentId).map(t => ({ item: t, type: 'tag' }))
        ].sort((a, b) => a.item.order - b.item.order);

        children.forEach(({ item, type }) => {
          const el = document.createElement('div');

          if (type === 'folder') {
            const inside = tagsUnder(item.id);
            const allHidden = inside.length > 0 && inside.every(t => t.hidden);
            el.className = 'wa-tln-folder-head';
            el.draggable = true;
            el.addEventListener('dragstart', e => handleDragStart(e, item.id));
            el.addEventListener('dragend', e => { e.target.style.opacity = '1'; draggedItem = null; });
            bindDropTarget(el, item.id, 'folder');
            el.innerHTML = `
              <span class="wa-tln-caret ${item.collapsed ? 'collapsed' : ''}">▼</span>
              <span class="wa-tg-fold-name"></span>
              <button class="wa-tln-btn" data-role="add" style="margin-left:auto;" title="Nueva etiqueta en esta carpeta">➕</button>
              <button class="wa-tln-btn" data-role="eye" title="${allHidden ? 'Mostrar todas las etiquetas de la carpeta' : 'Ocultar todas las etiquetas de la carpeta'}">${allHidden ? '🙈' : '👁'}</button>
              <button class="wa-tln-btn" data-role="edit" title="Renombrar / eliminar carpeta">⚙️</button>`;
            el.querySelector('.wa-tg-fold-name').textContent = `📁 ${item.name} (${inside.length})`;

            const content = document.createElement('div');
            content.className = `wa-tln-folder-content ${item.collapsed ? 'collapsed' : ''}`;

            el.querySelector('.wa-tln-caret').onclick = e => { e.stopPropagation(); item.collapsed = !item.collapsed; save(false); renderTree(); };
            el.querySelector('[data-role="add"]').onclick = e => { e.stopPropagation(); createTag(item.id); };
            el.querySelector('[data-role="eye"]').onclick = e => {
              e.stopPropagation();
              if (!inside.length) return;
              inside.forEach(t => { t.hidden = !allHidden; });
              save(); renderTree();
            };
            el.querySelector('[data-role="edit"]').onclick = e => {
              e.stopPropagation();
              const action = prompt(`Carpeta: "${item.name}"\n\nEscribe un nombre nuevo para renombrarla.\nEscribe BORRAR para eliminar la carpeta (sus etiquetas NO se borran, pasan a la carpeta de arriba).`);
              if (!action || !action.trim()) return;
              if (action.trim() === 'BORRAR') {
                const up = parentOf(item);
                config.tags.forEach(t => { if (t.parentId === item.id) t.parentId = up; });
                config.folders.forEach(f => { if (f.parentId === item.id) f.parentId = up; });
                config.folders = config.folders.filter(f => f.id !== item.id);
              } else {
                item.name = action.trim();
              }
              save(false); renderTree();
            };

            container.appendChild(el);
            container.appendChild(content);
            buildNode(item.id, content);
          } else {
            counter++;
            el.className = `wa-tln-item ${counter % 2 === 0 ? 'alt-bg' : ''}`;
            el.dataset.id = item.id;
            el.title = `Clic para copiar (${item.name}) · arrastra ⠿ para mover`;
            el.innerHTML = `
              <div class="wa-tln-row">
                <span class="wa-tln-drag-grip" draggable="true">⠿</span>
                <input type="color" class="wa-tg-color" title="Cambiar color">
                <div class="wa-tln-title-col"></div>
                <div class="wa-tln-actions">
                  <button class="wa-tln-btn" data-role="eye" title="${item.hidden ? 'Oculta (se ve al pasar el cursor). Clic para mostrar.' : 'Visible. Clic para ocultar.'}">${item.hidden ? '🙈' : '👁'}</button>
                  <button class="wa-tln-btn" data-role="rename" title="Renombrar">✏️</button>
                  <button class="wa-tln-btn" data-role="del" title="Quitar de la lista">🗑️</button>
                </div>
              </div>`;
            const title = el.querySelector('.wa-tln-title-col');
            title.textContent = item.name;
            if (item.hidden) title.style.opacity = '0.55';

            const sw = el.querySelector('.wa-tg-color');
            sw.value = item.color;
            sw.addEventListener('click', e => e.stopPropagation());
            const txt = makeTextToggle(item, () => { save(); renderLook(); });
            sw.after(txt);
            sw.addEventListener('change', () => { item.color = sw.value; txt.repaint(); save(); renderLook(); });

            const grip = el.querySelector('.wa-tln-drag-grip');
            grip.addEventListener('dragstart', e => handleDragStart(e, item.id));
            grip.addEventListener('dragend', e => { e.target.style.opacity = '1'; draggedItem = null; });
            bindDropTarget(el, item.id, 'tag');

            // Clic en la fila = copiar "(Etiqueta)"
            el.onclick = e => {
              e.stopPropagation();
              if (e.target.closest('button') || e.target.classList.contains('wa-tln-drag-grip') || e.target === sw) return;
              copyText(`(${item.name})`, () => {
                const original = el.style.background;
                el.style.background = 'rgba(37,211,102,0.2)';
                title.textContent = '✅ Copiado';
                setTimeout(() => { el.style.background = original; title.textContent = item.name; }, 700);
              });
            };
            el.querySelector('[data-role="eye"]').onclick = e => { e.stopPropagation(); item.hidden = !item.hidden; save(); renderTree(); };
            el.querySelector('[data-role="rename"]').onclick = e => {
              e.stopPropagation();
              const name = (prompt('Nuevo nombre de la etiqueta:', item.name) || '').replace(/[()]/g, '').trim();
              if (!name || name === item.name) return;
              const dup = findTag(name);
              if (dup && dup !== item) { alert(`"${name}" ya existe.`); return; }
              item.name = name;
              save(); renderTree(); renderLook();
              setStatus('Ojo: los contactos que ya tenían el nombre antiguo no cambian solos.');
            };
            el.querySelector('[data-role="del"]').onclick = e => {
              e.stopPropagation();
              if (!confirm(`¿Quitar "${item.name}" de la lista?\n\nLos contactos no cambian; esa etiqueta solo pasará al color de "Otras".`)) return;
              config.tags = config.tags.filter(t => t !== item);
              save(); renderTree(); renderLook();
            };

            container.appendChild(el);
          }
        });
      }

      buildNode('root', root);
    }

    function createTag(parentId) {
      const raw = prompt('Nombre de la etiqueta (ej: ACN, Pagado, Generación 5):');
      const name = (raw || '').replace(/[()]/g, '').trim();
      if (!name) return;
      if (findTag(name)) { alert(`"${name}" ya está en la lista.`); return; }
      if (parentId !== 'root') { const f = findFolder(parentId); if (f) f.collapsed = false; }
      config.tags.push({ id: newId('tag_'), name, color: nextPaletteColor(), hidden: false, parentId, order: Date.now() });
      save();
      setStatus('');
      renderTree();
      renderLook();
    }

    function renderPanel() {
      renderTree();

      const special = $('#wa-tg-special');
      special.innerHTML = '';
      special.appendChild(makeItem({
        label: 'Números (cualquier número)',
        entry: config.numbers,
        hidden: config.numbers.hidden,
        dim: true,
        onColor: c => { config.numbers.color = c; save(); },
        onToggleHidden: () => { config.numbers.hidden = !config.numbers.hidden; save(); renderPanel(); }
      }));
      special.appendChild(makeItem({
        label: 'Otras (no están en la lista)',
        entry: config.others,
        hidden: config.others.hidden,
        dim: true,
        onColor: c => { config.others.color = c; save(); },
        onToggleHidden: () => { config.others.hidden = !config.others.hidden; save(); renderPanel(); }
      }));

      $('#wa-tg-enabled').checked = config.enabled;
      renderLook();
    }

    // ---------------- Apariencia (tamaño / relleno / redondez) ----------------
    const LOOK_MIN = { font: 6, pad: 2, radius: 0 };
    const LOOK_MAX = { font: 18, pad: 20, radius: 20 };

    function renderLook() {
      wrap.querySelectorAll('[data-look-val]').forEach(el => { el.textContent = config.look[el.dataset.lookVal]; });
      const prev = $('#wa-tg-preview');
      prev.innerHTML = '';
      prev.appendChild(document.createTextNode('Pablo Perez'));
      const samples = config.tags.length
        ? config.tags.slice(0, 3).map(t => ({ label: t.name, entry: t }))
        : [{ label: 'ACN', entry: { color: PALETTE[0] } }, { label: 'Pagado', entry: { color: PALETTE[1] } }];
      samples.push({ label: '50000', entry: config.numbers });
      samples.forEach(s => {
        const b = document.createElement('span');
        b.className = 'wa-tg-bubble';
        b.textContent = s.label;
        b.style.backgroundColor = s.entry.color;
        b.style.color = textFor(s.entry);
        applyLook(b);
        prev.appendChild(b);
      });
    }

    wrap.querySelectorAll('.wa-tg-step-btn').forEach(btn => {
      btn.onclick = () => {
        const k = btn.dataset.look;
        const v = Math.round((config.look[k] + parseFloat(btn.dataset.d)) * 2) / 2;
        config.look[k] = Math.min(LOOK_MAX[k], Math.max(LOOK_MIN[k], v));
        save();
        renderLook();
      };
    });
    $('#wa-tg-look-reset').onclick = () => {
      config.look = defaultConfig().look;
      save();
      renderLook();
    };

    // ⚙️ alterna entre la lista y los ajustes
    function showSettings(open) {
      $('#wa-tg-main').style.display = open ? 'none' : '';
      $('#wa-tg-settings').style.display = open ? '' : 'none';
      $('#wa-tg-gear').classList.toggle('active-filter', open);
      $('#wa-tg-new-tag').style.display = open ? 'none' : '';
      $('#wa-tg-new-fold').style.display = open ? 'none' : '';
      $('#wa-tg-gear').textContent = open ? '← Volver' : '⚙️';
      $('#wa-tg-gear').title = open ? 'Volver a la lista' : 'Ajustes';
    }
    $('#wa-tg-gear').onclick = () => showSettings($('#wa-tg-settings').style.display === 'none');

    $('#wa-tg-new-tag').onclick = () => createTag('root');
    $('#wa-tg-new-fold').onclick = () => {
      const name = (prompt('Nombre de la carpeta (ej: Cursos, Pagos, Generaciones):') || '').trim();
      if (!name) return;
      config.folders.push({ id: newId('fld_'), name, collapsed: false, parentId: 'root', order: Date.now() });
      save(false);
      renderTree();
    };

    $('#wa-tg-enabled').onchange = e => {
      config.enabled = e.target.checked;
      save();
      if (!config.enabled) revertAll();
    };

    // ---------------- Clipboard ----------------
    function copyText(text, cb) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(cb).catch(() => fallbackCopy(text, cb));
      } else fallbackCopy(text, cb);
    }
    function fallbackCopy(text, cb) {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); cb(); } catch (e) { /* ignore */ }
      document.body.removeChild(ta);
    }

    // ---------------- Excel / CSV helpers ----------------
    const today = () => new Date().toISOString().slice(0, 10);

    function toCsvValue(v) {
      const s = String(v == null ? '' : v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }

    function downloadSheet(rows, sheetName, fileBase) {
      if (typeof XLSX !== 'undefined') {
        const ws = XLSX.utils.aoa_to_sheet(rows);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, sheetName);
        XLSX.writeFile(wb, `${fileBase}_${today()}.xlsx`);
        return 'Excel';
      }
      const csv = '\uFEFF' + rows.map(r => r.map(toCsvValue).join(',')).join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${fileBase}_${today()}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      return 'CSV (falta la línea @require de XLSX para Excel)';
    }

    function parseCsv(text) {
      const rows = [];
      let row = [], field = '', inQuotes = false;
      text = text.replace(/^\uFEFF/, '');
      for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQuotes) {
          if (c === '"') {
            if (text[i + 1] === '"') { field += '"'; i++; }
            else inQuotes = false;
          } else field += c;
        } else {
          if (c === '"') inQuotes = true;
          else if (c === ',') { row.push(field); field = ''; }
          else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
          else if (c === '\r') { /* skip */ }
          else field += c;
        }
      }
      if (field.length || row.length) { row.push(field); rows.push(row); }
      return rows.filter(r => r.some(cell => String(cell).trim() !== ''));
    }

    function readRowsFromFile(file) {
      return new Promise((resolve, reject) => {
        const isXlsx = /\.(xlsx|xls)$/i.test(file.name);
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('No se pudo leer el archivo.'));
        if (isXlsx) {
          if (typeof XLSX === 'undefined') {
            reject(new Error('Para leer .xlsx falta la línea @require de XLSX en el encabezado. Usa un .csv o agrega la línea.'));
            return;
          }
          reader.onload = () => {
            try {
              const wb = XLSX.read(new Uint8Array(reader.result), { type: 'array' });
              const ws = wb.Sheets[wb.SheetNames[0]];
              resolve(XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }));
            } catch (err) { reject(err); }
          };
          reader.readAsArrayBuffer(file);
        } else {
          reader.onload = () => resolve(parseCsv(String(reader.result)));
          reader.readAsText(file, 'utf-8');
        }
      });
    }

    // ---------------- Export / import tag list ----------------
    $('#wa-tg-export-tags').onclick = () => {
      // Ruta de carpeta tipo "Cursos / 2026" (vacía = raíz)
      const folderPath = parentId => {
        const parts = [];
        let cur = parentId !== 'root' ? findFolder(parentId) : null;
        while (cur) { parts.unshift(cur.name); cur = findFolder(parentOf(cur)); }
        return parts.join(' / ');
      };
      // Mismo orden que se ve en el panel
      const ordered = [];
      (function walk(pid) {
        [...config.folders.filter(f => parentOf(f) === pid).map(f => ({ f })),
         ...config.tags.filter(t => parentOf(t) === pid).map(t => ({ t }))]
          .sort((a, b) => (a.f || a.t).order - (b.f || b.t).order)
          .forEach(x => { if (x.f) walk(x.f.id); else ordered.push(x.t); });
      })('root');

      const txtLabel = e => e.text === 'black' ? 'Negro' : e.text === 'white' ? 'Blanco' : '';
      const rows = [['Etiqueta', 'Color', 'Texto', 'Oculta', 'Carpeta']];
      ordered.forEach(t => rows.push([t.name, t.color, txtLabel(t), t.hidden ? 'Sí' : 'No', folderPath(parentOf(t))]));
      // Carpetas vacías también viajan (fila sin etiqueta)
      config.folders.filter(f => !tagsUnder(f.id).length).forEach(f => rows.push(['', '', '', '', folderPath(f.id)]));
      rows.push([NUMBERS_LABEL, config.numbers.color, txtLabel(config.numbers), config.numbers.hidden ? 'Sí' : 'No', '']);
      rows.push([OTHERS_LABEL, config.others.color, txtLabel(config.others), config.others.hidden ? 'Sí' : 'No', '']);
      const fmt = downloadSheet(rows, 'Etiquetas', 'etiquetas_whatsapp');
      setStatus(`Lista exportada en ${fmt}.`);
    };

    $('#wa-tg-import-tags').onclick = () => $('#wa-tg-import-file').click();

    $('#wa-tg-import-file').addEventListener('change', async e => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      let rows;
      try { rows = await readRowsFromFile(file); }
      catch (err) { setStatus(err.message); return; }

      if (!rows || rows.length < 2) { setStatus('El archivo no tiene filas.'); return; }
      const header = rows[0].map(h => norm(h));
      const iName = header.indexOf('etiqueta');
      const iColor = header.indexOf('color');
      const iHidden = header.indexOf('oculta');
      const iText = header.indexOf('texto');
      const iFolder = header.indexOf('carpeta');
      if (iName === -1) { setStatus('Falta la columna "Etiqueta".'); return; }

      // Carpetas: se crean a partir de la ruta "A / B"
      const newFolders = [];
      let orderSeq = 0;
      const folderFor = path => {
        const parts = String(path || '').split('/').map(s => s.trim()).filter(Boolean);
        let parent = 'root';
        parts.forEach(name => {
          let f = newFolders.find(x => x.parentId === parent && norm(x.name) === norm(name));
          if (!f) { f = { id: newId('fld_'), name, collapsed: false, parentId: parent, order: orderSeq++ }; newFolders.push(f); }
          parent = f.id;
        });
        return parent;
      };

      const isTrue = v => /^(sí|si|true|verdadero|1|x)$/i.test(String(v || '').trim());
      const validColor = v => /^#[0-9a-f]{6}$/i.test(String(v || '').trim()) ? String(v).trim() : null;

      const newTags = [];
      let numbers = config.numbers, others = config.others;
      for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        const name = String(r[iName] || '').replace(/[()]/g, '').trim();
        const rawName = String(r[iName] || '').trim();
        const folderPathCell = iFolder !== -1 ? r[iFolder] : '';
        if (!name) {
          if (folderPathCell) folderFor(folderPathCell); // carpeta vacía
          continue;
        }
        const color = (iColor !== -1 && validColor(r[iColor])) || null;
        const hidden = iHidden !== -1 && isTrue(r[iHidden]);
        const txtRaw = iText !== -1 ? norm(r[iText]) : '';
        const text = /^(negro|black)$/.test(txtRaw) ? 'black' : /^(blanco|white)$/.test(txtRaw) ? 'white' : undefined;

        if (rawName === NUMBERS_LABEL) { numbers = { color: color || numbers.color, hidden, text }; continue; }
        if (rawName === OTHERS_LABEL) { others = { color: color || others.color, hidden, text }; continue; }
        if (newTags.some(t => norm(t.name) === norm(name))) continue;
        const parentId = folderFor(folderPathCell);
        newTags.push({ id: newId('tag_'), name, color: color || PALETTE[newTags.length % PALETTE.length], hidden, text, parentId, order: orderSeq++ });
      }

      if (!newTags.length) { setStatus('No se encontraron etiquetas en el archivo.'); return; }
      const folderNote = newFolders.length ? ` en ${newFolders.length} carpeta(s)` : '';
      if (!confirm(`Esto reemplazará tu lista actual (${config.tags.length} etiqueta(s), ${config.folders.length} carpeta(s)) por ${newTags.length} etiqueta(s)${folderNote} del archivo.\n\n¿Continuar?`)) {
        setStatus('Importación cancelada.');
        return;
      }
      config.tags = newTags;
      config.folders = newFolders;
      config.numbers = numbers;
      config.others = others;
      save();
      renderPanel();
      setStatus(`✅ ${newTags.length} etiqueta(s) importadas.`);
    });

    // ---------------- Export tagged contacts ----------------
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    async function collectTaggedContacts() {
      const scroller = document.querySelector(SCROLL_CONTAINER_SELECTOR);
      if (!scroller) return null;
      const collected = new Map();
      scroller.scrollTop = 0;
      await sleep(200);

      let last = -1, stable = 0, safety = 0;
      while (stable < 3 && safety < 400) {
        getNameSpans().forEach(span => {
          const raw = span.getAttribute('title') || '';
          if (!collected.has(raw)) {
            const parsed = parseName(raw);
            if (parsed.tags.length) collected.set(raw, parsed);
          }
        });
        scroller.scrollTop += Math.max(scroller.clientHeight * 0.8, 200);
        await sleep(220);
        if (scroller.scrollTop === last) stable++; else stable = 0;
        last = scroller.scrollTop;
        safety++;
      }
      scroller.scrollTop = 0;
      return Array.from(collected.entries()).map(([raw, p]) => ({ raw, base: p.base, tags: p.tags }));
    }

    $('#wa-tg-export-contacts').onclick = async () => {
      const btn = $('#wa-tg-export-contacts');
      btn.disabled = true;
      btn.textContent = '⏳ Recorriendo chats...';
      setStatus('No desplaces la lista de chats mientras termina.', true);
      try {
        const contacts = await collectTaggedContacts();
        if (contacts === null) { setStatus('No se encontró la lista de chats.'); return; }
        if (!contacts.length) { setStatus('No se encontraron contactos con etiquetas.'); return; }

        const header = ['Nombre', 'Etiquetas', ...config.tags.map(t => t.name), 'Nombre completo'];
        const rows = [header];
        contacts.forEach(c => {
          const lower = c.tags.map(norm);
          rows.push([
            c.base,
            c.tags.join(', '),
            ...config.tags.map(t => lower.includes(norm(t.name)) ? '✓' : ''),
            c.raw
          ]);
        });
        const fmt = downloadSheet(rows, 'Contactos', 'contactos_etiquetados');
        setStatus(`✅ ${contacts.length} contacto(s) exportados en ${fmt}.`);
      } finally {
        btn.disabled = false;
        btn.textContent = '⬇️ Exportar contactos etiquetados';
      }
    };

    // ---------------- Mount ----------------
    function mountCard(attemptsLeft) {
      attemptsLeft = attemptsLeft === undefined ? 10 : attemptsLeft;
      if (typeof core.registerMenu === 'function') {
        injectStyles();
        core.registerMenu('left', '🏷️ Etiquetas', wrap, '⠿', 'simple-tags');
        renderPanel();
      } else if (attemptsLeft > 0) {
        setTimeout(() => mountCard(attemptsLeft - 1), 200);
      }
    }
    mountCard();

    core.emit('block:ready', { id: 'simpleTagsPlugin' });
  }
});

/* ============================================================
   BLOCK: Video Sender (v4)
   ============================================================ */
LegoCore.registerBlock({
  id: 'videoLibraryModule',
  init(core) {
    // ================= CONFIG =================
    const DATA_KEY = 'wa_video_library_v1';
    const METHOD_KEY = 'wa_vlc_attach_method';   // remembers which attach method works on your WhatsApp
    // Videos live in their OWN IndexedDB database, never in the shared "images" store,
    // so nothing else in the toolkit (sync, backups, image loaders) ever reads them.
    const VIDEO_DB_NAME = 'wa_video_library_db';
    const VIDEO_STORE = 'videos';
    const LEGACY_STORE = 'images';               // where v1 of this block put videos — migrated out on load

    const WARN_SIZE_MB = 100;  // ask before saving videos bigger than this (just a confirm, you can still save)
    const MAX_SIZE_MB = 180;   // matches what WhatsApp Web accepts for you; change freely
    const SENT_TIMEOUT_MS = 120000;

    // WhatsApp Web selectors — verify in DevTools if something stops working.
    const SEL = {
      attachBtn: [
        '[data-icon="plus-rounded"]', '[data-icon="plus"]', '[data-icon="attach-menu-plus"]', '[data-icon="clip"]',
        '[aria-label="Attach"]', '[aria-label="Adjuntar"]', '[title="Attach"]', '[title="Adjuntar"]'
      ],
      sendBtn: [
        '[data-icon="wds-ic-send-filled"]', '[data-icon="send"]',
        '[aria-label="Send"]', '[aria-label="Enviar"]'
      ]
    };

    // ================= HELPERS =================
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const notify = (msg) => { if (core.notifyError) core.notifyError(msg); else console.warn('[videoLib]', msg); };
    const isVisible = (el) => !!el && el.isConnected && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    // Toolkit UI only. WhatsApp itself renders its menus/popovers inside #wa-popovers-bucket,
    // which also starts with "wa-" — that must NOT count as ours, or the attach menu/preview gets ignored.
    const isOurUI = (el) => {
      if (!el) return false;
      if (el.closest('#wa-popovers-bucket')) return false;
      return !!el.closest('.wa-tln-container, .wa-tlp-modal-overlay, [class^="wa-"], [id^="wa-"]');
    };
    const log = (...a) => console.log('[videoLib]', ...a);
    const clickable = (el) => el.closest('button, [role="button"]') || el;
    const fmtDur = (s) => { if (!s || !isFinite(s)) return ''; s = Math.round(s); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
    const fmtMB = (b) => ((b || 0) / 1048576).toFixed(1) + ' MB';
    async function waitUntil(fn, timeout, step = 250) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) { if (fn()) return true; await sleep(step); }
      return false;
    }
    function qVisible(list, filter = () => true) {
      for (const s of list) {
        const el = [...document.querySelectorAll(s)].find(e => isVisible(e) && filter(e));
        if (el) return el;
      }
      return null;
    }

    const PLACEHOLDER_THUMB = 'data:image/svg+xml;utf8,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><rect width="100%" height="100%" fill="#1f2937"/>' +
      '<text x="50%" y="55%" font-size="40" text-anchor="middle" dominant-baseline="middle">🎬</text></svg>'
    );

    // ================= STYLES =================
    if (!document.getElementById('wa-vlc-styles')) {
      const style = document.createElement('style');
      style.id = 'wa-vlc-styles';
      style.textContent = `
        .wa-vlc-thumb-wrap { position: relative; display: inline-flex; flex-shrink: 0; }
        .wa-vlc-play { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
          font-size: 12px; color: #fff; text-shadow: 0 0 3px #000; pointer-events: none; }
        .wa-vlc-dur { position: absolute; right: 1px; bottom: 1px; font-size: 9px; line-height: 1; padding: 1px 3px;
          border-radius: 3px; background: rgba(0,0,0,.7); color: #fff; pointer-events: none; }
      `;
      document.head.appendChild(style);
    }

    // ================= DATA =================
    let libraryData;
    try { libraryData = JSON.parse(localStorage.getItem(DATA_KEY)) || { items: [] }; }
    catch (e) { libraryData = { items: [] }; }
    function saveData() { localStorage.setItem(DATA_KEY, JSON.stringify(libraryData)); core.emit('vidlib:changed', libraryData); }

    let activeFolderFilter = 'All';
    let draggedItem = null;

    core.getVideoLibrary = () => libraryData;

    // ================= OWN INDEXEDDB =================
    let dbPromise = null;
    function openVideoDb() {
      if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
          const req = indexedDB.open(VIDEO_DB_NAME, 1);
          req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(VIDEO_STORE)) db.createObjectStore(VIDEO_STORE, { keyPath: 'id' });
          };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => { dbPromise = null; reject(req.error); };
        });
      }
      return dbPromise;
    }
    async function saveBlobToDb(id, blob) {
      const db = await openVideoDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction([VIDEO_STORE], 'readwrite');
        tx.objectStore(VIDEO_STORE).put({ id, blob });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('Write failed'));
        tx.onabort = () => reject(tx.error || new Error('Write aborted (storage full?)'));
      });
    }
    async function deleteBlobFromDb(id) {
      try {
        const db = await openVideoDb();
        db.transaction([VIDEO_STORE], 'readwrite').objectStore(VIDEO_STORE).delete(id);
      } catch (e) { console.error('[videoLib]', e); }
    }
    async function getVideoBlob(id) {
      try {
        const db = await openVideoDb();
        return await new Promise((resolve) => {
          const req = db.transaction([VIDEO_STORE], 'readonly').objectStore(VIDEO_STORE).get(id);
          req.onsuccess = () => resolve(req.result ? req.result.blob : null);
          req.onerror = () => resolve(null);
        });
      } catch (e) { return null; }
    }
    core.getSavedVideoBlob = getVideoBlob;

    // ================= ONE-TIME MIGRATION OUT OF THE SHARED "images" STORE =================
    // v1 of this block stored videos next to your images. Move them into the video DB,
    // then delete every leftover "vid_" record there (keys only — no video data is loaded to find them).
    async function migrateFromSharedStore(attemptsLeft = 15) {
      const coreDb = core.getDb && core.getDb();
      if (!coreDb) { if (attemptsLeft > 0) setTimeout(() => migrateFromSharedStore(attemptsLeft - 1), 400); return; }
      if (!coreDb.objectStoreNames.contains(LEGACY_STORE)) return;

      const legacyKeys = await new Promise((resolve) => {
        const keys = [];
        try {
          const req = coreDb.transaction([LEGACY_STORE], 'readonly').objectStore(LEGACY_STORE).openKeyCursor();
          req.onsuccess = () => {
            const cur = req.result;
            if (!cur) return resolve(keys);
            if (typeof cur.key === 'string' && cur.key.startsWith('vid_')) keys.push(cur.key);
            cur.continue();
          };
          req.onerror = () => resolve(keys);
        } catch (e) { resolve(keys); }
      });
      if (!legacyKeys.length) return;

      const known = new Set(libraryData.items.filter(i => i.type === 'video').map(i => i.id));
      for (const id of legacyKeys) {
        if (known.has(id)) {
          const rec = await new Promise((resolve) => {
            try {
              const r = coreDb.transaction([LEGACY_STORE], 'readonly').objectStore(LEGACY_STORE).get(id);
              r.onsuccess = () => resolve(r.result || null);
              r.onerror = () => resolve(null);
            } catch (e) { resolve(null); }
          });
          if (rec && rec.blob) {
            try { await saveBlobToDb(id, rec.blob); }
            catch (e) { console.error('[videoLib] migration failed for', id, e); continue; } // keep original if copy failed
          }
        }
        try { coreDb.transaction([LEGACY_STORE], 'readwrite').objectStore(LEGACY_STORE).delete(id); } catch (e) {}
      }
      console.info(`[videoLib] moved ${legacyKeys.length} video record(s) out of the shared images store`);
    }

    // ================= THUMBNAIL =================
    function makeVideoThumb(file, maxSize = 200, quality = 0.7) {
      return new Promise((resolve) => {
        const url = URL.createObjectURL(file);
        const v = document.createElement('video');
        v.muted = true; v.playsInline = true; v.preload = 'metadata'; // only what's needed for one frame
        let done = false;
        const finish = (thumbnail) => {
          if (done) return; done = true;
          const duration = isFinite(v.duration) ? v.duration : 0;
          v.removeAttribute('src'); v.load();
          URL.revokeObjectURL(url);
          resolve({ thumbnail, duration });
        };
        v.onloadedmetadata = () => {
          const t = isFinite(v.duration) ? Math.min(0.5, v.duration / 2) : 0;
          v.currentTime = t;
        };
        v.onseeked = () => {
          try {
            let w = v.videoWidth, h = v.videoHeight;
            if (!w || !h) return finish(PLACEHOLDER_THUMB);
            const ratio = Math.min(1, maxSize / w, maxSize / h);
            w = Math.round(w * ratio); h = Math.round(h * ratio);
            const canvas = document.createElement('canvas');
            canvas.width = w; canvas.height = h;
            canvas.getContext('2d').drawImage(v, 0, 0, w, h);
            const data = canvas.toDataURL('image/jpeg', quality);
            canvas.width = canvas.height = 0; // release the bitmap
            finish(data);
          } catch (e) { finish(PLACEHOLDER_THUMB); }
        };
        v.onerror = () => finish(PLACEHOLDER_THUMB);
        setTimeout(() => finish(PLACEHOLDER_THUMB), 8000);
        v.src = url;
      });
    }

    // ================= SEND TO WHATSAPP =================
    const visibleEditables = () => new Set([...document.querySelectorAll('[contenteditable="true"]')].filter(isVisible));
    const visibleSendBtns = () => new Set(SEL.sendBtn.flatMap(s => [...document.querySelectorAll(s)]).filter(isVisible));

    function findPreviewSendBtn() {
      return qVisible(SEL.sendBtn, e => !e.closest('#main footer') && !isOurUI(e));
    }

    // The preview counts as open when a NEW caption box or a NEW send button (outside the chat footer) appears.
    async function waitForPreview(beforeEdit, beforeSend, timeout) {
      const t0 = Date.now();
      let sendSeenAt = 0;
      while (Date.now() - t0 < timeout) {
        const fresh = [...document.querySelectorAll('[contenteditable="true"]')]
          .find(el => isVisible(el) && !beforeEdit.has(el) && !el.closest('#main footer') && !isOurUI(el));
        if (fresh) return { opened: true, captionEl: fresh };
        const btn = findPreviewSendBtn();
        if (btn && !beforeSend.has(btn)) {
          if (!sendSeenAt) sendSeenAt = Date.now();
          else if (Date.now() - sendSeenAt > 800) return { opened: true, captionEl: null };
        }
        await sleep(200);
      }
      return { opened: false, captionEl: null };
    }

    function makeDataTransfer(file) {
      const dt = new DataTransfer();
      dt.items.add(file);
      return dt;
    }

    // Method "paste": paste the file into the chat's message box (same as Ctrl+V of a copied video).
    function findComposer() {
      return qVisible([
        '#main footer [contenteditable="true"][role="textbox"]',
        '#main footer [contenteditable="true"]',
        'footer [contenteditable="true"]'
      ], e => !isOurUI(e));
    }
    async function tryPaste(file) {
      const box = findComposer();
      if (!box) { log('paste: message box not found'); return null; }
      box.focus();
      await sleep(80);
      const dt = makeDataTransfer(file);
      let ev;
      try { ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }); } catch (e) { ev = null; }
      if (!ev || !ev.clipboardData || !ev.clipboardData.files || !ev.clipboardData.files.length) {
        // Some browsers ignore clipboardData in the constructor — attach it by hand.
        ev = new Event('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'clipboardData', { value: dt });
      }
      box.dispatchEvent(ev);
      return () => {};
    }

    // Method "input": put the file into WhatsApp's own "Photos & videos" file input.
    // Must skip our own hidden "📤 Upload" input (it also accepts video) — otherwise the
    // video gets re-saved into the library instead of being handed to WhatsApp.
    function findVideoInput() {
      return [...document.querySelectorAll('input[type="file"]')].find(i => /video/.test(i.accept || '') && !isOurUI(i));
    }
    async function tryFileInput(file) {
      let input = findVideoInput();
      if (!input) {
        const btn = qVisible(SEL.attachBtn, e => !isOurUI(e));
        if (!btn) { log('input: attach (+) button not found'); return null; }
        clickable(btn).click();
        await waitUntil(() => !!findVideoInput(), 1500, 100);
        input = findVideoInput();
      }
      if (!input) {
        log('input: no file input that accepts video');
        pressEscape();
        return null;
      }
      input.files = makeDataTransfer(file).files;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return () => pressEscape();
    }

    // Method "drop": fake a drag-and-drop of the file onto the open chat.
    async function tryDrop(file) {
      const main = document.querySelector('#main');
      if (!main) return null;
      const r = main.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      let target = document.elementFromPoint(x, y);
      if (!target || !main.contains(target)) target = main;

      const dt = makeDataTransfer(file);
      const fire = (el, type) => el.dispatchEvent(new DragEvent(type, {
        bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, dataTransfer: dt
      }));

      fire(target, 'dragenter');
      fire(target, 'dragover');
      await sleep(250);
      let dropEl = document.elementFromPoint(x, y) || target;
      if (isOurUI(dropEl)) dropEl = target;
      fire(dropEl, 'dragenter');
      fire(dropEl, 'dragover');
      fire(dropEl, 'drop');

      return () => { try { fire(dropEl, 'dragleave'); fire(target, 'dragleave'); } catch (e) {} };
    }

    function pressEscape() {
      const opts = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true };
      (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', opts));
    }

    const METHODS = { paste: tryPaste, input: tryFileInput, drop: tryDrop };
    const METHOD_ORDER = ['paste', 'input', 'drop'];

    async function insertCaption(captionEl, text) {
      if (captionEl) {
        captionEl.focus();
        await sleep(60);
        document.execCommand('insertText', false, text);
        await sleep(60);
        if ((captionEl.textContent || '').includes(text.slice(0, 12))) return true;
      }
      try { await navigator.clipboard.writeText(text); notify('Caption copied — paste it into the caption box.'); }
      catch (e) { notify('Could not add the caption automatically.'); }
      return false;
    }

    let busy = false;
    /**
     * Attach a File to the open chat through WhatsApp's media preview.
     * Tries the method that worked last time first, then the others — but only moves on
     * when the previous one clearly did nothing (no preview, re-checked before each try),
     * so the same video is never attached twice.
     * opts: { caption, autoSend, waitForSent }  →  { ok, method, sent, reason? }
     */
    async function sendMediaFile(file, opts = {}) {
      const { caption = '', autoSend = false, waitForSent = autoSend } = opts;
      if (busy) return { ok: false, reason: 'busy' };
      if (!document.querySelector('#main')) { notify('Open a chat first.'); return { ok: false, reason: 'no-chat' }; }
      if (file.size > MAX_SIZE_MB * 1048576) { notify(`Video is over ${MAX_SIZE_MB} MB — not sending.`); return { ok: false, reason: 'too-big' }; }

      busy = true;
      try {
        const remembered = localStorage.getItem(METHOD_KEY);
        const order = METHOD_ORDER.includes(remembered) ? [remembered, ...METHOD_ORDER.filter(m => m !== remembered)] : METHOD_ORDER;
        // WhatsApp shows the preview window quickly even for big files (it processes inside it).
        const timeout = Math.min(20000, 6000 + (file.size / 1048576) * 150);
        log(`attaching "${file.name}" (${fmtMB(file.size)}, ${file.type || 'no type'}) — order: ${order.join(' → ')}`);

        let preview = { opened: false, captionEl: null }, used = null;
        for (const method of order) {
          const beforeEdit = visibleEditables();
          const beforeSend = visibleSendBtns();
          let cleanup = null;
          try { cleanup = await METHODS[method](file); }
          catch (err) { log(`${method}: failed —`, err && err.message); pressEscape(); continue; }
          if (!cleanup) { log(`${method}: not available here, skipping`); continue; }
          preview = await waitForPreview(beforeEdit, beforeSend, timeout);
          if (preview.opened) { used = method; break; }
          log(`${method}: no preview after ${Math.round(timeout / 1000)} s`);
          cleanup();
          await sleep(400);
          // Late preview? Then stop here instead of attaching a second copy.
          if (findPreviewSendBtn() && !beforeSend.has(findPreviewSendBtn())) { used = method; preview = { opened: true, captionEl: null }; break; }
        }

        if (!preview.opened) {
          notify('WhatsApp did not open the video preview. Open the console (F12) and send the [videoLib] lines.');
          return { ok: false, reason: 'attach-failed' };
        }
        log(`preview opened with "${used}"`);
        localStorage.setItem(METHOD_KEY, used);

        if (caption) await insertCaption(preview.captionEl, caption);
        if (!autoSend) return { ok: true, method: used, sent: false };

        await sleep(300);
        const btn = findPreviewSendBtn();
        if (!btn) { notify('Preview is open, but the send button was not found — press Enter.'); return { ok: true, method: used, sent: false }; }
        clickable(btn).click();
        if (!waitForSent) return { ok: true, method: used, sent: true };

        const closed = await waitUntil(
          () => preview.captionEl ? !isVisible(preview.captionEl) : !findPreviewSendBtn(),
          SENT_TIMEOUT_MS
        );
        return { ok: true, method: used, sent: closed };
      } catch (err) {
        log('error', err);
        notify('Attach failed: ' + err.message);
        return { ok: false, reason: 'error' };
      } finally {
        busy = false;
      }
    }
    if (!core.sendMediaFile) core.sendMediaFile = sendMediaFile;

    /** For sequences: core.sendSavedVideo(id, { autoSend: true, waitForSent: true }) */
    async function sendSavedVideo(id, opts = {}) {
      const item = libraryData.items.find(i => i.id === id && i.type === 'video');
      if (!item) return { ok: false, reason: 'not-found' };
      const blob = await getVideoBlob(id);
      if (!blob) { notify('Video file is missing from storage.'); return { ok: false, reason: 'blob-missing' }; }
      const file = new File([blob], item.fileName || (item.name + '.mp4'), { type: item.mime || blob.type || 'video/mp4' });
      return sendMediaFile(file, { ...opts, caption: opts.caption ?? item.caption });
    }
    core.sendSavedVideo = sendSavedVideo;

    // ================= UI =================
    const libUI = document.createElement('div');
    libUI.className = 'wa-tln-container';
    libUI.innerHTML = `
      <div class="wa-tln-header-btns">
        <input type="file" id="wa-vlc-upload-input" accept="video/mp4,video/*" multiple style="display:none;">
        <button id="wa-vlc-upload-btn" class="wa-tln-hbtn">📤 Upload</button>
        <button id="wa-vlc-new-fold" class="wa-tln-hbtn">📁 Fold</button>
      </div>
      <div id="wa-vlc-tree-root" class="wa-tln-tree"></div>
    `;

    libUI.querySelector('#wa-vlc-new-fold').onclick = () => {
      const name = prompt('Folder name:');
      if (!name || !name.trim()) return;
      libraryData.items.push({ id: 'vfld_' + Date.now(), type: 'folder', parentId: 'root', name: name.trim(), collapsed: false, order: Date.now() });
      saveData(); renderTree();
    };

    const uploadInput = libUI.querySelector('#wa-vlc-upload-input');
    const uploadBtn = libUI.querySelector('#wa-vlc-upload-btn');
    uploadBtn.onclick = () => uploadInput.click();
    uploadInput.onchange = async (e) => {
      const files = Array.from(e.target.files || []);
      uploadInput.value = '';
      if (!files.length) return;
      const label = uploadBtn.textContent;
      uploadBtn.disabled = true;
      let n = 0;
      for (const file of files) {
        n++;
        uploadBtn.textContent = `⏳ ${n}/${files.length}`;
        if (!file.type.startsWith('video/')) { notify(`Skipped "${file.name}" (not a video).`); continue; }
        if (file.size > MAX_SIZE_MB * 1048576) { notify(`Skipped "${file.name}" (${fmtMB(file.size)} — limit is ${MAX_SIZE_MB} MB).`); continue; }
        if (file.size > WARN_SIZE_MB * 1048576 &&
            !confirm(`"${file.name}" is ${fmtMB(file.size)}. WhatsApp may compress it heavily. Save anyway?`)) continue;

        const id = 'vid_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
        const { thumbnail, duration } = await makeVideoThumb(file);
        try { await saveBlobToDb(id, file); }
        catch (err) { notify(`Could not save "${file.name}": ${err.message}`); continue; }

        libraryData.items.push({
          id, type: 'video', parentId: activeFolderFilter === 'All' ? 'root' : activeFolderFilter,
          name: file.name.replace(/\.[^/.]+$/, ''), fileName: file.name, mime: file.type || 'video/mp4',
          size: file.size, duration, caption: '', tags: [], thumbnail, order: Date.now()
        });
        saveData(); renderTree();
      }
      uploadBtn.textContent = label;
      uploadBtn.disabled = false;
    };

    async function openVideoEditor(item) {
      const overlay = document.createElement('div');
      overlay.className = 'wa-tlp-modal-overlay';
      overlay.innerHTML = `
        <div class="wa-tlp-modal">
          <h3>✏️ Edit Video</h3>
          <video id="wa-vlp-player" controls playsinline preload="metadata" poster="${item.thumbnail}"
            style="max-height:200px; max-width:100%; border-radius:6px; align-self:center; background:#000;"></video>
          <div style="font-size:11px; opacity:.7; text-align:center;">${fmtDur(item.duration) || '—'} · ${fmtMB(item.size)}</div>
          <input type="text" id="wa-vlp-name" class="wa-tlp-input" placeholder="Name" value="${esc(item.name)}">
          <textarea id="wa-vlp-caption" class="wa-tlp-input" placeholder="Caption / Link (Optional)"
            style="margin-top:8px; resize:vertical; min-height:60px; font-family:inherit;">${esc(item.caption)}</textarea>
          <div class="wa-tlp-row">
            <button id="wa-vlp-save" class="wa-base-btn">💾 Save</button>
            <button id="wa-vlp-download" class="wa-hide-btn" style="flex:1;" title="Download to drag into WhatsApp by hand">⬇️</button>
            <button id="wa-vlp-cancel" class="wa-hide-btn" style="flex:1;">Cancel</button>
            <button id="wa-vlp-delete" class="wa-hide-btn" style="flex:1; color:#f87171;">Delete</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);

      const player = overlay.querySelector('#wa-vlp-player');
      let url = null;
      const close = () => {
        player.pause(); player.removeAttribute('src'); player.load();
        if (url) URL.revokeObjectURL(url);
        overlay.remove();
      };

      overlay.querySelector('#wa-vlp-cancel').onclick = close;
      overlay.querySelector('#wa-vlp-download').onclick = () => {
        if (!url) return;
        const a = document.createElement('a');
        a.href = url; a.download = item.fileName || (item.name + '.mp4');
        document.body.appendChild(a); a.click(); a.remove();
      };
      overlay.querySelector('#wa-vlp-delete').onclick = () => {
        if (!confirm('Delete this video?')) return;
        libraryData.items = libraryData.items.filter(i => i.id !== item.id);
        deleteBlobFromDb(item.id);
        saveData(); renderTree(); close();
      };
      overlay.querySelector('#wa-vlp-save').onclick = () => {
        item.name = overlay.querySelector('#wa-vlp-name').value.trim() || item.name;
        item.caption = overlay.querySelector('#wa-vlp-caption').value.trim();
        saveData(); renderTree(); close();
      };

      const blob = await getVideoBlob(item.id);
      if (blob && overlay.isConnected) {
        url = URL.createObjectURL(blob);
        player.src = url;
      }
    }

    // ================= DRAG & DROP (tree reordering) =================
    const DROP_CLASSES = ['wa-tln-drop-top', 'wa-tln-drop-bottom', 'wa-tln-drop-inside'];
    function handleDragStart(e, id) { draggedItem = id; e.target.style.opacity = '0.4'; e.dataTransfer.effectAllowed = 'move'; }
    function handleDragOver(e, targetId, targetType) {
      e.preventDefault();
      if (!draggedItem || draggedItem === targetId) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const offset = e.clientY - rect.top;
      e.currentTarget.classList.remove(...DROP_CLASSES);
      if (targetType === 'folder' && offset > rect.height * 0.25 && offset < rect.height * 0.75) e.currentTarget.classList.add('wa-tln-drop-inside');
      else if (offset < rect.height / 2) e.currentTarget.classList.add('wa-tln-drop-top');
      else e.currentTarget.classList.add('wa-tln-drop-bottom');
    }
    function handleDrop(e, targetId, targetType) {
      e.preventDefault();
      e.currentTarget.classList.remove(...DROP_CLASSES);
      if (!draggedItem || draggedItem === targetId) return;
      const dragged = libraryData.items.find(i => i.id === draggedItem);
      const target = libraryData.items.find(i => i.id === targetId);
      if (!dragged || !target) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const offset = e.clientY - rect.top;
      if (targetType === 'folder' && offset > rect.height * 0.25 && offset < rect.height * 0.75) dragged.parentId = target.id;
      else { dragged.parentId = target.parentId; dragged.order = offset < rect.height / 2 ? target.order - 1 : target.order + 1; }
      saveData(); renderTree();
    }

    // ================= TREE =================
    function renderTree() {
      const rootContainer = libUI.querySelector('#wa-vlc-tree-root');
      if (!rootContainer) return;
      rootContainer.innerHTML = '';
      let counter = 0;

      function buildNode(parentId, containerElement) {
        const children = libraryData.items.filter(i => i.parentId === parentId).sort((a, b) => a.order - b.order);
        children.forEach(item => {
          const el = document.createElement('div');

          if (item.type === 'folder') {
            el.className = 'wa-tln-folder-head'; el.draggable = true;
            el.addEventListener('dragstart', (e) => handleDragStart(e, item.id));
            el.addEventListener('dragend', (e) => { e.target.style.opacity = '1'; draggedItem = null; });
            el.addEventListener('dragover', (e) => handleDragOver(e, item.id, 'folder'));
            el.addEventListener('dragleave', (e) => e.currentTarget.classList.remove(...DROP_CLASSES));
            el.addEventListener('drop', (e) => handleDrop(e, item.id, 'folder'));
            el.innerHTML = `<span class="wa-tln-caret ${item.collapsed ? 'collapsed' : ''}">▼</span><span>📁 ${esc(item.name)}</span><button class="wa-tln-btn" style="margin-left:auto;">⚙️</button>`;
            const contentDiv = document.createElement('div');
            contentDiv.className = `wa-tln-folder-content ${item.collapsed ? 'collapsed' : ''}`;
            el.querySelector('.wa-tln-caret').onclick = () => { item.collapsed = !item.collapsed; saveData(); renderTree(); };
            el.querySelector('.wa-tln-btn').onclick = () => {
              const action = prompt(`Edit Folder: "${item.name}"\n\nType a new name to rename it.\nType "DELETE" (all caps) to delete it and its contents.`);
              if (!action) return;
              if (action === 'DELETE') {
                const deleteNodeAndChildren = (id) => {
                  libraryData.items.filter(i => i.parentId === id).forEach(c => {
                    if (c.type !== 'folder') deleteBlobFromDb(c.id);
                    deleteNodeAndChildren(c.id);
                  });
                  libraryData.items = libraryData.items.filter(i => i.id !== id);
                };
                deleteNodeAndChildren(item.id);
              } else { item.name = action.trim(); }
              saveData(); renderTree();
            };
            containerElement.appendChild(el); containerElement.appendChild(contentDiv);
            buildNode(item.id, contentDiv);
            return;
          }

          counter++;
          el.className = `wa-tln-item ${counter % 2 === 0 ? 'alt-bg' : ''}`;
          el.dataset.id = item.id;
          const captionIndicator = item.caption ? '<span style="font-size:10px; margin-left:4px;" title="Includes caption">📝</span>' : '';
          const dur = fmtDur(item.duration);

          el.innerHTML = `
            <div class="wa-tln-row">
              <span class="wa-tln-drag-grip" draggable="true">⠿</span>
              <span class="wa-vlc-thumb-wrap">
                <img class="wa-tln-thumb" src="${item.thumbnail}">
                <span class="wa-vlc-play">▶</span>
                ${dur ? `<span class="wa-vlc-dur">${dur}</span>` : ''}
              </span>
              <div class="wa-tln-title-col">${esc(item.name)}${captionIndicator}</div>
              <div class="wa-tln-actions">
                <button class="wa-tln-btn edit-btn" title="Edit / Delete">✏️</button>
                <button class="wa-tln-btn send-btn" title="Attach to chat (Shift+click: attach & send)" style="min-width:40px;">📤</button>
              </div>
            </div>
          `;

          const grip = el.querySelector('.wa-tln-drag-grip');
          grip.addEventListener('dragstart', (e) => handleDragStart(e, item.id));
          grip.addEventListener('dragend', (e) => { e.target.style.opacity = '1'; draggedItem = null; });
          el.addEventListener('dragover', (e) => handleDragOver(e, item.id, 'video'));
          el.addEventListener('dragleave', (e) => e.currentTarget.classList.remove(...DROP_CLASSES));
          el.addEventListener('drop', (e) => handleDrop(e, item.id, 'video'));

          el.onclick = (e) => { e.stopPropagation(); };
          el.querySelector('.edit-btn').onclick = (e) => { e.stopPropagation(); openVideoEditor(item); };

          const sendBtn = el.querySelector('.send-btn');
          sendBtn.onclick = async (e) => {
            e.stopPropagation();
            if (busy) { notify('Already attaching a video — wait for it to finish.'); return; }
            const original = sendBtn.innerHTML;
            sendBtn.innerText = '⏳';
            const res = await sendSavedVideo(item.id, { autoSend: e.shiftKey });
            sendBtn.innerText = res.ok ? '✅' : '⚠️';
            setTimeout(() => { sendBtn.innerHTML = original; }, 1500);
          };

          containerElement.appendChild(el);
        });
      }

      const renderRoot = activeFolderFilter === 'All' ? 'root' : activeFolderFilter;
      buildNode(renderRoot, rootContainer);
      core.emit('vl:tree-rendered', libUI);
    }

    // ================= MOUNT =================
    function mountCard(attemptsLeft) {
      attemptsLeft = attemptsLeft === undefined ? 10 : attemptsLeft;
      if (typeof core.registerMenu === 'function') {
        core.registerMenu('left', '🎬 Saved Videos', libUI, '⠿', 'video-library-module');
        renderTree();
      } else if (attemptsLeft > 0) {
        setTimeout(() => mountCard(attemptsLeft - 1), 200);
      }
    }
    mountCard();
    migrateFromSharedStore();
    core.emit('block:ready', { id: 'videoLibraryModule' });
  }
});

  LegoCore.boot();
})();
