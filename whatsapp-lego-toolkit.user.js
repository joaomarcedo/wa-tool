// ==UserScript==
// @name         WhatsApp Lego Toolkit
// @namespace    https://node-builder.local/
// @version      1.0.0
// @description  Compiled by Node Builder -- 24 block(s): Sidebar Plugin Manager, Dual Sidebar UI Shell, Menu Collapse Module, Menu Panel Switcher, Menu Card Reorder Module, Menu Card Pop-out Module, Header Toolbar Organizer, Workspace Profile & Visibility Manager, WhatsApp Layout Resizer, Sidebar-to-Resizer Sync, Text Library Height Fix, Reset Menus, Quick Chat Box, Shared Tree Styles, Saved Messages (Text Library), Saved Images (Image Library), Message Sequence Builder, Quick Commands, Google Sheets Sync, Highlighter, Text resizer, Contact Tag Editor, Contact Badge Renderer, Dashboard Export
// @author       You
// @match        https://web.whatsapp.com/*
// @grant        GM_xmlhttpRequest
// @connect      docs.google.com
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

      const state = popoutStates[key] || { top: 120, left: 220, width: 320, height: 380 };
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
      delete popoutStates[key];
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
        popoutStates[key] = popoutStates[key] || { top: 120, left: 220, width: 320 };
        saveStates();
      });
      const switchBtn = header.querySelector('.wa-switch-panel-btn');
      const collapseBtn = header.querySelector('.wa-collapse-btn');
      const dragHandle = header.querySelector('.wa-drag-handle');
      if (switchBtn) header.insertBefore(btn, switchBtn);
      else if (collapseBtn) header.insertBefore(btn, collapseBtn);
      else if (dragHandle) header.insertBefore(btn, dragHandle);
      else header.appendChild(btn);

      if (popoutStates[key]) setTimeout(() => createFloatingWindow(card), 100);
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
   BLOCK: Workspace Profile & Visibility Manager (v1)
   ============================================================ */
LegoCore.registerBlock({
  id: 'profileManagerModule',
  init(core) {
    const STORAGE_KEY = 'wa_workspace_profiles_v1';
    const POS_STORAGE_KEY = 'wa_workspace_profile_window_pos_v1';

    let profileData = {
      activeProfile: 'Default',
      profiles: {
        'Default': {},
        'Sender Only': { 'quick-chat-box': true, 'sequence-builder': true, 'text-library-module': false, 'image-library-module': false },
        'Library Focus': { 'text-library-module': true, 'image-library-module': true, 'quick-chat-box': false, 'sequence-builder': false }
      },
      hiddenCards: {}
    };
    let windowPos = { top: 60, left: 90 };
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (saved) profileData = Object.assign(profileData, saved);
      const savedPos = JSON.parse(localStorage.getItem(POS_STORAGE_KEY));
      if (savedPos && typeof savedPos.top === 'number' && typeof savedPos.left === 'number') windowPos = savedPos;
    } catch (e) {}

    function saveProfiles() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(profileData)); } catch (e) {} }
    function saveWindowPosition(top, left) { windowPos = { top, left }; try { localStorage.setItem(POS_STORAGE_KEY, JSON.stringify(windowPos)); } catch (e) {} }

    const style = document.createElement('style');
    style.innerHTML = `
      .wa-profile-launcher-btn { position: fixed; z-index: 2147483646; background: var(--wat-surface, #17171d); color: var(--wat-accent, #25d366); border: 1px solid var(--wat-border-strong, rgba(255,255,255,0.2)); border-radius: 999px; padding: 6px 12px; font-size: 11px; font-weight: 700; cursor: pointer; bottom: 12px; right: 12px; }
      .wa-profile-window { position: fixed; width: 300px; z-index: 2147483647; background: var(--wat-surface, #17171d); border: 1px solid var(--wat-border-strong, rgba(255,255,255,0.2)); border-radius: 10px; padding: 12px; color: var(--wat-text, #ece9e4); font-family: -apple-system, sans-serif; box-shadow: 0 10px 30px rgba(0,0,0,0.7); display: none; flex-direction: column; gap: 10px; }
      .wa-profile-window.open { display: flex; }
      .wa-profile-window-header { display: flex; justify-content: space-between; align-items: center; font-size: 12px; font-weight: bold; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 6px; cursor: grab; }
      .wa-profile-select-row { display: flex; gap: 6px; align-items: center; }
      .wa-profile-select-row select { flex: 1; background: #111; color: #fff; border: 1px solid #333; border-radius: 5px; padding: 4px; font-size: 11px; }
      .wa-profile-card-row { display: flex; justify-content: space-between; align-items: center; font-size: 10.5px; padding: 3px 0; }
    `;
    document.head.appendChild(style);

    const launcherBtn = document.createElement('button');
    launcherBtn.className = 'wa-profile-launcher-btn';
    launcherBtn.innerText = '⚙ Workspace';
    document.body.appendChild(launcherBtn);

    const win = document.createElement('div');
    win.className = 'wa-profile-window';
    win.style.top = windowPos.top + 'px';
    win.style.left = windowPos.left + 'px';
    win.innerHTML = `
      <div class="wa-profile-window-header"><span>⚙ Workspace Profiles</span><button id="wa-profile-close" style="background:none;border:none;color:#94a3b8;cursor:pointer;">✕</button></div>
      <div class="wa-profile-select-row">
        <select id="wa-profile-select"></select>
        <button id="wa-profile-apply" class="wa-hide-btn">Apply</button>
      </div>
      <div id="wa-profile-card-list" style="display:flex; flex-direction:column; gap:2px; max-height:220px; overflow-y:auto;"></div>
    `;
    document.body.appendChild(win);

    function refreshProfileSelect() {
      const sel = win.querySelector('#wa-profile-select');
      sel.innerHTML = Object.keys(profileData.profiles).map(name => `<option value="${name}" ${name === profileData.activeProfile ? 'selected' : ''}>${name}</option>`).join('');
    }

    function refreshCardList() {
      const list = win.querySelector('#wa-profile-card-list');
      const cards = document.querySelectorAll('.wa-draggable-menu');
      list.innerHTML = '';
      cards.forEach(card => {
        const key = card.dataset.key;
        const label = card.querySelector('.wa-menu-header span') ? card.querySelector('.wa-menu-header span').textContent : key;
        const hidden = !!profileData.hiddenCards[key];
        const row = document.createElement('div');
        row.className = 'wa-profile-card-row';
        row.innerHTML = `<span>${label}</span><label style="cursor:pointer;"><input type="checkbox" data-key="${key}" ${hidden ? '' : 'checked'}> Visible</label>`;
        row.querySelector('input').onchange = (e) => {
          profileData.hiddenCards[key] = !e.target.checked;
          saveProfiles();
          applyVisibility();
        };
        list.appendChild(row);
      });
    }

    function applyVisibility() {
      document.querySelectorAll('.wa-draggable-menu').forEach(card => {
        const key = card.dataset.key;
        card.classList.toggle('is-profile-hidden', !!profileData.hiddenCards[key]);
      });
    }

    const visibilityStyle = document.createElement('style');
    visibilityStyle.innerHTML = `.wa-draggable-menu.is-profile-hidden { display: none !important; }`;
    document.head.appendChild(visibilityStyle);

    win.querySelector('#wa-profile-close').onclick = () => win.classList.remove('open');
    launcherBtn.onclick = () => { win.classList.toggle('open'); if (win.classList.contains('open')) refreshCardList(); };
    win.querySelector('#wa-profile-apply').onclick = () => {
      const chosen = win.querySelector('#wa-profile-select').value;
      profileData.activeProfile = chosen;
      const visibilityMap = profileData.profiles[chosen] || {};
      document.querySelectorAll('.wa-draggable-menu').forEach(card => {
        const key = card.dataset.key;
        if (Object.prototype.hasOwnProperty.call(visibilityMap, key)) profileData.hiddenCards[key] = !visibilityMap[key];
      });
      saveProfiles(); applyVisibility(); refreshCardList();
    };

    core.makeDraggable(win, win.querySelector('.wa-profile-window-header'), null);
    const header = win.querySelector('.wa-profile-window-header');
    header.addEventListener('mouseup', () => {
      const rect = win.getBoundingClientRect();
      saveWindowPosition(rect.top, rect.left);
    });

    refreshProfileSelect();
    applyVisibility();
    core.emit('block:ready', { id: 'profileManagerModule' });
  }
});

/* ============================================================
   BLOCK: WhatsApp Layout Resizer (v1)
   ============================================================ */
LegoCore.registerBlock({
  id: 'waPageResizerFeature',
  init(core) {
    const WA_APP_SELECTOR = '#app > div';

    function applyOffsets(leftWidth, rightWidth) {
      const appRoot = document.querySelector(WA_APP_SELECTOR);
      if (!appRoot) return;
      appRoot.style.marginLeft = leftWidth + 'px';
      appRoot.style.marginRight = rightWidth + 'px';
      appRoot.style.transition = 'margin 0.28s cubic-bezier(0.22, 0.61, 0.36, 1)';
      appRoot.style.width = `calc(100% - ${leftWidth + rightWidth}px)`;
    }

    window.addEventListener('wa-resizer-update', (e) => {
      applyOffsets(e.detail.leftWidth, e.detail.rightWidth);
    });

    // Apply current sidebar prefs once on load, once the app root exists.
    function initialApply(attempts) {
      const prefs = core.getSidebarPrefs && core.getSidebarPrefs();
      const appRoot = document.querySelector(WA_APP_SELECTOR);
      if (prefs && appRoot) {
        applyOffsets(prefs.leftHidden ? 0 : prefs.leftWidth, prefs.rightHidden ? 0 : prefs.rightWidth);
      } else if (attempts > 0) {
        setTimeout(() => initialApply(attempts - 1), 300);
      }
    }
    initialApply(15);

    console.log("[waPageResizerFeature] WhatsApp layout offset handler loaded. Verify WA_APP_SELECTOR still matches WhatsApp's current DOM.");
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
   BLOCK: Text Library Height Fix (v1)
   ============================================================ */
LegoCore.registerBlock({
  id: 'textLibraryHeightFix',
  init(core) {
    const style = document.createElement('style');
    style.innerHTML = `
      .wa-draggable-menu[data-key="text-library-module"] .wa-menu-content,
      .wa-draggable-menu[data-key="image-library-module"] .wa-menu-content {
        display: flex; flex-direction: column; height: 60vh; max-height: 80vh; min-height: 200px;
      }
      .wa-draggable-menu[data-key="text-library-module"] .wa-tln-tree,
      .wa-draggable-menu[data-key="image-library-module"] .wa-tln-tree {
        max-height: none !important; flex: 1; min-height: 0; overflow-y: auto;
      }
      .wa-floating-modal[id="wa-float-modal-text-library-module"],
      .wa-floating-modal[id="wa-float-modal-image-library-module"] { height: 70vh; min-height: 300px; }
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
   BLOCK: Message Sequence Builder (v7)
   ============================================================ */
/* ============================================================
   BLOCK: Message Sequence Builder (v7)
   ============================================================ */
LegoCore.registerBlock({
  id: 'sequenceBuilderModule',
  init(core) {
    const STORAGE_KEY = 'wa_sequences_v1';
    let sequences = JSON.parse(localStorage.getItem(STORAGE_KEY)) || { list: [], activeId: null };
    function saveSequences() { localStorage.setItem(STORAGE_KEY, JSON.stringify(sequences)); }

    const style = document.createElement('style');
    style.innerHTML = `
      .wa-seq-step { display:flex; align-items:center; gap:6px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:6px; padding:6px 8px; font-size:11px; color:#e2e8f0; }
      .wa-seq-step-drag { cursor:grab; color:#475569; }
      .wa-seq-step-label { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .wa-seq-step.is-wait { color:#94a3b8; font-style:italic; }
      .wa-seq-status { font-size:10px; color:#94a3b8; min-height:14px; }
      .wa-seq-status.running .wa-seq-active-step { color:#25d366; font-weight:bold; }
    `;
    document.head.appendChild(style);

    const ui = document.createElement('div');
    ui.className = 'wa-tln-container';
    ui.innerHTML = `
      <div class="wa-tln-header-btns">
        <select id="wa-seq-select" class="wa-tlp-input" style="flex:2;"></select>
        <button id="wa-seq-new" class="wa-tln-hbtn">➕ New</button>
        <button id="wa-seq-delete" class="wa-tln-hbtn">🗑️</button>
      </div>
      <div class="wa-tln-header-btns">
        <select id="wa-seq-add-snippet" class="wa-tlp-input" style="flex:2;"><option value="">+ Add message or image...</option></select>
        <button id="wa-seq-add-wait" class="wa-tln-hbtn">⏱️ Wait</button>
      </div>
      <div id="wa-seq-steps" style="display:flex; flex-direction:column; gap:4px; max-height:220px; overflow-y:auto;"></div>
      <button id="wa-seq-run" class="wa-base-btn" style="background:#25d366;">▶️ Run Sequence</button>
      <div id="wa-seq-status" class="wa-seq-status"></div>
    `;

    function currentSequence() {
      if (!sequences.activeId) return null;
      return sequences.list.find(s => s.id === sequences.activeId) || null;
    }

    function refreshSequenceSelect() {
      const sel = ui.querySelector('#wa-seq-select');
      sel.innerHTML = sequences.list.map(s => `<option value="${s.id}" ${s.id === sequences.activeId ? 'selected' : ''}>${s.name}</option>`).join('');
    }

    function refreshSnippetOptions() {
      const sel = ui.querySelector('#wa-seq-add-snippet');
      const textLib = core.getTextLibrary ? core.getTextLibrary() : { items: [] };
      const imgLib = core.getImageLibrary ? core.getImageLibrary() : { items: [] };
      
      const snippets = textLib.items.filter(i => i.type === 'snippet');
      const images = imgLib.items.filter(i => i.type === 'image');
      
      let html = '<option value="">+ Add message or image...</option>';
      
      if (snippets.length) {
        html += '<optgroup label="📝 Saved Messages">';
        html += snippets.map(s => `<option value="snip_${s.id}">${s.title}${s.imageId ? ' 🖼️' : ''}</option>`).join('');
        html += '</optgroup>';
      }
      if (images.length) {
        html += '<optgroup label="🖼️ Saved Images">';
        html += images.map(img => `<option value="img_${img.id}">${img.name}${img.caption ? ' 📝' : ''}</option>`).join('');
        html += '</optgroup>';
      }
      
      sel.innerHTML = html;
    }

    function renderSteps() {
      const seq = currentSequence();
      const stepsEl = ui.querySelector('#wa-seq-steps');
      stepsEl.innerHTML = '';
      if (!seq) { stepsEl.innerHTML = '<div style="font-size:10px;color:#64748b;padding:6px;">Create a sequence to get started.</div>'; return; }

      const textLib = core.getTextLibrary ? core.getTextLibrary() : { items: [] };
      const imgLib = core.getImageLibrary ? core.getImageLibrary() : { items: [] };

      seq.steps.forEach((step, idx) => {
        const row = document.createElement('div');
        row.className = 'wa-seq-step' + (step.type === 'wait' ? ' is-wait' : '');
        row.dataset.index = idx;
        let label;
        
        if (step.type === 'wait') {
          label = `⏱️ Wait ${step.seconds}s`;
        } else if (step.type === 'snippet') {
          const snip = textLib.items.find(i => i.id === step.snippetId);
          label = snip ? `📝 ${snip.title}${snip.imageId ? ' 🖼️' : ''}` : '⚠️ (deleted message)';
        } else if (step.type === 'image') {
          const img = imgLib.items.find(i => i.id === step.imageId);
          label = img ? `🖼️ ${img.name}${img.caption ? ' 📝' : ''}` : '⚠️ (deleted image)';
        }
        
        row.innerHTML = `<span class="wa-seq-step-drag">⠿</span><span class="wa-seq-step-label">${idx + 1}. ${label}</span><button class="wa-tln-btn" data-action="up">↑</button><button class="wa-tln-btn" data-action="down">↓</button><button class="wa-tln-btn" data-action="remove">✕</button>`;
        row.querySelector('[data-action="up"]').onclick = () => { if (idx > 0) { [seq.steps[idx - 1], seq.steps[idx]] = [seq.steps[idx], seq.steps[idx - 1]]; saveSequences(); renderSteps(); } };
        row.querySelector('[data-action="down"]').onclick = () => { if (idx < seq.steps.length - 1) { [seq.steps[idx + 1], seq.steps[idx]] = [seq.steps[idx], seq.steps[idx + 1]]; saveSequences(); renderSteps(); } };
        row.querySelector('[data-action="remove"]').onclick = () => { seq.steps.splice(idx, 1); saveSequences(); renderSteps(); };
        stepsEl.appendChild(row);
      });
    }

    ui.querySelector('#wa-seq-new').onclick = () => {
      const name = prompt('Sequence name:');
      if (!name || !name.trim()) return;
      const seq = { id: 'seq_' + Date.now(), name: name.trim(), steps: [] };
      sequences.list.push(seq);
      sequences.activeId = seq.id;
      saveSequences(); refreshSequenceSelect(); renderSteps();
    };
    
    ui.querySelector('#wa-seq-delete').onclick = () => {
      if (!currentSequence()) return;
      if (!confirm('Delete this sequence?')) return;
      sequences.list = sequences.list.filter(s => s.id !== sequences.activeId);
      sequences.activeId = sequences.list.length ? sequences.list[0].id : null;
      saveSequences(); refreshSequenceSelect(); renderSteps();
    };
    
    ui.querySelector('#wa-seq-select').onchange = (e) => { sequences.activeId = e.target.value; saveSequences(); renderSteps(); };
    
    ui.querySelector('#wa-seq-add-snippet').onchange = (e) => {
      const val = e.target.value;
      if (!val || !currentSequence()) return;
      
      if (val.startsWith('snip_')) {
        currentSequence().steps.push({ type: 'snippet', snippetId: val.replace('snip_', '') });
      } else if (val.startsWith('img_')) {
        currentSequence().steps.push({ type: 'image', imageId: val.replace('img_', '') });
      }
      
      saveSequences(); renderSteps();
      e.target.value = '';
    };
    
    ui.querySelector('#wa-seq-add-wait').onclick = () => {
      if (!currentSequence()) return;
      const secs = parseFloat(prompt('Wait how many seconds?', '3'));
      if (!secs || secs <= 0) return;
      currentSequence().steps.push({ type: 'wait', seconds: secs });
      saveSequences(); renderSteps();
    };

    const getPngBlobPromise = async (blob) => {
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

    ui.querySelector('#wa-seq-run').onclick = async () => {
      const seq = currentSequence();
      if (!seq || !seq.steps.length) return;
      
      const statusEl = ui.querySelector('#wa-seq-status');
      const runBtn = ui.querySelector('#wa-seq-run');
      runBtn.disabled = true;
      
      const textLib = core.getTextLibrary ? core.getTextLibrary() : { items: [] };
      const imgLib = core.getImageLibrary ? core.getImageLibrary() : { items: [] };

      for (let i = 0; i < seq.steps.length; i++) {
        const step = seq.steps[i];
        
        if (step.type === 'wait') {
          statusEl.textContent = `Waiting ${step.seconds}s (step ${i + 1}/${seq.steps.length})...`;
          await core.wait(step.seconds * 1000);
          continue;
        }
        
        let textToInject = '';
        let imageBlobToCopy = null;
        let stepLabel = '';

        if (step.type === 'snippet') {
          const snip = textLib.items.find(x => x.id === step.snippetId);
          if (!snip) { statusEl.textContent = `Skipped step ${i + 1}: message deleted.`; continue; }
          stepLabel = snip.title;
          textToInject = snip.text || '';
          
          if (snip.imageId) {
            const imgItem = imgLib.items.find(x => x.id === snip.imageId);
            if (imgItem) imageBlobToCopy = await core.getSavedImageBlob(imgItem.id);
          }
        } else if (step.type === 'image') {
          const imgItem = imgLib.items.find(x => x.id === step.imageId);
          if (!imgItem) { statusEl.textContent = `Skipped step ${i + 1}: image deleted.`; continue; }
          stepLabel = imgItem.name;
          textToInject = imgItem.caption || '';
          imageBlobToCopy = await core.getSavedImageBlob(imgItem.id);
        }

        try {
          if (imageBlobToCopy) {
            statusEl.textContent = `Step ${i + 1}/${seq.steps.length}: Waiting for you to paste...`;
            
            // 1. Focus the chat input and inject the text (becomes image caption)
            const chatInput = document.querySelector('#main footer div[contenteditable="true"]') 
                           || document.querySelector('div[contenteditable="true"][data-tab="10"]')
                           || document.querySelector('div[contenteditable="true"]');
                           
            if (chatInput) {
              chatInput.focus();
              if (textToInject) {
                document.execCommand('insertText', false, textToInject);
              }
            } else if (core.notifyError) {
              core.notifyError('Please open a chat to paste.');
            }

            // 2. Convert and copy the image to the clipboard
            const pngBlob = await getPngBlobPromise(imageBlobToCopy);
            await navigator.clipboard.write([
              new ClipboardItem({ 'image/png': pngBlob })
            ]);

            // 3. Show bubble and set a trap for the paste event
            await new Promise(resolve => {
              const bubble = document.createElement('div');
              bubble.style.cssText = 'position:fixed; bottom:100px; left:50%; transform:translateX(-50%); background:#25d366; color:#06210f; padding:12px 24px; border-radius:30px; font-size:14px; font-weight:bold; z-index:2147483647; box-shadow:0 10px 25px rgba(0,0,0,0.5); display:flex; align-items:center; gap:16px; font-family:-apple-system,sans-serif; border:2px solid #16a34a; animation: popIn 0.3s ease-out;';
              bubble.innerHTML = `
                <span>📋 Ready! Press <b>Ctrl+V</b>. (It will auto-send and continue!)</span>
                <button style="background:transparent; color:#06210f; border:1px solid rgba(0,0,0,0.2); padding:6px 12px; border-radius:20px; cursor:pointer; font-weight:bold; font-size:11px; opacity:0.8;" title="Click to manually skip">Skip</button>
              `;
              document.body.appendChild(bubble);

              const pasteHandler = async (e) => {
                document.removeEventListener('paste', pasteHandler, true);
                
                bubble.innerHTML = '<span>⏳ Pasted! Waiting for WhatsApp...</span>';
                
                // FIXED: Give WhatsApp a full second to read the clipboard and slide the preview open
                await core.wait(1000);
                
                // Poll for the Send button that specifically appears inside the Media Preview
                let attempts = 0;
                let sendBtn = null;
                while (attempts < 20 && !sendBtn) {
                  await core.wait(150);
                  // Find all send buttons, but we only want the one that is currently visible
                  const btns = Array.from(document.querySelectorAll('button[aria-label="Send"], [data-icon="send"], [data-testid="send"], span[data-icon="wds-ic-send-filled"]'));
                  sendBtn = btns.find(b => b.offsetParent !== null);
                  attempts++;
                }

                if (sendBtn) {
                  bubble.innerHTML = '<span>🚀 Sending!</span>';
                  await core.wait(200); // Final tiny buffer to let React bind the click listener
                  const clickable = sendBtn.closest('div[role="button"], button') || sendBtn;
                  clickable.click();
                } else if (core.notifyError) {
                  core.notifyError('Could not auto-send. Please click send manually.');
                }

                bubble.remove();
                // Wait 1.5 seconds for WhatsApp to close the preview drawer before continuing
                setTimeout(resolve, 1500); 
              };

              // Listen for the paste command
              document.addEventListener('paste', pasteHandler, true);

              // Manual override button
              const skipBtn = bubble.querySelector('button');
              skipBtn.onclick = () => {
                document.removeEventListener('paste', pasteHandler, true);
                bubble.remove();
                setTimeout(resolve, 800);
              };
            });
            
          } else {
            statusEl.textContent = `Sending step ${i + 1}/${seq.steps.length}: "${stepLabel}"...`;
            core.injectTextToChat(textToInject, true);
            await core.wait(500);
          }
        } catch (err) {
          statusEl.textContent = `Step ${i + 1} failed: ${err.message}`;
          console.error('Sequence step error:', err);
        }
      }
      statusEl.textContent = `Done -- ${seq.steps.length} step(s) processed.`;
      runBtn.disabled = false;
    };

    function mountCard(attemptsLeft) {
      attemptsLeft = attemptsLeft === undefined ? 10 : attemptsLeft;
      if (typeof core.registerMenu === 'function') {
        core.registerMenu('right', '🔗 Message Sequence', ui, '⠿', 'sequence-builder');
        if (!sequences.activeId && sequences.list.length) sequences.activeId = sequences.list[0].id;
        refreshSequenceSelect(); refreshSnippetOptions(); renderSteps();
      } else if (attemptsLeft > 0) {
        setTimeout(() => mountCard(attemptsLeft - 1), 200);
      }
    }
    mountCard();
    
    core.on('textlib:changed', () => { refreshSnippetOptions(); renderSteps(); });
    core.on('imglib:changed', () => { refreshSnippetOptions(); renderSteps(); });
    
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
   BLOCK: Google Sheets Sync (v2)
   ============================================================ */
LegoCore.registerBlock({
  id: 'sheetsSyncModule',
  init(core) {
    const TEXT_KEY = 'wa_text_library_v1';
    const IMAGE_KEY = 'wa_image_library_v1';
    const LAST_URL_KEY = 'wa_sync_last_url';

    function escapeCSV(str) {
      if (str === null || str === undefined) return '""';
      return `"${str.toString().replace(/"/g, '""')}"`;
    }
    function parseCSV(str) {
      const result = []; let row = [], inQuotes = false, val = '';
      for (let i = 0; i < str.length; i++) {
        const char = str[i], nextChar = str[i + 1];
        if (inQuotes) {
          if (char === '"' && nextChar === '"') { val += '"'; i++; }
          else if (char === '"') { inQuotes = false; }
          else { val += char; }
        } else {
          if (char === '"') inQuotes = true;
          else if (char === ',') { row.push(val); val = ''; }
          else if (char === '\n' || char === '\r') {
            if (char === '\r' && nextChar === '\n') i++;
            row.push(val); result.push(row); row = []; val = '';
          } else val += char;
        }
      }
      if (val !== '' || row.length > 0) { row.push(val); result.push(row); }
      return result;
    }
    function gmFetchText(url) {
      return new Promise((resolve, reject) => {
        if (typeof GM_xmlhttpRequest === 'undefined') { reject(new Error('GM_xmlhttpRequest not available. Add @grant GM_xmlhttpRequest to your userscript header.')); return; }
        GM_xmlhttpRequest({
          method: 'GET', url,
          onload: (response) => { if (response.status >= 200 && response.status < 300) resolve(response.responseText); else reject(new Error('Request failed with status ' + response.status)); },
          onerror: () => reject(new Error('Network error while fetching the sheet.')),
          ontimeout: () => reject(new Error('Request timed out.'))
        });
      });
    }
    function readFileAsText(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Could not read the file.'));
        reader.readAsText(file, 'utf-8');
      });
    }
    function dataURLtoBlob(dataUrl) {
      const [meta, base64] = dataUrl.split(',');
      const mime = (meta.match(/:(.*?);/) || [, 'image/jpeg'])[1];
      const bin = atob(base64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return new Blob([arr], { type: mime });
    }

    // Shared by BOTH the Google Sheets import and the manual CSV import.
    // Parses csvText, rebuilds the text + image libraries, and overwrites
    // localStorage. Throws on any parsing/validation problem.
    function importCsvTextAndOverwrite(csvText) {
      if (csvText.includes('<html') && (csvText.includes('sign in') || csvText.includes('ServiceLogin'))) {
        throw new Error("Sheet is private. Change sharing settings to 'Anyone with the link can view'.");
      }
      const rows = parseCSV(csvText);
      if (rows.length < 2) throw new Error('CSV appears empty or invalid.');

      const newTextLib = { items: [], tags: [] };
      const newImageLib = { items: [], tags: [] };
      const textFolderMap = {}, imageFolderMap = {}, tagMap = {}, imageNameMap = {};
      const palette = ['#25d366', '#0284c7', '#f77f00', '#9d0208', '#7209b7', '#10b981', '#f43f5e'];
      let tagColorIndex = 0;

      const db = core.getDb();
      function storeImageBlob(id, dataUrl) {
        if (!db) return;
        const blob = dataURLtoBlob(dataUrl);
        const tx = db.transaction(['images'], 'readwrite');
        tx.objectStore('images').put({ id, blob, order: Date.now() });
      }

      function ensureImage(name, group, dataUrl, rowIndex) {
        if (!name || !dataUrl) return '';
        if (imageNameMap[name]) return imageNameMap[name];
        if (!imageFolderMap[group]) {
          const fid = 'ifld_' + Date.now() + '_' + rowIndex;
          imageFolderMap[group] = fid;
          newImageLib.items.push({ id: fid, type: 'folder', parentId: 'root', name: group, collapsed: false, order: rowIndex });
        }
        const id = 'img_' + Date.now() + '_' + rowIndex;
        newImageLib.items.push({ id, type: 'image', parentId: imageFolderMap[group], name, thumbnail: dataUrl, tags: [], order: rowIndex });
        storeImageBlob(id, dataUrl);
        imageNameMap[name] = id;
        return id;
      }

      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (!row || row.length < 2 || !row[1] || !row[1].trim()) continue;
        const type = (row[0] || 'snippet').trim().toLowerCase();
        const name = row[1].trim();
        const group = (row[2] || '').trim() || 'General';
        const tagsRaw = (row[3] || '').trim();
        const command = (row[4] || '').trim();
        const text = row[5] || '';
        const imageName = (row[6] || '').trim();
        const imageData = row[7] || '';

        if (type === 'image') {
          ensureImage(name, group, imageData, i);
          continue;
        }

        if (!textFolderMap[group]) {
          const fid = 'fld_' + Date.now() + '_' + i;
          textFolderMap[group] = fid;
          newTextLib.items.push({ id: fid, type: 'folder', parentId: 'root', name: group, collapsed: false, order: i });
        }
        const tagIds = [];
        if (tagsRaw) {
          tagsRaw.split('|').map(t => t.trim()).filter(Boolean).forEach(tName => {
            if (!tagMap[tName]) {
              const tid = 'tag_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
              tagMap[tName] = tid;
              newTextLib.tags.push({ id: tid, name: tName, color: palette[tagColorIndex % palette.length] });
              tagColorIndex++;
            }
            tagIds.push(tagMap[tName]);
          });
        }
        const linkedImageId = imageName && imageData ? ensureImage(imageName, group, imageData, i) : '';
        newTextLib.items.push({
          id: 'snip_' + Date.now() + '_' + i, type: 'snippet', parentId: textFolderMap[group],
          title: name, text, tags: tagIds, customCommand: command, imageId: linkedImageId, order: i
        });
      }

      localStorage.setItem(TEXT_KEY, JSON.stringify(newTextLib));
      localStorage.setItem(IMAGE_KEY, JSON.stringify(newImageLib));
    }

    function openSyncModal() {
      if (document.getElementById('wa-sync-modal')) return;
      const savedUrl = localStorage.getItem(LAST_URL_KEY) || '';
      const overlay = document.createElement('div');
      overlay.className = 'wa-tlp-modal-overlay';
      overlay.id = 'wa-sync-modal';
      overlay.innerHTML = `
        <div class="wa-tlp-modal" style="width:420px; max-width:92vw;">
          <h3>☁️ Google Sheets Sync</h3>
          <div style="background:rgba(255,255,255,0.05); padding:10px; border-radius:6px;">
            <div style="font-size:11px; color:#94a3b8; margin-bottom:8px;">1. Export Saved Messages + Saved Images to a CSV file, then upload it into Google Sheets.</div>
            <button id="wa-sync-export-btn" class="wa-base-btn" style="background:#0284c7;">📤 Export to CSV</button>
          </div>
          <div style="background:rgba(244,63,94,0.05); border:1px solid rgba(244,63,94,0.2); padding:10px; border-radius:6px;">
            <div style="font-size:11px; color:#94a3b8; margin-bottom:8px;">2. Restore from a public Google Sheets URL.<br><span style="color:#f43f5e; font-weight:bold;">⚠️ This overwrites both libraries!</span></div>
            <input type="text" id="wa-sync-import-url" class="wa-tlp-input" placeholder="https://docs.google.com/spreadsheets/d/.../edit" value="${savedUrl}" style="margin-bottom:8px;">
            <button id="wa-sync-import-btn" class="wa-base-btn" style="background:#dc2626;">📥 Overwrite &amp; Import</button>
          </div>
          <div style="background:rgba(244,63,94,0.05); border:1px solid rgba(244,63,94,0.2); padding:10px; border-radius:6px;">
            <div style="font-size:11px; color:#94a3b8; margin-bottom:8px;">3. Or restore from a local CSV file (upload or paste).<br><span style="color:#f43f5e; font-weight:bold;">⚠️ This overwrites both libraries!</span></div>
            <input type="file" id="wa-sync-import-file" accept=".csv,text/csv" style="width:100%; font-size:11px; margin-bottom:8px; box-sizing:border-box;">
            <textarea id="wa-sync-import-paste" class="wa-tlp-input" rows="4" placeholder="...or paste the CSV contents here" style="width:100%; box-sizing:border-box; font-family:monospace; font-size:10.5px; margin-bottom:8px; resize:vertical;"></textarea>
            <button id="wa-sync-import-csv-btn" class="wa-base-btn" style="background:#dc2626;">📥 Overwrite &amp; Import CSV</button>
          </div>
          <button id="wa-sync-close-btn" class="wa-hide-btn">Close</button>
        </div>
      `;
      document.body.appendChild(overlay);

      overlay.querySelector('#wa-sync-export-btn').onclick = () => {
        const textLib = JSON.parse(localStorage.getItem(TEXT_KEY)) || { items: [], tags: [] };
        const imageLib = JSON.parse(localStorage.getItem(IMAGE_KEY)) || { items: [], tags: [] };

        const textFolders = {}; textLib.items.filter(i => i.type === 'folder').forEach(f => textFolders[f.id] = f.name);
        const tagNames = {}; textLib.tags.forEach(t => tagNames[t.id] = t.name);
        const imageFolders = {}; imageLib.items.filter(i => i.type === 'folder').forEach(f => imageFolders[f.id] = f.name);
        const imagesById = {}; imageLib.items.filter(i => i.type === 'image').forEach(img => imagesById[img.id] = img);

        let csv = 'Type,Name,Group,Tags,Command,Text,ImageName,ImageData\n';

        imageLib.items.filter(i => i.type === 'image').forEach(img => {
          const group = imageFolders[img.parentId] || 'General';
          csv += ['image', img.name, group, '', '', '', '', img.thumbnail].map(escapeCSV).join(',') + '\n';
        });

        textLib.items.filter(i => i.type === 'snippet').forEach(snip => {
          const group = textFolders[snip.parentId] || 'General';
          const tags = (snip.tags || []).map(id => tagNames[id]).filter(Boolean).join('|');
          const linkedImg = snip.imageId ? imagesById[snip.imageId] : null;
          csv += ['snippet', snip.title, group, tags, snip.customCommand || '', snip.text || '', linkedImg ? linkedImg.name : '', linkedImg ? linkedImg.thumbnail : '']
            .map(escapeCSV).join(',') + '\n';
        });

        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `WA_Toolkit_Backup_${Date.now()}.csv`;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
      };

      overlay.querySelector('#wa-sync-import-btn').onclick = async () => {
        const urlInput = overlay.querySelector('#wa-sync-import-url').value.trim();
        if (!urlInput) return alert('Please enter a Google Sheets URL.');
        localStorage.setItem(LAST_URL_KEY, urlInput);

        const match = urlInput.match(/\/d\/([a-zA-Z0-9-_]+)/);
        if (!match) return alert('Invalid Google Sheets URL. Make sure you copy the full browser link.');
        const docId = match[1];
        const gidMatch = urlInput.match(/gid=([0-9]+)/);
        const gidParam = gidMatch ? `&gid=${gidMatch[1]}` : '';
        const fetchUrl = `https://docs.google.com/spreadsheets/d/${docId}/export?format=csv${gidParam}`;

        if (!confirm('⚠️ WARNING: This will permanently DELETE and OVERWRITE your Saved Messages AND Saved Images with the data from the Google Sheet. Are you absolutely sure?')) return;

        const btn = overlay.querySelector('#wa-sync-import-btn');
        btn.innerText = '⏳ Fetching...'; btn.disabled = true;

        try {
          const csvText = await gmFetchText(fetchUrl);
          importCsvTextAndOverwrite(csvText);
          alert('✅ Import successful! Reloading page to apply changes.');
          window.location.reload();
        } catch (err) {
          console.error(err);
          alert('Import failed: ' + err.message + "\n\nEnsure Google Sheet sharing is set to 'Anyone with the link can view'.");
          btn.innerText = '📥 Overwrite & Import'; btn.disabled = false;
        }
      };

      // Uploading a file auto-fills the paste box (so it can be double-checked)
      // but does NOT auto-import -- the user still clicks "Overwrite & Import CSV".
      overlay.querySelector('#wa-sync-import-file').addEventListener('change', async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        try {
          const text = await readFileAsText(file);
          overlay.querySelector('#wa-sync-import-paste').value = text;
        } catch (err) {
          alert(err.message);
        }
      });

      overlay.querySelector('#wa-sync-import-csv-btn').onclick = async () => {
        const csvText = overlay.querySelector('#wa-sync-import-paste').value;
        if (!csvText || !csvText.trim()) return alert('Upload a .csv file or paste the CSV contents first.');

        if (!confirm('⚠️ WARNING: This will permanently DELETE and OVERWRITE your Saved Messages AND Saved Images with the data from this CSV. Are you absolutely sure?')) return;

        const btn = overlay.querySelector('#wa-sync-import-csv-btn');
        btn.innerText = '⏳ Importing...'; btn.disabled = true;

        try {
          importCsvTextAndOverwrite(csvText);
          alert('✅ Import successful! Reloading page to apply changes.');
          window.location.reload();
        } catch (err) {
          console.error(err);
          alert('Import failed: ' + err.message);
          btn.innerText = '📥 Overwrite & Import CSV'; btn.disabled = false;
        }
      };

      overlay.querySelector('#wa-sync-close-btn').onclick = () => overlay.remove();
    }

    function attachSyncButton(headerBtnsSelector) {
      const headerBtns = document.querySelector(headerBtnsSelector);
      if (headerBtns && !headerBtns.querySelector('.wa-sync-btn')) {
        const syncBtn = document.createElement('button');
        syncBtn.className = 'wa-tln-hbtn wa-sync-btn';
        syncBtn.innerText = '☁️ Sync';
        syncBtn.onclick = openSyncModal;
        headerBtns.appendChild(syncBtn);
      }
    }

    function initWatcher(attempts) {
      attachSyncButton('[data-key="text-library-module"] .wa-tln-header-btns');
      attachSyncButton('[data-key="image-library-module"] .wa-tln-header-btns');
      if (attempts > 0) setTimeout(() => initWatcher(attempts - 1), 300);
    }
    initWatcher(20);
    core.on('tl:tree-rendered', () => attachSyncButton('[data-key="text-library-module"] .wa-tln-header-btns'));
    core.on('il:tree-rendered', () => attachSyncButton('[data-key="image-library-module"] .wa-tln-header-btns'));

    core.emit('block:ready', { id: 'sheetsSyncModule' });
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
   BLOCK: Contact Tag Editor (v3)
   ============================================================ */
/* ============================================================
   BLOCK 1: Contact Tag Editor (v3)
   ------------------------------------------------------------
   Standalone plugin -- no dependency on any other block.
   Mounts its own card into the Dual Sidebar via core.registerMenu.

   v3 changes (replaces the standalone Dashboard block entirely --
   that block should be REMOVED from your Node Builder block list,
   not just left unused):

   1) TWO VIEWS instead of one long scroll: a small tab bar at the
      top switches between "Generar nombre" (the paste/form/preview
      flow for one contact) and "Configurar campos" (the field
      schema editor) -- so tweaking a course color doesn't require
      scrolling past the whole generator, and vice versa.

   2) LIST-TYPE FIELDS (Curso, etc.) now edit as individual rows --
      swatch, name, delete (✕) per option, plus a single
      "+ Agregar opción" box -- instead of retyping one long
      comma-separated string to change a single course name.

   3) FIELD-CONFIG EXPORT/IMPORT (schema, not contact data) --
      lives in the "Configurar campos" view:
      - "Exportar a Excel (.xlsx)": one row PER FIELD (Clave,
        Etiqueta, Tipo, Opciones, Colores, ColorPorDefecto, Oculto,
        Miles) -- your whole field setup as a spreadsheet, meant to
        be uploaded into Google Sheets for easier bulk editing.
      - "Importar desde Google Sheets": paste the sheet's public
        share link back in, and it REPLACES your entire field
        config -- a confirm dialog shows exactly how many fields
        will be replaced before anything is overwritten.
      Needs the same three lines in your Tampermonkey header you
      already added for the old Dashboard block:
        // @grant        GM_xmlhttpRequest
        // @connect      docs.google.com
        // @require      https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js

   WHAT THIS BLOCK DOES (unchanged core behavior)
   - Lets you define fields -- key, label, input type, color (or
     per-option colors for Lista fields), hidden flag, thousands
     flag -- and generates/edits WhatsApp contact name strings in
     the format: BaseName [KEY:value] [KEY:value] ...
   - Paste an existing tagged name to auto-fill the form; unknown
     tag keys are preserved as removable chips, never dropped.

   SHARED CONTRACT WITH BLOCK 2
   - localStorage key "wa_tag_fields_v1" holds the field
     definitions as JSON. This block is the only one that WRITES
     to it. Block 2 (Badge Renderer) only READS it.
   ============================================================ */
LegoCore.registerBlock({
  id: 'contactTagEditorPlugin',
  init(core) {
    const FIELDS_KEY = 'wa_tag_fields_v1';
    const VIEW_KEY = 'wa_tag_editor_view_v1';
    const PALETTE = ['#8ecae6', '#7ee787', '#f6c344', '#ff9770', '#c792ea', '#c9a876', '#ff8fa3', '#94e2c4'];

    const DEFAULT_FIELDS = [
      { key: 'C', label: 'Curso', inputType: 'select', options: ['ACN', 'RETV', 'FDOSC'], valueColors: { 'ACN': '#8ecae6', 'RETV': '#ff9770', 'FDOSC': '#c792ea' } },
      { key: 'G', label: 'Generación', inputType: 'text', color: '#c792ea' },
      { key: 'V', label: 'Vence', inputType: 'date', color: '#ff9770' },
      { key: 'H', label: 'Hijo/Alumno', inputType: 'text', color: '#7ee787' },
      { key: 'E', label: 'Edad', inputType: 'number', color: '#f6c344' },
      { key: 'P', label: 'Precio', inputType: 'number', color: '#c9a876', thousands: true },
      { key: 'S', label: 'Pago', inputType: 'select', options: ['Pagado', 'Pendiente'], valueColors: { 'Pagado': '#7ee787', 'Pendiente': '#ff8fa3' } },
      { key: 'A', label: 'Activo', inputType: 'select', options: ['Activo', 'Inactivo'], valueColors: { 'Activo': '#7ee787', 'Inactivo': '#96949c' } },
      { key: 'F', label: 'Formulario', inputType: 'select', options: ['Sí', 'No'], valueColors: { 'Sí': '#7ee787', 'No': '#96949c' } }
    ];

    let fields = [];
    try { fields = JSON.parse(localStorage.getItem(FIELDS_KEY)); } catch (e) { fields = null; }
    if (!Array.isArray(fields) || !fields.length) fields = JSON.parse(JSON.stringify(DEFAULT_FIELDS));

    function saveFields() { localStorage.setItem(FIELDS_KEY, JSON.stringify(fields)); }

    function nextPaletteColor(usedColors) {
      const free = PALETTE.find(c => !usedColors.includes(c));
      return free || PALETTE[Math.floor(Math.random() * PALETTE.length)];
    }

    // ---------------- Parsing / building (contact-name format) ----------------
    function parseFullName(raw) {
      const tagRe = /\[(\w+):([^\]]*)\]/g;
      const found = [];
      let m;
      while ((m = tagRe.exec(raw)) !== null) found.push({ key: m[1], value: m[2].trim() });
      const firstBracket = raw.indexOf('[');
      const baseName = (firstBracket === -1 ? raw : raw.slice(0, firstBracket)).trim();
      return { baseName, found };
    }

    function buildFullName(baseName, values, otherTags) {
      const parts = [];
      if (baseName && baseName.trim()) parts.push(baseName.trim());
      fields.forEach(f => {
        const v = values[f.key];
        if (v !== undefined && v !== null && String(v).trim() !== '') {
          parts.push(`[${f.key}:${String(v).trim()}]`);
        }
      });
      (otherTags || []).forEach(t => parts.push(`[${t.key}:${t.value}]`));
      return parts.join(' ');
    }

    // ---------------- Generic CSV parser (for Sheets import) ----------------
    function parseCsv(text) {
      const rows = [];
      let row = [], field = '', inQuotes = false;
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
      return rows.filter(r => r.some(cell => cell.trim() !== ''));
    }

    function extractSheetExportUrl(shareUrl) {
      const idMatch = shareUrl.match(/\/d\/([a-zA-Z0-9-_]+)/);
      if (!idMatch) return null;
      const id = idMatch[1];
      const gidMatch = shareUrl.match(/gid=([0-9]+)/);
      const gid = gidMatch ? gidMatch[1] : '0';
      return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
    }

    function fetchGoogleSheetCsv(url) {
      return new Promise((resolve, reject) => {
        if (typeof GM_xmlhttpRequest === 'undefined') {
          reject(new Error('Falta GM_xmlhttpRequest. Agrega // @grant GM_xmlhttpRequest y // @connect docs.google.com al encabezado del script.'));
          return;
        }
        GM_xmlhttpRequest({
          method: 'GET',
          url,
          onload: res => {
            if (res.status >= 200 && res.status < 300) resolve(res.responseText);
            else reject(new Error('Error al descargar la hoja (código ' + res.status + '). ¿Está compartida como "cualquiera con el link puede ver"?'));
          },
          onerror: () => reject(new Error('Error de red al descargar la hoja.'))
        });
      });
    }

    // ---------------- Editor state (Generator view) ----------------
    let state = { baseName: '', values: {}, otherTags: [] };

    // ---------------- Styles ----------------
    function injectStyles() {
      if (document.getElementById('wa-tag-styles')) return;
      const style = document.createElement('style');
      style.id = 'wa-tag-styles';
      style.innerHTML = `
        .wa-tag-wrap { display:flex; flex-direction:column; gap:10px; font-family:-apple-system,sans-serif; font-size:11px; }
        .wa-tag-view-tabs { display:flex; gap:4px; background:rgba(255,255,255,.04); border-radius:8px; padding:3px; }
        .wa-tag-view-tab { flex:1; background:transparent; border:none; color:var(--igls-text-dim,#96949c); padding:7px 6px; border-radius:6px; font-size:10.5px; font-weight:700; cursor:pointer; }
        .wa-tag-view-tab.active { background:var(--igls-accent,#c9a876); color:#171208; }
        .wa-tag-section { display:flex; flex-direction:column; gap:5px; }
        .wa-tag-label { font-size:10.5px; color:var(--igls-text-dim,#96949c); }
        .wa-tag-textarea { width:100%; min-height:44px; resize:vertical; background:var(--igls-surface-2,#1c1c23); color:var(--igls-text,#ece9e4); border:1px solid var(--igls-border,rgba(255,255,255,.08)); border-radius:6px; padding:6px 8px; font-size:11px; outline:none; box-sizing:border-box; }
        .wa-tag-input { background:var(--igls-surface-2,#1c1c23); color:var(--igls-text,#ece9e4); border:1px solid var(--igls-border,rgba(255,255,255,.08)); border-radius:6px; padding:6px 8px; font-size:11px; outline:none; width:100%; box-sizing:border-box; }
        .wa-tag-input:focus { border-color:var(--igls-accent,#c9a876); }
        .wa-tag-input-sm { width:auto; flex:0 0 54px; text-align:center; }
        .wa-tag-btn { background:rgba(255,255,255,.06); color:var(--igls-text,#ece9e4); border:1px solid var(--igls-border,rgba(255,255,255,.08)); border-radius:6px; padding:6px 10px; font-size:11px; font-weight:600; cursor:pointer; }
        .wa-tag-btn:hover { filter:brightness(1.15); }
        .wa-tag-btn-accent { background:var(--igls-accent,#c9a876); color:#171208; border:none; }
        .wa-tag-btn-icon { background:transparent; border:none; color:var(--igls-text-dim,#96949c); cursor:pointer; font-size:12px; padding:2px 5px; border-radius:4px; }
        .wa-tag-btn-icon:hover { color:var(--igls-accent,#c9a876); background:rgba(255,255,255,.08); }
        .wa-tag-row { display:flex; gap:6px; }
        .wa-tag-fields-form { display:flex; flex-direction:column; gap:8px; }
        .wa-tag-field-row { display:flex; flex-direction:column; gap:3px; }
        .wa-tag-field-label { font-size:10.5px; color:var(--igls-text-dim,#96949c); display:flex; align-items:center; gap:5px; }
        .wa-tag-key-badge { font-size:9px; background:rgba(255,255,255,.08); padding:1px 5px; border-radius:8px; }
        .wa-tag-other { display:flex; flex-direction:column; gap:5px; }
        .wa-tag-other-list { display:flex; flex-wrap:wrap; gap:5px; }
        .wa-tag-chip { background:rgba(255,255,255,.06); border:1px solid var(--igls-border,rgba(255,255,255,.08)); border-radius:10px; padding:3px 6px; font-size:10px; display:flex; align-items:center; gap:5px; }
        .wa-tag-chip-remove { background:transparent; border:none; color:var(--igls-text-dim,#96949c); cursor:pointer; font-size:10px; }
        .wa-tag-preview { background:var(--igls-surface-2,#1c1c23); border:1px dashed var(--igls-border,rgba(255,255,255,.15)); border-radius:6px; padding:8px; font-size:11px; color:var(--igls-text,#ece9e4); word-break:break-word; min-height:16px; }
        .wa-tag-setting-card { background:rgba(255,255,255,.03); border:1px solid var(--igls-border,rgba(255,255,255,.06)); border-radius:6px; padding:6px; display:flex; flex-direction:column; gap:6px; }
        .wa-tag-setting-row { display:flex; gap:4px; align-items:center; }
        .wa-tag-setting-color-row { display:flex; flex-direction:column; gap:6px; }
        .wa-tag-color-input { width:26px; height:26px; border:1px solid var(--igls-border,rgba(255,255,255,.1)); border-radius:6px; cursor:pointer; background:transparent; padding:0; flex-shrink:0; }
        .wa-tag-option-row { display:flex; gap:4px; align-items:center; }
        .wa-tag-setting-toggles { display:flex; gap:12px; flex-wrap:wrap; }
        .wa-tag-setting-toggles label { display:flex; align-items:center; gap:5px; font-size:10px; color:var(--igls-text-dim,#96949c); cursor:pointer; }
        .wa-tag-settings-divider { border-top:1px solid var(--igls-border,rgba(255,255,255,.08)); margin-top:4px; padding-top:8px; display:flex; flex-direction:column; gap:6px; }
        .wa-tag-status { font-size:10px; color:var(--igls-text-dim,#96949c); }
      `;
      document.head.appendChild(style);
    }

    // ---------------- UI shell ----------------
    const wrap = document.createElement('div');
    wrap.className = 'wa-tag-wrap';
    wrap.innerHTML = `
      <div class="wa-tag-view-tabs">
        <button class="wa-tag-view-tab" data-view="generate">Generar nombre</button>
        <button class="wa-tag-view-tab" data-view="settings">Configurar campos</button>
      </div>

      <div id="wa-tag-view-generate">
        <div class="wa-tag-section">
          <label class="wa-tag-label">Pegar nombre completo existente</label>
          <textarea id="wa-tag-paste" class="wa-tag-textarea" placeholder="Ej: Pablo Perez [C:ACN] [S:Pagado]"></textarea>
          <button id="wa-tag-parse-btn" class="wa-tag-btn wa-tag-btn-accent">Analizar nombre</button>
        </div>

        <div class="wa-tag-section" style="margin-top:10px;">
          <label class="wa-tag-label">Nombre base</label>
          <input type="text" id="wa-tag-basename" class="wa-tag-input" placeholder="Ej: Pablo Perez">
        </div>

        <div id="wa-tag-fields-form" class="wa-tag-fields-form" style="margin-top:10px;"></div>

        <div id="wa-tag-other" class="wa-tag-other" style="display:none; margin-top:10px;">
          <label class="wa-tag-label">Otras etiquetas (sin reconocer)</label>
          <div id="wa-tag-other-list" class="wa-tag-other-list"></div>
        </div>

        <div class="wa-tag-section" style="margin-top:10px;">
          <label class="wa-tag-label">Vista previa</label>
          <div id="wa-tag-preview" class="wa-tag-preview"></div>
          <div class="wa-tag-row">
            <button id="wa-tag-copy-btn" class="wa-tag-btn wa-tag-btn-accent">📋 Copiar</button>
            <button id="wa-tag-reset-btn" class="wa-tag-btn">Nuevo / Limpiar</button>
          </div>
        </div>
      </div>

      <div id="wa-tag-view-settings" style="display:none;">
        <div id="wa-tag-settings-panel" style="display:flex; flex-direction:column; gap:8px;"></div>

        <div class="wa-tag-settings-divider">
          <label class="wa-tag-label">Configuración de campos (Excel / Google Sheets)</label>
          <div class="wa-tag-row">
            <button id="wa-tag-config-export-btn" class="wa-tag-btn wa-tag-btn-accent">⬇️ Exportar a Excel</button>
          </div>
          <input type="text" id="wa-tag-config-sheet-url" class="wa-tag-input" placeholder="https://docs.google.com/spreadsheets/d/...">
          <button id="wa-tag-config-import-btn" class="wa-tag-btn">📥 Importar desde Google Sheets (reemplaza todo)</button>
          <div id="wa-tag-config-status" class="wa-tag-status">Columnas esperadas: Clave, Etiqueta, Tipo, Opciones, Colores, ColorPorDefecto, Oculto, Miles.</div>
        </div>
      </div>
    `;

    // ---------------- View switching ----------------
    function setView(view) {
      localStorage.setItem(VIEW_KEY, view);
      wrap.querySelector('#wa-tag-view-generate').style.display = view === 'generate' ? '' : 'none';
      wrap.querySelector('#wa-tag-view-settings').style.display = view === 'settings' ? '' : 'none';
      wrap.querySelectorAll('.wa-tag-view-tab').forEach(btn => btn.classList.toggle('active', btn.dataset.view === view));
      if (view === 'settings') renderSettingsPanel();
    }
    wrap.querySelectorAll('.wa-tag-view-tab').forEach(btn => {
      btn.onclick = () => setView(btn.dataset.view);
    });

    // ---------------- Render: dynamic field form (Generator view) ----------------
    function renderFormFields() {
      const container = wrap.querySelector('#wa-tag-fields-form');
      container.innerHTML = '';
      fields.forEach(f => {
        const row = document.createElement('div');
        row.className = 'wa-tag-field-row';
        let inputHtml;
        if (f.inputType === 'select') {
          const opts = (f.options || []).map(o =>
            `<option value="${o}" ${state.values[f.key] === o ? 'selected' : ''}>${o}</option>`
          ).join('');
          inputHtml = `<select class="wa-tag-input" data-field-key="${f.key}"><option value="">—</option>${opts}</select>`;
        } else {
          const type = f.inputType === 'number' ? 'number' : (f.inputType === 'date' ? 'date' : 'text');
          const val = state.values[f.key] || '';
          inputHtml = `<input type="${type}" class="wa-tag-input" data-field-key="${f.key}" value="${val}">`;
        }
        const hiddenNote = f.hidden ? ' <span class="wa-tag-key-badge" title="No se muestra como insignia">oculto</span>' : '';
        row.innerHTML = `<label class="wa-tag-field-label">${f.label} <span class="wa-tag-key-badge">${f.key}</span>${hiddenNote}</label>${inputHtml}`;
        container.appendChild(row);
      });
      container.querySelectorAll('[data-field-key]').forEach(el => {
        const handler = () => { state.values[el.dataset.fieldKey] = el.value; updatePreview(); };
        el.addEventListener('input', handler);
        el.addEventListener('change', handler);
      });
    }

    function renderOtherTags() {
      const wrapEl = wrap.querySelector('#wa-tag-other');
      const list = wrap.querySelector('#wa-tag-other-list');
      list.innerHTML = '';
      if (!state.otherTags.length) { wrapEl.style.display = 'none'; return; }
      wrapEl.style.display = '';
      state.otherTags.forEach((t, idx) => {
        const chip = document.createElement('span');
        chip.className = 'wa-tag-chip';
        chip.innerHTML = `[${t.key}:${t.value}] <button class="wa-tag-chip-remove" data-idx="${idx}">✕</button>`;
        list.appendChild(chip);
      });
      list.querySelectorAll('.wa-tag-chip-remove').forEach(btn => {
        btn.onclick = () => {
          state.otherTags.splice(Number(btn.dataset.idx), 1);
          renderOtherTags();
          updatePreview();
        };
      });
    }

    function updatePreview() {
      const preview = wrap.querySelector('#wa-tag-preview');
      preview.textContent = buildFullName(state.baseName, state.values, state.otherTags) || '—';
    }

    wrap.querySelector('#wa-tag-parse-btn').onclick = () => {
      const raw = wrap.querySelector('#wa-tag-paste').value;
      if (!raw.trim()) return;
      const { baseName, found } = parseFullName(raw);
      const knownKeys = fields.map(f => f.key);
      state.baseName = baseName;
      state.values = {};
      state.otherTags = [];
      found.forEach(t => {
        if (knownKeys.includes(t.key)) state.values[t.key] = t.value;
        else state.otherTags.push(t);
      });
      wrap.querySelector('#wa-tag-basename').value = state.baseName;
      renderFormFields();
      renderOtherTags();
      updatePreview();
    };

    wrap.querySelector('#wa-tag-basename').addEventListener('input', e => {
      state.baseName = e.target.value;
      updatePreview();
    });

    wrap.querySelector('#wa-tag-copy-btn').onclick = () => {
      const text = buildFullName(state.baseName, state.values, state.otherTags);
      const btn = wrap.querySelector('#wa-tag-copy-btn');
      const original = btn.textContent;
      const flash = () => { btn.textContent = '✅ Copiado'; setTimeout(() => { btn.textContent = original; }, 1200); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(flash).catch(() => fallbackCopy(text, flash));
      } else {
        fallbackCopy(text, flash);
      }
    };
    function fallbackCopy(text, cb) {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); cb(); } catch (e) { /* ignore */ }
      document.body.removeChild(ta);
    }

    wrap.querySelector('#wa-tag-reset-btn').onclick = () => {
      state = { baseName: '', values: {}, otherTags: [] };
      wrap.querySelector('#wa-tag-paste').value = '';
      wrap.querySelector('#wa-tag-basename').value = '';
      renderFormFields();
      renderOtherTags();
      updatePreview();
    };

    // ---------------- Settings view: field cards ----------------
    function renderSettingsPanel() {
      const panel = wrap.querySelector('#wa-tag-settings-panel');
      panel.innerHTML = '';

      fields.forEach((f, idx) => {
        const card = document.createElement('div');
        card.className = 'wa-tag-setting-card';
        card.innerHTML = `
          <div class="wa-tag-setting-row">
            <input type="text" class="wa-tag-input wa-tag-input-sm" data-role="key" value="${f.key}" maxlength="6" title="Clave, ej: C">
            <input type="text" class="wa-tag-input" data-role="label" value="${f.label}" placeholder="Etiqueta">
            <select class="wa-tag-input wa-tag-input-sm" data-role="type" style="flex:0 0 84px;">
              <option value="text" ${f.inputType === 'text' ? 'selected' : ''}>Texto</option>
              <option value="number" ${f.inputType === 'number' ? 'selected' : ''}>Número</option>
              <option value="date" ${f.inputType === 'date' ? 'selected' : ''}>Fecha</option>
              <option value="select" ${f.inputType === 'select' ? 'selected' : ''}>Lista</option>
            </select>
            <button class="wa-tag-btn-icon" data-role="up" title="Subir">↑</button>
            <button class="wa-tag-btn-icon" data-role="down" title="Bajar">↓</button>
            <button class="wa-tag-btn-icon" data-role="del" title="Eliminar">🗑️</button>
          </div>
          <div class="wa-tag-setting-toggles">
            <label><input type="checkbox" data-role="hidden" ${f.hidden ? 'checked' : ''}> Ocultar en insignias</label>
            ${f.inputType === 'number' ? `<label><input type="checkbox" data-role="thousands" ${f.thousands ? 'checked' : ''}> Mostrar en miles (50000 → 50)</label>` : ''}
          </div>
          <div class="wa-tag-setting-color-row" data-role="color-row"></div>
        `;
        panel.appendChild(card);

        const colorRow = card.querySelector('[data-role="color-row"]');
        function renderColorRow() {
          colorRow.innerHTML = '';
          if (f.inputType === 'select') {
            f.options = f.options || [];
            f.valueColors = f.valueColors || {};

            const optList = document.createElement('div');
            optList.style.cssText = 'display:flex; flex-direction:column; gap:4px;';
            f.options.forEach((opt, oIdx) => {
              const row = document.createElement('div');
              row.className = 'wa-tag-option-row';
              const optColor = f.valueColors[opt] || nextPaletteColor(Object.values(f.valueColors));
              row.innerHTML = `
                <input type="color" class="wa-tag-color-input" data-role="opt-color" value="${optColor}">
                <input type="text" class="wa-tag-input" data-role="opt-name" value="${opt}">
                <button class="wa-tag-btn-icon" data-role="opt-del" title="Eliminar opción">✕</button>
              `;
              optList.appendChild(row);

              row.querySelector('[data-role="opt-color"]').addEventListener('input', e => {
                f.valueColors[opt] = e.target.value;
                saveFields();
              });
              row.querySelector('[data-role="opt-name"]').addEventListener('change', e => {
                const newName = e.target.value.trim();
                if (!newName) { e.target.value = opt; return; }
                if (newName !== opt && f.options.includes(newName)) { alert('Ya existe esa opción.'); e.target.value = opt; return; }
                const color = f.valueColors[opt];
                delete f.valueColors[opt];
                f.valueColors[newName] = color;
                f.options[oIdx] = newName;
                saveFields();
                renderColorRow();
                renderFormFields();
              });
              row.querySelector('[data-role="opt-del"]').onclick = () => {
                delete f.valueColors[opt];
                f.options.splice(oIdx, 1);
                saveFields();
                renderColorRow();
                renderFormFields();
              };
            });
            colorRow.appendChild(optList);

            const addRow = document.createElement('div');
            addRow.className = 'wa-tag-option-row';
            addRow.innerHTML = `
              <input type="text" class="wa-tag-input" placeholder="Nueva opción...">
              <button class="wa-tag-btn wa-tag-btn-accent" style="flex-shrink:0;">+ Agregar</button>
            `;
            colorRow.appendChild(addRow);
            const addInput = addRow.querySelector('input');
            const addBtn = addRow.querySelector('button');
            function doAdd() {
              const name = addInput.value.trim();
              if (!name) return;
              if (f.options.includes(name)) { alert('Ya existe esa opción.'); return; }
              f.options.push(name);
              f.valueColors[name] = nextPaletteColor(Object.values(f.valueColors));
              addInput.value = '';
              saveFields();
              renderColorRow();
              renderFormFields();
            }
            addBtn.onclick = doAdd;
            addInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doAdd(); } });
          } else {
            const sw = document.createElement('input');
            sw.type = 'color';
            sw.className = 'wa-tag-color-input';
            sw.value = f.color || '#8ecae6';
            colorRow.appendChild(sw);
            sw.addEventListener('input', () => { f.color = sw.value; saveFields(); });
          }
        }
        renderColorRow();

        card.querySelector('[data-role="key"]').addEventListener('change', e => {
          const newKey = e.target.value.trim().replace(/\s+/g, '');
          if (!newKey) { e.target.value = f.key; return; }
          if (fields.some((other, i) => i !== idx && other.key === newKey)) {
            alert('Ya existe un campo con esa clave.');
            e.target.value = f.key;
            return;
          }
          f.key = newKey;
          saveFields();
          renderFormFields();
        });
        card.querySelector('[data-role="label"]').addEventListener('change', e => {
          f.label = e.target.value.trim() || f.key;
          saveFields();
          renderFormFields();
        });
        card.querySelector('[data-role="type"]').addEventListener('change', e => {
          f.inputType = e.target.value;
          if (f.inputType === 'select' && !f.options) { f.options = []; f.valueColors = {}; }
          if (f.inputType !== 'select' && !f.color) { f.color = nextPaletteColor(fields.filter(x => x.color).map(x => x.color)); }
          if (f.inputType !== 'number') delete f.thousands;
          saveFields();
          renderSettingsPanel();
          renderFormFields();
        });
        card.querySelector('[data-role="hidden"]').addEventListener('change', e => {
          f.hidden = e.target.checked;
          saveFields();
          renderFormFields();
        });
        const thousandsChk = card.querySelector('[data-role="thousands"]');
        if (thousandsChk) {
          thousandsChk.addEventListener('change', e => {
            f.thousands = e.target.checked;
            saveFields();
          });
        }
        card.querySelector('[data-role="up"]').onclick = () => {
          if (idx === 0) return;
          [fields[idx - 1], fields[idx]] = [fields[idx], fields[idx - 1]];
          saveFields(); renderSettingsPanel(); renderFormFields();
        };
        card.querySelector('[data-role="down"]').onclick = () => {
          if (idx === fields.length - 1) return;
          [fields[idx + 1], fields[idx]] = [fields[idx], fields[idx + 1]];
          saveFields(); renderSettingsPanel(); renderFormFields();
        };
        card.querySelector('[data-role="del"]').onclick = () => {
          if (!confirm(`¿Eliminar el campo "${f.label}"?`)) return;
          fields.splice(idx, 1);
          saveFields(); renderSettingsPanel(); renderFormFields();
        };
      });

      const addBtn = document.createElement('button');
      addBtn.className = 'wa-tag-btn wa-tag-btn-accent';
      addBtn.textContent = '+ Agregar campo';
      addBtn.onclick = () => {
        const usedColors = fields.filter(f => f.color).map(f => f.color);
        fields.push({ key: 'X' + (fields.length + 1), label: 'Nuevo campo', inputType: 'text', color: nextPaletteColor(usedColors) });
        saveFields();
        renderSettingsPanel();
        renderFormFields();
      };
      panel.appendChild(addBtn);
    }

    // ---------------- Field config: Excel export ----------------
    wrap.querySelector('#wa-tag-config-export-btn').onclick = () => {
      if (typeof XLSX === 'undefined') {
        alert('Falta la librería XLSX. Agrega esta línea al encabezado de tu script de Tampermonkey:\n\n// @require https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js\n\nLuego recarga WhatsApp Web.');
        return;
      }
      const typeLabel = { text: 'Texto', number: 'Número', date: 'Fecha', select: 'Lista' };
      const rows = fields.map(f => ({
        Clave: f.key,
        Etiqueta: f.label,
        Tipo: typeLabel[f.inputType] || f.inputType,
        Opciones: f.inputType === 'select' ? (f.options || []).join(',') : '',
        Colores: f.inputType === 'select' ? (f.options || []).map(o => (f.valueColors && f.valueColors[o]) || '').join(',') : '',
        ColorPorDefecto: f.inputType !== 'select' ? (f.color || '') : '',
        Oculto: f.hidden ? 'TRUE' : 'FALSE',
        Miles: f.thousands ? 'TRUE' : 'FALSE'
      }));
      const ws = XLSX.utils.json_to_sheet(rows, { header: ['Clave', 'Etiqueta', 'Tipo', 'Opciones', 'Colores', 'ColorPorDefecto', 'Oculto', 'Miles'] });
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Campos');
      XLSX.writeFile(wb, `config_campos_contactos_${new Date().toISOString().slice(0, 10)}.xlsx`);
    };

    // ---------------- Field config: Google Sheets import (replaces everything) ----------------
    function setConfigStatus(msg) { wrap.querySelector('#wa-tag-config-status').textContent = msg; }

    wrap.querySelector('#wa-tag-config-import-btn').onclick = async () => {
      const url = wrap.querySelector('#wa-tag-config-sheet-url').value.trim();
      if (!url) { setConfigStatus('Pega primero un link de Google Sheets.'); return; }
      const exportUrl = extractSheetExportUrl(url);
      if (!exportUrl) { setConfigStatus('No se pudo leer el ID de la hoja en ese link.'); return; }

      setConfigStatus('Descargando hoja...');
      let csvText;
      try {
        csvText = await fetchGoogleSheetCsv(exportUrl);
      } catch (err) {
        setConfigStatus(err.message);
        return;
      }

      const rows = parseCsv(csvText);
      if (rows.length < 2) { setConfigStatus('La hoja no tiene filas de datos.'); return; }

      const header = rows[0].map(h => h.trim().toLowerCase());
      const idx = {
        clave: header.indexOf('clave'),
        etiqueta: header.indexOf('etiqueta'),
        tipo: header.indexOf('tipo'),
        opciones: header.indexOf('opciones'),
        colores: header.indexOf('colores'),
        colorpordefecto: header.indexOf('colorpordefecto'),
        oculto: header.indexOf('oculto'),
        miles: header.indexOf('miles')
      };
      if (idx.clave === -1 || idx.etiqueta === -1 || idx.tipo === -1) {
        setConfigStatus('La hoja necesita columnas Clave, Etiqueta y Tipo.');
        return;
      }

      const typeMap = { 'texto': 'text', 'número': 'number', 'numero': 'number', 'fecha': 'date', 'lista': 'select' };
      const isTrue = v => /^(true|verdadero|1)$/i.test((v || '').trim());
      const newFields = [];

      for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        const key = (r[idx.clave] || '').trim();
        const label = (r[idx.etiqueta] || '').trim();
        if (!key || !label) continue;
        const tipoRaw = (r[idx.tipo] || '').trim().toLowerCase();
        const inputType = typeMap[tipoRaw] || (['text', 'number', 'date', 'select'].includes(tipoRaw) ? tipoRaw : 'text');
        const hidden = idx.oculto !== -1 && isTrue(r[idx.oculto]);
        const field = { key, label, inputType, hidden };

        if (inputType === 'select') {
          const opts = (idx.opciones !== -1 ? (r[idx.opciones] || '') : '').split(',').map(s => s.trim()).filter(Boolean);
          const cols = (idx.colores !== -1 ? (r[idx.colores] || '') : '').split(',').map(s => s.trim());
          field.options = opts;
          field.valueColors = {};
          opts.forEach((o, oi) => { field.valueColors[o] = cols[oi] || nextPaletteColor(Object.values(field.valueColors)); });
        } else {
          field.color = (idx.colorpordefecto !== -1 ? (r[idx.colorpordefecto] || '').trim() : '') || nextPaletteColor([]);
          if (inputType === 'number') field.thousands = idx.miles !== -1 && isTrue(r[idx.miles]);
        }
        newFields.push(field);
      }

      if (!newFields.length) { setConfigStatus('No se encontraron campos válidos en la hoja.'); return; }

      if (!confirm(`Esto reemplazará tu configuración actual (${fields.length} campo(s)) con ${newFields.length} campo(s) de la hoja.\n\n¿Continuar?`)) {
        setConfigStatus('Importación cancelada.');
        return;
      }

      fields = newFields;
      saveFields();
      renderSettingsPanel();
      renderFormFields();
      setConfigStatus(`✅ ${newFields.length} campo(s) importados correctamente.`);
    };

    // ---------------- Mount ----------------
    function mountCard(attemptsLeft) {
      attemptsLeft = attemptsLeft === undefined ? 10 : attemptsLeft;
      if (typeof core.registerMenu === 'function') {
        injectStyles();
        core.registerMenu('left', '🏷️ Editor de Contactos', wrap, '⠿', 'contact-tag-editor');
        renderFormFields();
        renderOtherTags();
        updatePreview();
        setView(localStorage.getItem(VIEW_KEY) === 'settings' ? 'settings' : 'generate');
      } else if (attemptsLeft > 0) {
        setTimeout(() => mountCard(attemptsLeft - 1), 200);
      }
    }
    mountCard();

    core.emit('block:ready', { id: 'contactTagEditorPlugin' });
  }
});

/* ============================================================
   BLOCK: Contact Badge Renderer (v6)
   ============================================================ */
/* ============================================================
   BLOCK 2: Contact Badge Renderer (v7)
   ------------------------------------------------------------
   Standalone plugin -- reads the SAME localStorage config that
   Block 1 (Contact Tag Editor) writes to ("wa_tag_fields_v1").

   v7 additions:
   - Respects each field's "hidden" flag (set in Block 1) -- a
     hidden field's tag is skipped in the pill row, but still
     exists in the actual contact name and still shows up in the
     hover tooltip. Nothing is ever deleted, just not shown as a
     pill.
   - Respects each field's "thousands" flag (number fields only,
     set in Block 1) -- the pill shows value/1000 rounded (e.g.
     50000 -> 50). This is a DISPLAY-ONLY shorthand: the raw value
     in the contact name is untouched, and the tooltip always
     shows the full raw value.
   - New hover tooltip: hovering a tagged contact shows every tag
     (including hidden ones) as "Label: value", one per line, in
     save order -- a full always-available reference regardless of
     what's toggled visible as a pill.

   BEHAVIOR (unchanged from v6):
   - Headline is always the base name exactly as saved.
   - Pills render in the order the tags appear in the saved name.
   - Works by overriding WhatsApp's own ellipsis-truncation CSS on
     the name span, then writing headline + pills directly into it.

   PILL APPEARANCE CONTROLS (unchanged from v6)
   Tamaño de texto / Relleno / Radio de esquina, live +/- steppers.
   Per-FIELD colors are configured in Block 1.

   DEBUGGING
   DEBUG is on by default -- logs a scan summary every 700ms.
   Set DEBUG = false once everything looks right.
   ============================================================ */
LegoCore.registerBlock({
  id: 'contactBadgeRendererPlugin',
  init(core) {
    const DEBUG = true;

    const FIELDS_KEY = 'wa_tag_fields_v1';
    const MASTER_KEY = 'wa_tag_badges_master_v1';
    const FONT_KEY = 'wa_tag_pill_font_v1';
    const PAD_KEY = 'wa_tag_pill_pad_v1';
    const RADIUS_KEY = 'wa_tag_pill_radius_v1';

    const DEFAULT_FIELDS = [
      { key: 'C', label: 'Curso', inputType: 'text', color: '#8ecae6' },
      { key: 'G', label: 'Generación', inputType: 'text', color: '#c792ea' },
      { key: 'V', label: 'Vence', inputType: 'date', color: '#ff9770' },
      { key: 'H', label: 'Hijo/Alumno', inputType: 'text', color: '#7ee787' },
      { key: 'E', label: 'Edad', inputType: 'number', color: '#f6c344' },
      { key: 'P', label: 'Precio', inputType: 'number', color: '#c9a876', thousands: true },
      { key: 'S', label: 'Pago', inputType: 'select', options: ['Pagado', 'Pendiente'], valueColors: { 'Pagado': '#7ee787', 'Pendiente': '#ff8fa3' } },
      { key: 'A', label: 'Activo', inputType: 'select', options: ['Activo', 'Inactivo'], valueColors: { 'Activo': '#7ee787', 'Inactivo': '#96949c' } },
      { key: 'F', label: 'Formulario', inputType: 'select', options: ['Sí', 'No'], valueColors: { 'Sí': '#7ee787', 'No': '#96949c' } }
    ];

    function getFields() {
      try {
        const f = JSON.parse(localStorage.getItem(FIELDS_KEY));
        if (Array.isArray(f) && f.length) return f;
      } catch (e) { /* ignore */ }
      return DEFAULT_FIELDS;
    }

    let masterEnabled = localStorage.getItem(MASTER_KEY) !== 'false';
    function saveMaster() { localStorage.setItem(MASTER_KEY, String(masterEnabled)); }

    function getFont() { const v = parseFloat(localStorage.getItem(FONT_KEY)); return Number.isFinite(v) ? v : 9.5; }
    function setFont(v) { localStorage.setItem(FONT_KEY, String(Math.max(6, v))); }
    function getPad() { const v = parseFloat(localStorage.getItem(PAD_KEY)); return Number.isFinite(v) ? v : 7; }
    function setPad(v) { localStorage.setItem(PAD_KEY, String(Math.max(2, v))); }
    function getRadius() { const v = parseFloat(localStorage.getItem(RADIUS_KEY)); return Number.isFinite(v) ? v : 8; }
    function setRadius(v) { localStorage.setItem(RADIUS_KEY, String(Math.max(0, v))); }

    // ---------------- Parsing (same format as Block 1) ----------------
    function parseFullName(raw) {
      const tagRe = /\[(\w+):([^\]]*)\]/g;
      const found = [];
      let m;
      while ((m = tagRe.exec(raw)) !== null) found.push({ key: m[1], value: m[2].trim() });
      const firstBracket = raw.indexOf('[');
      const baseName = (firstBracket === -1 ? raw : raw.slice(0, firstBracket)).trim();
      return { baseName, found };
    }

    function contrastColor(hex) {
      if (!hex || hex[0] !== '#' || hex.length < 7) return '#000000';
      const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
      const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      return luminance > 0.6 ? '#000000' : '#ffffff';
    }

    // ---------------- Styles ----------------
    function injectStyles() {
      if (document.getElementById('wa-tag-badge-styles')) return;
      const style = document.createElement('style');
      style.id = 'wa-tag-badge-styles';
      style.innerHTML = `
        .wa-tag-badge-pill { font-weight:700; line-height:1.6; white-space:nowrap; }
        .wa-tag-badges-wrap { display:flex; flex-direction:column; gap:8px; font-family:-apple-system,sans-serif; font-size:11px; }
        .wa-tag-badges-master { display:flex; align-items:center; justify-content:space-between; background:var(--igls-surface-2,#1c1c23); border:1px solid var(--igls-border,rgba(255,255,255,.07)); border-radius:6px; padding:6px 8px; gap:8px; }
        .wa-tag-badges-master label { display:flex; align-items:center; gap:6px; cursor:pointer; font-size:10.5px; color:var(--igls-text-dim,#96949c); }
        .wa-tag-badges-note { font-size:10px; color:var(--igls-text-dim,#96949c); line-height:1.5; }
        .wa-tag-btn-icon { background:rgba(255,255,255,.06); border:1px solid var(--igls-border,rgba(255,255,255,.08)); color:var(--igls-text,#ece9e4); cursor:pointer; font-size:13px; font-weight:700; width:24px; height:24px; border-radius:5px; }
        .wa-tag-btn-icon:hover { color:var(--igls-accent,#c9a876); }
        .wa-tag-tooltip { position:fixed; z-index:99999; background:#171208; color:#ece9e4; border:1px solid rgba(255,255,255,.15); border-radius:6px; padding:8px 10px; font-size:11px; font-family:-apple-system,sans-serif; box-shadow:0 4px 16px rgba(0,0,0,.4); max-width:280px; display:none; pointer-events:none; }
        .wa-tag-tooltip-row { white-space:nowrap; padding:1px 0; }
        .wa-tag-tooltip-label { color:#c9a876; font-weight:700; margin-right:4px; }
      `;
      document.head.appendChild(style);
    }

    // ---------------- Sidebar card ----------------
    const wrap = document.createElement('div');
    wrap.className = 'wa-tag-badges-wrap';
    wrap.innerHTML = `
      <div class="wa-tag-badges-master">
        <label><input type="checkbox" id="wa-tag-badges-master-chk" ${masterEnabled ? 'checked' : ''}> Mostrar insignias</label>
      </div>
      <div class="wa-tag-badges-master">
        <label style="cursor:default;">Tamaño de texto: <b id="wa-tag-font-val">${getFont()}</b>px</label>
        <div style="display:flex; gap:4px;">
          <button id="wa-tag-font-down" class="wa-tag-btn-icon">−</button>
          <button id="wa-tag-font-up" class="wa-tag-btn-icon">+</button>
        </div>
      </div>
      <div class="wa-tag-badges-master">
        <label style="cursor:default;">Relleno: <b id="wa-tag-pad-val">${getPad()}</b>px</label>
        <div style="display:flex; gap:4px;">
          <button id="wa-tag-pad-down" class="wa-tag-btn-icon">−</button>
          <button id="wa-tag-pad-up" class="wa-tag-btn-icon">+</button>
        </div>
      </div>
      <div class="wa-tag-badges-master">
        <label style="cursor:default;">Radio de esquina: <b id="wa-tag-radius-val">${getRadius()}</b>px</label>
        <div style="display:flex; gap:4px;">
          <button id="wa-tag-radius-down" class="wa-tag-btn-icon">−</button>
          <button id="wa-tag-radius-up" class="wa-tag-btn-icon">+</button>
        </div>
      </div>
      <div class="wa-tag-badges-note">Los colores, el ocultar campos y "mostrar en miles" se configuran por campo en el bloque "Editor de Contactos". Aquí solo se ajusta el tamaño/forma general de las insignias. Pasa el cursor sobre un contacto etiquetado para ver todos sus datos, incluidos los campos ocultos.</div>
    `;

    wrap.querySelector('#wa-tag-badges-master-chk').onchange = e => {
      masterEnabled = e.target.checked;
      saveMaster();
      if (!masterEnabled) {
        document.querySelectorAll('span[data-wa-tag-inline-source]').forEach(span => revertInlineSpan(span));
        hideTooltip();
      }
    };

    function bumpFont(delta) { setFont(getFont() + delta); wrap.querySelector('#wa-tag-font-val').textContent = getFont(); }
    function bumpPad(delta) { setPad(getPad() + delta); wrap.querySelector('#wa-tag-pad-val').textContent = getPad(); }
    function bumpRadius(delta) { setRadius(getRadius() + delta); wrap.querySelector('#wa-tag-radius-val').textContent = getRadius(); }

    wrap.querySelector('#wa-tag-font-down').onclick = () => bumpFont(-0.5);
    wrap.querySelector('#wa-tag-font-up').onclick = () => bumpFont(0.5);
    wrap.querySelector('#wa-tag-pad-down').onclick = () => bumpPad(-1);
    wrap.querySelector('#wa-tag-pad-up').onclick = () => bumpPad(1);
    wrap.querySelector('#wa-tag-radius-down').onclick = () => bumpRadius(-1);
    wrap.querySelector('#wa-tag-radius-up').onclick = () => bumpRadius(1);

    // ---------------- Hover tooltip (full detail, including hidden fields) ----------------
    let tooltipEl = null;
    function ensureTooltip() {
      if (tooltipEl) return tooltipEl;
      tooltipEl = document.createElement('div');
      tooltipEl.className = 'wa-tag-tooltip';
      document.body.appendChild(tooltipEl);
      return tooltipEl;
    }
    function showTooltip(span) {
      const rawName = span.getAttribute('title') || '';
      const { found } = parseFullName(rawName);
      const fields = getFields();
      const fieldByKey = {};
      fields.forEach(f => { fieldByKey[f.key] = f; });

      const lines = found.map(t => {
        const field = fieldByKey[t.key];
        if (!field || !t.value) return null;
        return `<div class="wa-tag-tooltip-row"><span class="wa-tag-tooltip-label">${field.label}:</span>${t.value}</div>`;
      }).filter(Boolean);
      if (!lines.length) return;

      const tip = ensureTooltip();
      tip.innerHTML = lines.join('');
      const rect = span.getBoundingClientRect();
      tip.style.display = 'block';
      const tipRect = tip.getBoundingClientRect();
      let left = rect.left;
      if (left + tipRect.width > window.innerWidth - 8) left = window.innerWidth - tipRect.width - 8;
      tip.style.left = Math.max(8, left) + 'px';
      tip.style.top = (rect.bottom + 4) + 'px';
    }
    function hideTooltip() {
      if (tooltipEl) tooltipEl.style.display = 'none';
    }
    function bindHoverTooltip(span) {
      if (span.__waTagHoverBound) return;
      span.__waTagHoverBound = true;
      span.addEventListener('mouseenter', () => showTooltip(span));
      span.addEventListener('mouseleave', hideTooltip);
    }

    // ---------------- Apply / revert ----------------
    function applyInlineMode(span, rawName) {
      const { baseName, found } = parseFullName(rawName);
      const fields = getFields();
      const fieldByKey = {};
      fields.forEach(f => { fieldByKey[f.key] = f; });

      const fontSize = getFont();
      const padH = getPad();
      const padV = Math.max(1, Math.round(padH / 3));
      const radius = getRadius();

      // Override just the properties that cause WhatsApp's ellipsis clipping.
      span.style.whiteSpace = 'normal';
      span.style.overflow = 'visible';
      span.style.textOverflow = 'unset';
      span.style.maxWidth = 'none';
      span.style.display = 'inline-flex';
      span.style.flexWrap = 'wrap';
      span.style.alignItems = 'center';
      span.style.gap = '4px';
      span.style.lineHeight = '1.6';

      span.innerHTML = '';
      span.appendChild(document.createTextNode(baseName || ''));

      let pillCount = 0;
      found.forEach(t => {
        const field = fieldByKey[t.key];
        if (!field || !t.value || field.hidden) return;
        let bg = field.color;
        if (field.inputType === 'select' && field.valueColors) {
          bg = field.valueColors[t.value] || field.color || '#8ecae6';
        }
        if (!bg) return;

        let displayValue = t.value;
        if (field.inputType === 'number' && field.thousands) {
          const num = parseFloat(t.value);
          if (Number.isFinite(num)) displayValue = String(Math.round(num / 1000));
        }

        const pill = document.createElement('span');
        pill.className = 'wa-tag-badge-pill';
        pill.style.backgroundColor = bg;
        pill.style.color = contrastColor(bg);
        pill.style.fontSize = fontSize + 'px';
        pill.style.padding = `${padV}px ${padH}px`;
        pill.style.borderRadius = radius + 'px';
        pill.textContent = displayValue;
        span.appendChild(pill);
        pillCount++;
      });

      bindHoverTooltip(span);

      if (!pillCount) {
        // Still worth keeping the tooltip binding even if every matching
        // field is hidden -- but with nothing visibly changed, revert the
        // span text so it doesn't look broken/empty.
        if (found.some(t => fieldByKey[t.key])) return true; // has recognized (if hidden) tags -- keep tooltip active, span already shows base name
        revertInlineSpan(span);
        return false;
      }
      return true;
    }

    function revertInlineSpan(span) {
      span.style.whiteSpace = '';
      span.style.overflow = '';
      span.style.textOverflow = '';
      span.style.maxWidth = '';
      span.style.display = '';
      span.style.flexWrap = '';
      span.style.alignItems = '';
      span.style.gap = '';
      span.style.lineHeight = '';
      span.textContent = span.getAttribute('title') || '';
      delete span.dataset.waTagInlineSource;
    }

    // ---------------- Scan loop ----------------
    function scanAndRender() {
      if (!masterEnabled) return;
      const scopeRoot = document.querySelector('#pane-side') || document;
      const spans = scopeRoot.querySelectorAll('span[title]');
      const font = getFont(), pad = getPad(), radius = getRadius();
      let processed = 0;

      spans.forEach(span => {
        const rawName = span.getAttribute('title') || '';
        if (!rawName.includes('[')) {
          if (span.dataset.waTagInlineSource) revertInlineSpan(span);
          return;
        }
        const cacheKey = `${rawName}|${font}|${pad}|${radius}`;
        if (span.dataset.waTagInlineSource === cacheKey) { processed++; return; }

        const styled = applyInlineMode(span, rawName);
        if (styled) { span.dataset.waTagInlineSource = cacheKey; processed++; }
      });

      if (DEBUG) console.log(`[wa-tag-badges] scan: ${spans.length} span[title], ${processed} procesadas`);
    }

    setInterval(scanAndRender, 700);

    // ---------------- Mount ----------------
    function mountCard(attemptsLeft) {
      attemptsLeft = attemptsLeft === undefined ? 10 : attemptsLeft;
      if (typeof core.registerMenu === 'function') {
        injectStyles();
        core.registerMenu('left', '🎨 Insignias de Contacto', wrap, '⠿', 'contact-tag-badges');
      } else if (attemptsLeft > 0) {
        setTimeout(() => mountCard(attemptsLeft - 1), 200);
      }
    }
    mountCard();

    core.emit('block:ready', { id: 'contactBadgeRendererPlugin' });
  }
});

/* ============================================================
   BLOCK: Dashboard Export (v3)
   ============================================================ */
/* ============================================================
   BLOCK 3: Contact Tag Dashboard, Export & Import (v3)
   ------------------------------------------------------------
   Standalone plugin -- reads the SAME "wa_tag_fields_v1" config
   as Blocks 1 and 2, fresh from localStorage on each action.

   v3 additions (on top of v2):
   3) "Importar CSV manual" -- lets you either paste CSV text
      directly into a textarea, or upload a .csv file from disk,
      and generates the same ready-to-copy tagged name strings
      as the Google Sheets import. Useful when the spreadsheet
      isn't public, or you just have a local export. Shares the
      exact same header-matching + results/copy UI as the
      Google Sheets import.

   v2 additions (unchanged):
   1) "Exportar a Excel (.xlsx)" -- a real Excel file, not just
      CSV. This needs the SheetJS library loaded globally as
      `XLSX`. Add this line to your Tampermonkey script's header
      metadata block (the // @... lines at the top):

        // @require https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js

      Without that line the button will alert you instead of
      silently failing.

   2) "Importar desde Google Sheets" -- paste a public Google
      Sheets share link (Anyone with the link can view) and this
      fetches it as CSV, matches its header row to your configured
      field LABELS (Nombre, Curso, Generación, ...), and shows a
      preview table of ready-to-paste tagged name strings -- one
      per spreadsheet row, each with its own Copy button, plus a
      "Copiar todo" for the whole batch. This does NOT rename
      WhatsApp contacts for you (no API for that) -- it only
      bulk-generates the strings so you're not retyping each
      student by hand.

      This needs Tampermonkey's GM_xmlhttpRequest (a plain
      fetch() gets blocked by Google's CORS policy from
      WhatsApp's page). Add these two lines to your script header:

        // @grant GM_xmlhttpRequest
        // @connect docs.google.com

   Everything else (scan all chats, table, sort/filter, CSV
   export, jump to chat) is unchanged from v1.
   ============================================================ */
LegoCore.registerBlock({
  id: 'contactTagDashboardPlugin',
  init(core) {
    // ---------------- SELECTORS -- ADJUST IF NEEDED ----------------
    const ROW_SELECTOR = '#pane-side div[role="listitem"]';
    const NAME_SELECTOR = 'span[title]';
    const SCROLL_CONTAINER_SELECTOR = '#pane-side [role="grid"], #pane-side';
    // -----------------------------------------------------------------

    const FIELDS_KEY = 'wa_tag_fields_v1';

    const DEFAULT_FIELDS = [
      { key: 'C', label: 'Curso', inputType: 'text', color: '#8ecae6' },
      { key: 'G', label: 'Generación', inputType: 'text', color: '#c792ea' },
      { key: 'V', label: 'Vence', inputType: 'date', color: '#ff9770' },
      { key: 'H', label: 'Hijo/Alumno', inputType: 'text', color: '#7ee787' },
      { key: 'E', label: 'Edad', inputType: 'number', color: '#f6c344' },
      { key: 'P', label: 'Precio', inputType: 'number', color: '#c9a876', thousands: true },
      { key: 'S', label: 'Pago', inputType: 'select', options: ['Pagado', 'Pendiente'], valueColors: { 'Pagado': '#7ee787', 'Pendiente': '#ff8fa3' } },
      { key: 'A', label: 'Activo', inputType: 'select', options: ['Activo', 'Inactivo'], valueColors: { 'Activo': '#7ee787', 'Inactivo': '#96949c' } },
      { key: 'F', label: 'Formulario', inputType: 'select', options: ['Sí', 'No'], valueColors: { 'Sí': '#7ee787', 'No': '#96949c' } }
    ];

    function getFields() {
      try {
        const f = JSON.parse(localStorage.getItem(FIELDS_KEY));
        if (Array.isArray(f) && f.length) return f;
      } catch (e) { /* ignore */ }
      return DEFAULT_FIELDS;
    }

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    // ---------------- Parsing (same format as Blocks 1 & 2) ----------------
    function parseFullName(raw) {
      const tagRe = /\[(\w+):([^\]]*)\]/g;
      const found = [];
      let m;
      while ((m = tagRe.exec(raw)) !== null) found.push({ key: m[1], value: m[2].trim() });
      const firstBracket = raw.indexOf('[');
      const baseName = (firstBracket === -1 ? raw : raw.slice(0, firstBracket)).trim();
      return { baseName, found };
    }

    function buildFullName(baseName, values, fields) {
      const parts = [];
      if (baseName && baseName.trim()) parts.push(baseName.trim());
      fields.forEach(f => {
        const v = values[f.key];
        if (v !== undefined && v !== null && String(v).trim() !== '') {
          parts.push(`[${f.key}:${String(v).trim()}]`);
        }
      });
      return parts.join(' ');
    }

    // ---------------- State ----------------
    let allContacts = [];   // [{ rawName, baseName, values: {key:value} }]
    let filtered = [];
    let sortState = { key: null, dir: 1 };
    let searchTerm = '';
    let quickFilters = {};  // { fieldKey: value }
    let importedRows = [];  // [{ baseName, values, generated }]

    // ---------------- Styles ----------------
    function injectStyles() {
      if (document.getElementById('wa-tag-dash-styles')) return;
      const style = document.createElement('style');
      style.id = 'wa-tag-dash-styles';
      style.innerHTML = `
        .wa-tag-dash-wrap { display:flex; flex-direction:column; gap:8px; font-family:-apple-system,sans-serif; font-size:11px; }
        .wa-tag-dash-btn { background:var(--igls-accent,#c9a876); color:#171208; border:none; border-radius:6px; padding:7px 10px; font-size:11px; font-weight:700; cursor:pointer; }
        .wa-tag-dash-btn:hover { filter:brightness(1.08); }
        .wa-tag-dash-btn-ghost { background:rgba(255,255,255,.06); color:var(--igls-text,#ece9e4); border:1px solid var(--igls-border,rgba(255,255,255,.08)); }
        .wa-tag-dash-row { display:flex; gap:6px; flex-wrap:wrap; }
        .wa-tag-dash-input, .wa-tag-dash-select { background:var(--igls-surface-2,#1c1c23); color:var(--igls-text,#ece9e4); border:1px solid var(--igls-border,rgba(255,255,255,.08)); border-radius:6px; padding:5px 7px; font-size:10.5px; outline:none; }
        .wa-tag-dash-textarea { background:var(--igls-surface-2,#1c1c23); color:var(--igls-text,#ece9e4); border:1px solid var(--igls-border,rgba(255,255,255,.08)); border-radius:6px; padding:6px 7px; font-size:10px; outline:none; font-family:monospace; resize:vertical; width:100%; box-sizing:border-box; }
        .wa-tag-dash-status { font-size:10px; color:var(--igls-text-dim,#96949c); }
        .wa-tag-dash-table-wrap { max-height:340px; overflow:auto; border:1px solid var(--igls-border,rgba(255,255,255,.08)); border-radius:6px; }
        .wa-tag-dash-table { width:100%; border-collapse:collapse; font-size:10.5px; }
        .wa-tag-dash-table th { position:sticky; top:0; background:var(--igls-surface-2,#1c1c23); color:var(--igls-text-dim,#96949c); text-align:left; padding:6px 8px; cursor:pointer; white-space:nowrap; border-bottom:1px solid var(--igls-border,rgba(255,255,255,.08)); }
        .wa-tag-dash-table th:hover { color:var(--igls-accent,#c9a876); }
        .wa-tag-dash-table td { padding:5px 8px; border-bottom:1px solid rgba(255,255,255,.04); color:var(--igls-text,#ece9e4); white-space:nowrap; }
        .wa-tag-dash-table tr.wa-tag-dash-clickable:hover { background:rgba(255,255,255,.05); cursor:pointer; }
        .wa-tag-dash-empty { padding:16px; text-align:center; color:var(--igls-text-dim,#96949c); }
        .wa-tag-dash-divider { border-top:1px solid var(--igls-border,rgba(255,255,255,.08)); margin-top:4px; padding-top:8px; }
        .wa-tag-dash-import-row { display:flex; flex-direction:column; gap:5px; background:rgba(255,255,255,.03); border:1px solid var(--igls-border,rgba(255,255,255,.06)); border-radius:6px; padding:6px; font-size:10px; }
        .wa-tag-dash-import-generated { font-family:monospace; font-size:9.5px; word-break:break-word; flex:1; }
        .wa-tag-dash-import-copybtn { flex-shrink:0; }
        .wa-tag-dash-subtabs { display:flex; gap:4px; margin-bottom:6px; }
        .wa-tag-dash-subtab { flex:1; text-align:center; padding:5px 6px; border-radius:6px; font-size:10px; font-weight:700; cursor:pointer; background:rgba(255,255,255,.04); color:var(--igls-text-dim,#96949c); border:1px solid var(--igls-border,rgba(255,255,255,.06)); }
        .wa-tag-dash-subtab.active { background:var(--igls-accent,#c9a876); color:#171208; }
        .wa-tag-dash-subpanel { display:none; flex-direction:column; gap:6px; }
        .wa-tag-dash-subpanel.active { display:flex; }
      `;
      document.head.appendChild(style);
    }

    // ---------------- Sidebar card shell ----------------
    const wrap = document.createElement('div');
    wrap.className = 'wa-tag-dash-wrap';
    wrap.innerHTML = `
      <div class="wa-tag-dash-row">
        <button id="wa-tag-dash-scan-btn" class="wa-tag-dash-btn">🔄 Escanear todos los chats</button>
      </div>
      <div class="wa-tag-dash-status" id="wa-tag-dash-status">Sin escanear todavía.</div>
      <div class="wa-tag-dash-row">
        <input type="text" id="wa-tag-dash-search" class="wa-tag-dash-input" placeholder="Buscar..." style="flex:1;">
      </div>
      <div class="wa-tag-dash-row" id="wa-tag-dash-quickfilters"></div>
      <div class="wa-tag-dash-table-wrap">
        <table class="wa-tag-dash-table">
          <thead id="wa-tag-dash-thead"></thead>
          <tbody id="wa-tag-dash-tbody"></tbody>
        </table>
      </div>
      <div class="wa-tag-dash-row">
        <button id="wa-tag-dash-export-csv-btn" class="wa-tag-dash-btn wa-tag-dash-btn-ghost">⬇️ Exportar CSV</button>
        <button id="wa-tag-dash-export-xlsx-btn" class="wa-tag-dash-btn wa-tag-dash-btn-ghost">⬇️ Exportar Excel (.xlsx)</button>
      </div>

      <div class="wa-tag-dash-divider">
        <label class="wa-tag-dash-status" style="display:block; margin-bottom:6px;">Importar datos (genera nombres etiquetados para copiar)</label>

        <div class="wa-tag-dash-subtabs">
          <div class="wa-tag-dash-subtab active" data-subtab="sheets">Google Sheets</div>
          <div class="wa-tag-dash-subtab" data-subtab="csv">CSV manual</div>
        </div>

        <div class="wa-tag-dash-subpanel active" id="wa-tag-dash-subpanel-sheets">
          <div class="wa-tag-dash-row">
            <input type="text" id="wa-tag-dash-sheet-url" class="wa-tag-dash-input" placeholder="https://docs.google.com/spreadsheets/d/..." style="flex:1;">
            <button id="wa-tag-dash-sheet-fetch-btn" class="wa-tag-dash-btn">Importar</button>
          </div>
        </div>

        <div class="wa-tag-dash-subpanel" id="wa-tag-dash-subpanel-csv">
          <div class="wa-tag-dash-row">
            <input type="file" id="wa-tag-dash-csv-file" accept=".csv,text/csv" style="flex:1; font-size:10px;">
          </div>
          <textarea id="wa-tag-dash-csv-paste" class="wa-tag-dash-textarea" rows="4" placeholder="...o pega aquí el contenido CSV (primera fila = encabezados: Nombre, Curso, Generación, ...)"></textarea>
          <div class="wa-tag-dash-row">
            <button id="wa-tag-dash-csv-import-btn" class="wa-tag-dash-btn">Importar CSV</button>
          </div>
        </div>

        <div class="wa-tag-dash-status" id="wa-tag-dash-import-status" style="margin-top:6px;">El encabezado debe usar las mismas etiquetas de tus campos (Nombre, Curso, Generación...).</div>
        <div id="wa-tag-dash-import-results" style="display:flex; flex-direction:column; gap:5px; margin-top:6px; max-height:240px; overflow:auto;"></div>
        <div class="wa-tag-dash-row" id="wa-tag-dash-import-copyall-row" style="display:none; margin-top:4px;">
          <button id="wa-tag-dash-import-copyall-btn" class="wa-tag-dash-btn wa-tag-dash-btn-ghost">📋 Copiar todos los nombres generados</button>
        </div>
      </div>
    `;

    const statusEl = () => wrap.querySelector('#wa-tag-dash-status');
    const importStatusEl = () => wrap.querySelector('#wa-tag-dash-import-status');

    // ---------------- Import sub-tabs (Google Sheets / CSV manual) ----------------
    wrap.querySelectorAll('.wa-tag-dash-subtab').forEach(tab => {
      tab.onclick = () => {
        wrap.querySelectorAll('.wa-tag-dash-subtab').forEach(t => t.classList.remove('active'));
        wrap.querySelectorAll('.wa-tag-dash-subpanel').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        wrap.querySelector(`#wa-tag-dash-subpanel-${tab.dataset.subtab}`).classList.add('active');
      };
    });

    // ---------------- Scan (auto-scroll + collect) ----------------
    async function collectAllTaggedContacts() {
      const scrollContainer = document.querySelector(SCROLL_CONTAINER_SELECTOR);
      if (!scrollContainer) return [];

      const collected = new Map();
      scrollContainer.scrollTop = 0;
      await sleep(200);

      let lastScrollTop = -1;
      let stableRounds = 0;
      let safetyCounter = 0;

      while (stableRounds < 3 && safetyCounter < 400) {
        document.querySelectorAll(ROW_SELECTOR).forEach(row => {
          const nameEl = row.querySelector(NAME_SELECTOR);
          if (!nameEl) return;
          const rawName = nameEl.getAttribute('title') || nameEl.textContent || '';
          if (rawName.includes('[') && !collected.has(rawName)) {
            collected.set(rawName, parseFullName(rawName));
          }
        });

        scrollContainer.scrollTop += Math.max(scrollContainer.clientHeight * 0.8, 200);
        await sleep(220);

        if (scrollContainer.scrollTop === lastScrollTop) stableRounds++;
        else stableRounds = 0;
        lastScrollTop = scrollContainer.scrollTop;
        safetyCounter++;
      }

      scrollContainer.scrollTop = 0;

      return Array.from(collected.entries()).map(([rawName, parsed]) => ({
        rawName,
        baseName: parsed.baseName,
        values: parsed.found.reduce((acc, t) => { acc[t.key] = t.value; return acc; }, {})
      }));
    }

    wrap.querySelector('#wa-tag-dash-scan-btn').onclick = async () => {
      const btn = wrap.querySelector('#wa-tag-dash-scan-btn');
      btn.disabled = true;
      btn.textContent = '⏳ Escaneando...';
      statusEl().textContent = 'Recorriendo la lista de chats, no la desplaces manualmente...';
      try {
        allContacts = await collectAllTaggedContacts();
        applyFiltersAndRender();
      } finally {
        btn.disabled = false;
        btn.textContent = '🔄 Escanear todos los chats';
      }
    };

    // ---------------- Filtering / sorting ----------------
    function applyFiltersAndRender() {
      const fields = getFields();
      let rows = allContacts;

      if (searchTerm.trim()) {
        const term = searchTerm.trim().toLowerCase();
        rows = rows.filter(c => {
          if ((c.baseName || '').toLowerCase().includes(term)) return true;
          return Object.values(c.values).some(v => (v || '').toLowerCase().includes(term));
        });
      }

      Object.keys(quickFilters).forEach(key => {
        const val = quickFilters[key];
        if (val) rows = rows.filter(c => c.values[key] === val);
      });

      if (sortState.key) {
        const field = fields.find(f => f.key === sortState.key);
        rows = rows.slice().sort((a, b) => {
          const av = sortState.key === '__base__' ? (a.baseName || '') : (a.values[sortState.key] || '');
          const bv = sortState.key === '__base__' ? (b.baseName || '') : (b.values[sortState.key] || '');
          let cmp;
          if (field && field.inputType === 'number') cmp = (parseFloat(av) || 0) - (parseFloat(bv) || 0);
          else if (field && field.inputType === 'date') cmp = new Date(av) - new Date(bv);
          else cmp = String(av).localeCompare(String(bv));
          return cmp * sortState.dir;
        });
      }

      filtered = rows;
      renderQuickFilters(fields);
      renderTable(fields);
      statusEl().textContent = `${allContacts.length} contactos etiquetados encontrados · mostrando ${filtered.length}`;
    }

    function renderQuickFilters(fields) {
      const container = wrap.querySelector('#wa-tag-dash-quickfilters');
      container.innerHTML = '';
      fields.filter(f => f.inputType === 'select').forEach(f => {
        const sel = document.createElement('select');
        sel.className = 'wa-tag-dash-select';
        sel.innerHTML = `<option value="">${f.label}: todos</option>` +
          (f.options || []).map(o => `<option value="${o}" ${quickFilters[f.key] === o ? 'selected' : ''}>${o}</option>`).join('');
        sel.onchange = () => { quickFilters[f.key] = sel.value; applyFiltersAndRender(); };
        container.appendChild(sel);
      });
    }

    function renderTable(fields) {
      const thead = wrap.querySelector('#wa-tag-dash-thead');
      const tbody = wrap.querySelector('#wa-tag-dash-tbody');

      const sortArrow = key => sortState.key === key ? (sortState.dir === 1 ? ' ▲' : ' ▼') : '';
      thead.innerHTML = `<tr>
        <th data-sort-key="__base__">Nombre${sortArrow('__base__')}</th>
        ${fields.map(f => `<th data-sort-key="${f.key}">${f.label}${sortArrow(f.key)}</th>`).join('')}
      </tr>`;
      thead.querySelectorAll('th').forEach(th => {
        th.onclick = () => {
          const key = th.dataset.sortKey;
          if (sortState.key === key) sortState.dir *= -1;
          else { sortState.key = key; sortState.dir = 1; }
          applyFiltersAndRender();
        };
      });

      tbody.innerHTML = '';
      if (!filtered.length) {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td colspan="${fields.length + 1}" class="wa-tag-dash-empty">Sin resultados. Ejecuta un escaneo o ajusta los filtros.</td>`;
        tbody.appendChild(tr);
        return;
      }
      filtered.forEach(c => {
        const tr = document.createElement('tr');
        tr.className = 'wa-tag-dash-clickable';
        tr.innerHTML = `<td>${c.baseName || ''}</td>` + fields.map(f => `<td>${c.values[f.key] || ''}</td>`).join('');
        tr.onclick = () => jumpToChat(c.rawName);
        tbody.appendChild(tr);
      });
    }

    wrap.querySelector('#wa-tag-dash-search').addEventListener('input', e => {
      searchTerm = e.target.value;
      applyFiltersAndRender();
    });

    // ---------------- Jump to chat ----------------
    function findRowByRawName(rawName) {
      const rows = document.querySelectorAll(ROW_SELECTOR);
      for (const row of rows) {
        const nameEl = row.querySelector(NAME_SELECTOR);
        if (nameEl && (nameEl.getAttribute('title') || nameEl.textContent) === rawName) return row;
      }
      return null;
    }

    async function jumpToChat(rawName) {
      let target = findRowByRawName(rawName);
      if (target) { target.click(); return; }

      const scrollContainer = document.querySelector(SCROLL_CONTAINER_SELECTOR);
      if (!scrollContainer) { alert('No se encontró la lista de chats.'); return; }
      scrollContainer.scrollTop = 0;
      let attempts = 0;
      while (!target && attempts < 80) {
        target = findRowByRawName(rawName);
        if (target) break;
        scrollContainer.scrollTop += Math.max(scrollContainer.clientHeight * 0.8, 200);
        await sleep(150);
        attempts++;
      }
      if (target) target.click();
      else alert('No se encontró el chat (puede haberse renombrado, archivado o eliminado).');
    }

    // ---------------- CSV export ----------------
    function toCsvValue(v) {
      const s = String(v == null ? '' : v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }

    wrap.querySelector('#wa-tag-dash-export-csv-btn').onclick = () => {
      if (!filtered.length) { alert('No hay contactos para exportar. Escanea primero.'); return; }
      const fields = getFields();
      const header = ['Nombre', ...fields.map(f => f.label)];
      const lines = [header.map(toCsvValue).join(',')];
      filtered.forEach(c => {
        const row = [c.baseName || '', ...fields.map(f => c.values[f.key] || '')];
        lines.push(row.map(toCsvValue).join(','));
      });
      const csv = lines.join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `contactos_etiquetados_${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    };

    // ---------------- Excel (.xlsx) export ----------------
    wrap.querySelector('#wa-tag-dash-export-xlsx-btn').onclick = () => {
      if (typeof XLSX === 'undefined') {
        alert('Falta la librería XLSX. Agrega esta línea al encabezado de tu script de Tampermonkey:\n\n// @require https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js\n\nLuego recarga WhatsApp Web.');
        return;
      }
      if (!filtered.length) { alert('No hay contactos para exportar. Escanea primero.'); return; }
      const fields = getFields();
      const rows = filtered.map(c => {
        const row = { Nombre: c.baseName || '' };
        fields.forEach(f => { row[f.label] = c.values[f.key] || ''; });
        return row;
      });
      const ws = XLSX.utils.json_to_sheet(rows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Contactos');
      XLSX.writeFile(wb, `contactos_etiquetados_${new Date().toISOString().slice(0, 10)}.xlsx`);
    };

    // ---------------- Shared CSV parsing ----------------
    function parseCsv(text) {
      const rows = [];
      let row = [], field = '', inQuotes = false;
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
      return rows.filter(r => r.some(cell => cell.trim() !== ''));
    }

    // Shared by BOTH the Google Sheets import and the manual CSV import.
    // Takes raw CSV text, matches header row to configured field labels,
    // fills importedRows + renders the results/copy UI. Returns true on success.
    function processImportedCsvText(csvText, sourceLabel) {
      const resultsEl = wrap.querySelector('#wa-tag-dash-import-results');
      const copyAllRow = wrap.querySelector('#wa-tag-dash-import-copyall-row');
      resultsEl.innerHTML = '';
      copyAllRow.style.display = 'none';
      importedRows = [];

      const rows = parseCsv(csvText);
      if (rows.length < 2) { importStatusEl().textContent = `${sourceLabel}: no se encontraron filas de datos.`; return false; }

      const header = rows[0].map(h => h.trim().toLowerCase());
      const fields = getFields();
      const nameColIdx = header.findIndex(h => h === 'nombre' || h === 'name');
      if (nameColIdx === -1) {
        importStatusEl().textContent = `${sourceLabel}: falta una columna "Nombre".`;
        return false;
      }
      const fieldColIdx = {};
      fields.forEach(f => {
        const idx = header.findIndex(h => h === f.label.trim().toLowerCase());
        if (idx !== -1) fieldColIdx[f.key] = idx;
      });

      for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        const baseName = (r[nameColIdx] || '').trim();
        if (!baseName) continue;
        const values = {};
        fields.forEach(f => {
          if (fieldColIdx[f.key] !== undefined) {
            const v = (r[fieldColIdx[f.key]] || '').trim();
            if (v) values[f.key] = v;
          }
        });
        const generated = buildFullName(baseName, values, fields);
        importedRows.push({ baseName, values, generated });
      }

      if (!importedRows.length) {
        importStatusEl().textContent = `${sourceLabel}: no se encontraron filas válidas (revisa la columna Nombre).`;
        return false;
      }

      importStatusEl().textContent = `${sourceLabel}: ${importedRows.length} filas listas. Copia cada nombre generado y pégalo en el contacto correspondiente en tu teléfono.`;
      renderImportResults();
      copyAllRow.style.display = '';
      return true;
    }

    // ---------------- Google Sheets import (bulk name generator) ----------------
    function extractSheetExportUrl(shareUrl) {
      const idMatch = shareUrl.match(/\/d\/([a-zA-Z0-9-_]+)/);
      if (!idMatch) return null;
      const id = idMatch[1];
      const gidMatch = shareUrl.match(/gid=([0-9]+)/);
      const gid = gidMatch ? gidMatch[1] : '0';
      return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
    }

    function fetchGoogleSheetCsv(url) {
      return new Promise((resolve, reject) => {
        if (typeof GM_xmlhttpRequest === 'undefined') {
          reject(new Error('Falta GM_xmlhttpRequest. Agrega // @grant GM_xmlhttpRequest y // @connect docs.google.com al encabezado del script.'));
          return;
        }
        GM_xmlhttpRequest({
          method: 'GET',
          url,
          onload: res => {
            if (res.status >= 200 && res.status < 300) resolve(res.responseText);
            else reject(new Error('Error al descargar la hoja (código ' + res.status + '). ¿Está compartida como "cualquiera con el link puede ver"?'));
          },
          onerror: () => reject(new Error('Error de red al descargar la hoja.'))
        });
      });
    }

    wrap.querySelector('#wa-tag-dash-sheet-fetch-btn').onclick = async () => {
      const url = wrap.querySelector('#wa-tag-dash-sheet-url').value.trim();
      if (!url) { importStatusEl().textContent = 'Pega primero un link de Google Sheets.'; return; }
      const exportUrl = extractSheetExportUrl(url);
      if (!exportUrl) { importStatusEl().textContent = 'No se pudo leer el ID de la hoja en ese link.'; return; }

      importStatusEl().textContent = 'Descargando hoja...';
      let csvText;
      try {
        csvText = await fetchGoogleSheetCsv(exportUrl);
      } catch (err) {
        importStatusEl().textContent = err.message;
        return;
      }

      processImportedCsvText(csvText, 'Google Sheets');
    };

    // ---------------- Manual CSV import (upload file or paste text) ----------------
    function readFileAsText(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('No se pudo leer el archivo.'));
        reader.readAsText(file, 'utf-8');
      });
    }

    // Uploading a file auto-fills the paste box (handy to double check) but
    // does NOT auto-import -- the user still clicks "Importar CSV".
    wrap.querySelector('#wa-tag-dash-csv-file').addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        const text = await readFileAsText(file);
        wrap.querySelector('#wa-tag-dash-csv-paste').value = text;
        importStatusEl().textContent = `Archivo "${file.name}" cargado. Revisa el texto y presiona "Importar CSV".`;
      } catch (err) {
        importStatusEl().textContent = err.message;
      }
    });

    wrap.querySelector('#wa-tag-dash-csv-import-btn').onclick = () => {
      const csvText = wrap.querySelector('#wa-tag-dash-csv-paste').value;
      if (!csvText || !csvText.trim()) {
        importStatusEl().textContent = 'Sube un archivo .csv o pega el contenido CSV primero.';
        return;
      }
      processImportedCsvText(csvText, 'CSV manual');
    };

    // ---------------- Import results rendering (shared) ----------------
    function renderImportResults() {
      const resultsEl = wrap.querySelector('#wa-tag-dash-import-results');
      resultsEl.innerHTML = '';
      importedRows.forEach((row, idx) => {
        const item = document.createElement('div');
        item.className = 'wa-tag-dash-import-row';
        item.innerHTML = `
          <div class="wa-tag-dash-import-generated">${row.generated}</div>
          <button class="wa-tag-dash-btn wa-tag-dash-btn-ghost wa-tag-dash-import-copybtn" data-idx="${idx}">📋 Copiar</button>
        `;
        resultsEl.appendChild(item);
      });
      resultsEl.querySelectorAll('.wa-tag-dash-import-copybtn').forEach(btn => {
        btn.onclick = () => {
          const text = importedRows[Number(btn.dataset.idx)].generated;
          copyText(text, () => { btn.textContent = '✅ Copiado'; setTimeout(() => { btn.textContent = '📋 Copiar'; }, 1000); });
        };
      });
    }

    wrap.querySelector('#wa-tag-dash-import-copyall-btn').onclick = () => {
      const text = importedRows.map(r => r.generated).join('\n');
      copyText(text, () => {
        const btn = wrap.querySelector('#wa-tag-dash-import-copyall-btn');
        const original = btn.textContent;
        btn.textContent = '✅ Copiado';
        setTimeout(() => { btn.textContent = original; }, 1200);
      });
    };

    function copyText(text, cb) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(cb).catch(() => fallbackCopy(text, cb));
      } else {
        fallbackCopy(text, cb);
      }
    }
    function fallbackCopy(text, cb) {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); cb(); } catch (e) { /* ignore */ }
      document.body.removeChild(ta);
    }

    // ---------------- Mount ----------------
    function mountCard(attemptsLeft) {
      attemptsLeft = attemptsLeft === undefined ? 10 : attemptsLeft;
      if (typeof core.registerMenu === 'function') {
        injectStyles();
        core.registerMenu('left', '📊 Panel de Contactos', wrap, '⠿', 'contact-tag-dashboard');
        applyFiltersAndRender();
      } else if (attemptsLeft > 0) {
        setTimeout(() => mountCard(attemptsLeft - 1), 200);
      }
    }
    mountCard();

    core.emit('block:ready', { id: 'contactTagDashboardPlugin' });
  }
});

  LegoCore.boot();
})();
