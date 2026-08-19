// ==UserScript==
// @name         HomeBase AutoVault
// @namespace    https://github.com/ZerocuCodes
// @version      1.0.0
// @description  Automatically vaults a percentage of your profits on degen.com into the site's built-in vault
// @author       Zerocu
// @license      MIT
// @homepageURL  https://github.com/ZerocuCodes/Homebase-AutoVault-for-Degen.com
// @supportURL   https://github.com/ZerocuCodes/Homebase-AutoVault-for-Degen.com/issues
// @updateURL    https://raw.githubusercontent.com/ZerocuCodes/Homebase-AutoVault-for-Degen.com/main/degenautovault.user.js
// @downloadURL  https://raw.githubusercontent.com/ZerocuCodes/Homebase-AutoVault-for-Degen.com/main/degenautovault.user.js
// @match        https://degen.com/*
// @match        https://*.degen.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=degen.com
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // --- Config ---
    const INIT_DELAY = 2000;
    const RATE_LIMIT_MAX = 50;
    const RATE_LIMIT_WINDOW = 60 * 60 * 1000; // 1 hour
    const API_BASE = 'https://api.degen.com/v1';
    const TRACKED_ASSET_KEY = 'degenvault-tracked-asset';

    function loadConfig() {
        const saved = localStorage.getItem('degenvault-config');
        if (saved) {
            try {
                return JSON.parse(saved);
            } catch (e) {
                log('Failed to load saved config:', e);
            }
        }
        return {
            saveAmount: 0.1,
            bigWinThreshold: 5,
            bigWinMultiplier: 3,
            checkInterval: 90000
        };
    }

    function saveConfig(config) {
        localStorage.setItem('degenvault-config', JSON.stringify(config));
    }


    function loadTrackedAsset() {
        return localStorage.getItem(TRACKED_ASSET_KEY) || null;
    }
    function saveTrackedAsset(asset) {
        localStorage.setItem(TRACKED_ASSET_KEY, asset);
    }

    let config = loadConfig();
    let ASSET = loadTrackedAsset();
    let SAVE_AMOUNT = config.saveAmount;
    let BIG_WIN_THRESHOLD = config.bigWinThreshold;
    let BIG_WIN_MULTIPLIER = config.bigWinMultiplier;
    let CHECK_INTERVAL = config.checkInterval;

    let isScriptInitialized = false;

    // --- Activity Log ---
    const activityLog = [];
    const MAX_LOG_ENTRIES = 50;
    let onLogUpdate = null;

    function logActivity(message, type = 'info') {
        const entry = {
            time: new Date(),
            message,
            type // 'info', 'success', 'warning', 'profit', 'bigwin', 'error'
        };
        activityLog.unshift(entry);
        if (activityLog.length > MAX_LOG_ENTRIES) activityLog.pop();
        console.log('[DegenVault]', message);
        if (onLogUpdate) onLogUpdate(entry);
    }
    const log = (...args) => logActivity(args.join(' '), 'info');

    // --- Flavor Text (Degen-themed) ---
    const FLAVOR = {
        profit: [
            "Profit spotted, ape'd it to the vault",
            "Green candle, stacking the bag"
        ],
        bigWin: [
            "Big W detected, diamond-handing this one",
            "Massive candle, locking in the bag"
        ],
        deposit: [
            "Deposit detected",
        ],
        start: [
            "DegenVault online, no paper hands here",
            "Watching the wallet, ready to ape profits into the vault"
        ],
        stop: [
            "DegenVault paused",
            "Monitoring stopped"
        ],
        rateLimit: [
            "Rate limited, vaulting paused. Chill until it resets",
            "Limit reached, vaulting paused. Touch grass until it resets"
        ]
    };
    const pickFlavor = (arr) => arr[Math.floor(Math.random() * arr.length)];

    // --- Degen API ---
    class DegenApi {
        constructor() {
            this.apiBase = API_BASE;
        }
        async _fetch(path, opts) {
            try {
                const res = await fetch(this.apiBase + path, {
                    credentials: 'include',
                    headers: { 'content-type': 'application/json' },
                    mode: 'cors',
                    cache: 'no-cache',
                    ...opts
                });
                const rateRemaining = res.headers.get('x-ratelimit-remaining');
                const rateReset = res.headers.get('x-ratelimit-reset');
                if (rateRemaining !== null) {
                    apiRateInfo.remaining = parseInt(rateRemaining, 10);
                    apiRateInfo.resetMs = parseInt(rateReset, 10) || 0;
                }
                if (!res.ok) {
                    log(`API call failed with status ${res.status}: ${res.statusText}`);
                    return { error: true, status: res.status, message: res.statusText };
                }
                if (res.status === 204) return {};
                return res.json();
            } catch (e) {
                log('API call failed:', e.message);
                return { error: true, message: e.message, type: 'network' };
            }
        }
        async getVaults() {
            return this._fetch('/balance/vaults', { method: 'GET' });
        }
        // Read-only: every asset's wallet balance plus which one is primary.
        async getWallets() {
            return this._fetch('/balance/wallets', { method: 'GET' });
        }
        async depositToVault(asset, amount) {
            const body = JSON.stringify({
                operationId: crypto.randomUUID(),
                asset,
                amount: String(amount)
            });
            return this._fetch('/balance/vault/deposit', { method: 'POST', body });
        }
        // Read-only: the current account's profile — source of the user id the
        // statistics endpoints are keyed by.
        async getProfile() {
            return this._fetch('/users/profile', { method: 'GET' });
        }
        // Read-only: public user object; .statistics.wagered is Degen's
        // server-side lifetime USD-equivalent wagered counter.
        async getPublicUser(id) {
            return this._fetch(`/users/public/${encodeURIComponent(id)}`, { method: 'GET' });
        }
        async getUserStats(id) {
            return this._fetch(`/users/${encodeURIComponent(id)}/stats`, { method: 'GET' });
        }
    }

    let apiRateInfo = { remaining: null, resetMs: null };


    function setTrackedAsset(asset) {
        if (!asset) return;
        const upper = asset.toUpperCase();
        if (upper === ASSET) return;
        const first = !ASSET;
        ASSET = upper;
        saveTrackedAsset(ASSET);
        if (uiWidget) uiWidget.updateTrackedAsset(ASSET);
        if (vaultDisplay) vaultDisplay.setAsset(ASSET);
        logActivity(first ? `📡 Detected active currency: ${ASSET}` : `💱 Currency on Degen switched — now tracking ${ASSET}`, 'info');
        if (running) isInitialized = false;
        refreshApiVaultBalance();
    }

    // --- Vault Display UI (floaty) ---
    class VaultDisplay {
        constructor() {
            this._el = document.createElement("span");
            this._vaulted = 0;
            this._apiVaultBalance = 0;
            this._asset = ASSET;
            this._load();
            this.render();
        }
        _storageKey() {
            return `degenvault-vaulted-session:${(this._asset || '').toUpperCase()}`;
        }
        _load() {
            try {
                const raw = sessionStorage.getItem(this._storageKey());
                const v = parseFloat(raw);
                if (!isNaN(v) && v >= 0) this._vaulted = v;
            } catch (e) {}
        }
        _save() {
            try {
                sessionStorage.setItem(this._storageKey(), String(this._vaulted));
            } catch (e) {}
        }
        setAsset(asset) {
            this._asset = (asset || ASSET || '').toUpperCase();
            this._load();
            this.render();
        }
        setApiVaultBalance(amount) {
            const n = parseFloat(amount);
            if (!isNaN(n)) this._apiVaultBalance = n;
            this.render();
        }
        render() {
            if (!this._el) return;
            this._el.innerText = (this._apiVaultBalance || this._vaulted || 0).toFixed(8);
        }
        update(amount) {
            const add = +amount;
            if (isNaN(add) || add <= 0) return;
            this._vaulted = (this._vaulted || 0) + add;
            this._save();
            this.render();
        }
        reset() {
            this._vaulted = 0;
            this._save();
            this.render();
        }
    }

    // --- Rate Limit Tracking (client-side, in addition to API headers) ---
    function loadRateLimitData() {
        const saved = sessionStorage.getItem('degenvault-ratelimit');
        if (saved) {
            try {
                const data = JSON.parse(saved);
                return data.filter(ts => Date.now() - ts < RATE_LIMIT_WINDOW);
            } catch (e) {
                log('Failed to load rate limit data:', e);
            }
        }
        return [];
    }

    function saveRateLimitData(timestamps) {
        sessionStorage.setItem('degenvault-ratelimit', JSON.stringify(timestamps));
    }

    let vaultActionTimestamps = loadRateLimitData();

    function canVaultNow() {
        const now = Date.now();
        vaultActionTimestamps = vaultActionTimestamps.filter(ts => now - ts < RATE_LIMIT_WINDOW);
        saveRateLimitData(vaultActionTimestamps);
        if (apiRateInfo.remaining !== null && apiRateInfo.remaining <= 1) return false;
        return vaultActionTimestamps.length < RATE_LIMIT_MAX;
    }

    function getVaultCountLastHour() {
        const now = Date.now();
        vaultActionTimestamps = vaultActionTimestamps.filter(ts => now - ts < RATE_LIMIT_WINDOW);
        return vaultActionTimestamps.length;
    }

    function initHelpTooltips(widget) {
        let tooltipEl = document.getElementById('degenvault-tooltip');
        if (!tooltipEl) {
            tooltipEl = document.createElement('div');
            tooltipEl.id = 'degenvault-tooltip';
            document.body.appendChild(tooltipEl);
        }

        function positionTooltip(anchor) {
            const r = anchor.getBoundingClientRect();
            tooltipEl.style.left = '0px';
            tooltipEl.style.top = '0px';
            const tw = tooltipEl.offsetWidth;
            const th = tooltipEl.offsetHeight;
            let left = r.right - tw;
            let top = r.top - th - 8;
            if (top < 4) top = r.bottom + 8;
            if (left < 4) left = 4;
            if (left + tw > window.innerWidth - 4) left = window.innerWidth - tw - 4;
            tooltipEl.style.left = `${left}px`;
            tooltipEl.style.top = `${top}px`;
        }

        widget.querySelectorAll('.dv-help').forEach(el => {
            el.addEventListener('mouseenter', () => {
                tooltipEl.textContent = el.getAttribute('data-tip') || '';
                tooltipEl.classList.add('visible');
                positionTooltip(el);
            });
            el.addEventListener('mouseleave', () => {
                tooltipEl.classList.remove('visible');
            });
        });
    }

    // --- Floaty UI Widget ---
    let currentViewMode = 'full';

    function createVaultFloatyUI(startCallback, stopCallback, getParams, setParams, vaultDisplay, syncCallback, fetchWalletsCallback, manualVaultCallback) {
        if (document.getElementById('degenvault-floaty')) document.getElementById('degenvault-floaty').remove();
        if (document.getElementById('degenvault-stealth')) document.getElementById('degenvault-stealth').remove();

        const style = document.createElement('style');
        style.id = 'degenvault-styles';
        style.textContent = `
        #degenvault-floaty {
            --hb-bg: #000000;
            --hb-panel: #060907;
            --hb-panel-2: #0b100c;
            --hb-border: #163019;
            --hb-accent: #00FF41;
            --hb-accent-dark: #00b82e;
            --hb-text: #cdf5cf;
            --hb-text-dim: #5f8a63;
            background: var(--hb-bg);
            color: var(--hb-text);
            border: 1px solid var(--hb-border);
            border-radius: 4px;
            box-shadow: 0 4px 28px rgba(0,0,0,0.6), 0 0 22px rgba(0,255,65,0.08);
            font-family: 'Segoe UI', Arial, sans-serif;
            font-size: 13px;
            min-width: 250px;
            max-width: 290px;
            user-select: none;
            position: fixed;
            top: 80px;
            right: 20px;
            z-index: 999999;
            display: flex;
            flex-direction: column;
            clip-path: polygon(0 10px, 10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%);
        }
        #degenvault-floaty.hidden { display: none; }
        #degenvault-floaty .dv-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            background: var(--hb-panel-2);
            padding: 9px 10px;
            border-bottom: 1px solid var(--hb-border);
            cursor: grab;
        }
        #degenvault-floaty .dv-header:active { cursor: grabbing; }
        #degenvault-floaty .dv-title {
            display: flex;
            align-items: center;
            gap: 7px;
            font-weight: 800;
            font-size: 12px;
            color: var(--hb-accent);
            letter-spacing: 1.5px;
            text-transform: uppercase;
            text-shadow: 0 0 8px rgba(0,255,65,0.5);
        }
        #degenvault-floaty .dv-title .dv-hb-badge {
            background: var(--hb-accent);
            color: #000;
            font-weight: 900;
            font-size: 10px;
            padding: 1px 5px;
            letter-spacing: 0.5px;
            clip-path: polygon(0 4px, 4px 0, 100% 0, 100% 100%, calc(100% - 4px) 100%, 0 100%);
        }
        #degenvault-floaty .dv-status-dot {
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background: #4a5568;
        }
        #degenvault-floaty .dv-status-dot.running {
            background: var(--hb-accent);
            box-shadow: 0 0 6px var(--hb-accent);
        }
        #degenvault-floaty .dv-header-btns { display: flex; gap: 2px; }
        #degenvault-floaty .dv-header-btn {
            background: none;
            border: none;
            color: var(--hb-text-dim);
            cursor: pointer;
            padding: 4px;
            border-radius: 4px;
            font-size: 14px;
            line-height: 1;
        }
        #degenvault-floaty .dv-header-btn:hover { color: #fff; background: var(--hb-border); }
        #degenvault-floaty .dv-content { padding: 12px; display: flex; flex-direction: column; gap: 10px; }
        #degenvault-floaty .dv-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
        #degenvault-floaty .dv-label { color: var(--hb-text-dim); font-size: 12px; }
        #degenvault-floaty .dv-label-group { display: flex; align-items: center; gap: 5px; }
        #degenvault-floaty .dv-inline-group { display: flex; align-items: center; gap: 6px; }
        #degenvault-floaty .dv-sync-btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 16px;
            height: 16px;
            border-radius: 50%;
            border: 1px solid var(--hb-border);
            background: transparent;
            color: var(--hb-text-dim);
            font-size: 11px;
            line-height: 1;
            cursor: pointer;
            padding: 0;
            flex-shrink: 0;
        }
        #degenvault-floaty .dv-sync-btn:hover { color: var(--hb-accent); border-color: var(--hb-accent); }
        #degenvault-floaty .dv-sync-btn.spinning { animation: dv-spin 0.6s linear; }
        @keyframes dv-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        #degenvault-floaty input[type="number"], #degenvault-floaty input[type="text"] {
            background: var(--hb-panel-2);
            color: #eaffe0;
            border: 1px solid var(--hb-border);
            border-radius: 4px;
            padding: 4px 6px;
            font-size: 12px;
            width: 70px;
            text-align: right;
        }
        #degenvault-floaty input:focus { outline: none; border-color: var(--hb-accent); }
        #degenvault-floaty select {
            background: var(--hb-panel-2);
            color: #eaffe0;
            border: 1px solid var(--hb-border);
            border-radius: 4px;
            padding: 4px 6px;
            font-size: 12px;
            min-width: 90px;
        }
        #degenvault-floaty select:focus { outline: none; border-color: var(--hb-accent); }
        #degenvault-floaty .dv-tabs { display: flex; gap: 4px; }
        #degenvault-floaty .dv-tab {
            flex: 1;
            background: transparent;
            border: 1px solid var(--hb-border);
            border-radius: 3px;
            color: var(--hb-text-dim);
            padding: 5px 8px;
            font-size: 10px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            cursor: pointer;
        }
        #degenvault-floaty .dv-tab:hover { color: var(--hb-text); }
        #degenvault-floaty .dv-tab.active {
            background: var(--hb-panel-2);
            color: var(--hb-accent);
            border-color: var(--hb-accent);
        }
        #degenvault-floaty .dv-pane { display: flex; flex-direction: column; gap: 10px; }
        #degenvault-floaty .dv-pane.hidden { display: none; }
        #degenvault-floaty .dv-max-btn { flex: 0 0 auto; padding: 4px 8px; font-size: 10px; }
        #degenvault-floaty .dv-btn-row { display: flex; gap: 6px; margin-top: 4px; }
        #degenvault-floaty .dv-btn {
            flex: 1;
            background: var(--hb-panel-2);
            color: var(--hb-text);
            border: 1px solid var(--hb-border);
            border-radius: 3px;
            padding: 6px 10px;
            font-size: 11px;
            font-weight: 700;
            cursor: pointer;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        #degenvault-floaty .dv-btn:hover:not(:disabled) { background: var(--hb-border); color: #fff; }
        #degenvault-floaty .dv-btn:disabled { opacity: 0.4; cursor: not-allowed; }
        #degenvault-floaty .dv-btn.primary { background: var(--hb-accent); border-color: var(--hb-accent); color: #000; text-shadow: none; }
        #degenvault-floaty .dv-btn.primary:hover:not(:disabled) { background: #5cff85; }
        #degenvault-floaty .dv-btn.danger { background: #ef4444; border-color: #ef4444; color: #fff; }
        #degenvault-floaty .dv-btn.danger:hover:not(:disabled) { background: #dc2626; }
        #degenvault-floaty .dv-btn.ghost { background: transparent; }
        #degenvault-floaty .dv-stats {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 8px 12px;
            padding-top: 8px;
            border-top: 1px solid var(--hb-border);
            font-size: 11px;
        }
        #degenvault-floaty .dv-stat { display: flex; flex-direction: column; gap: 2px; }
        #degenvault-floaty .dv-stat-label { color: var(--hb-text-dim); font-size: 10px; text-transform: uppercase; display: flex; align-items: center; gap: 4px; }
        #degenvault-floaty .dv-stat-value { color: var(--hb-accent); font-weight: 700; text-shadow: 0 0 6px rgba(0,255,65,0.4); }
        #degenvault-floaty .dv-footer {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 6px;
            padding: 7px;
            border-top: 1px solid var(--hb-border);
        }
        #degenvault-floaty .dv-footer-tagline span { color: var(--hb-text-dim); font-size: 9.5px; letter-spacing: 1px; text-transform: uppercase; }
        #degenvault-floaty .dv-footer .dv-footer-accent { color: var(--hb-accent); }
        #degenvault-floaty .dv-discord-link {
            display: flex;
            align-items: center;
            gap: 5px;
            color: var(--hb-text-dim);
            background: var(--hb-panel-2);
            border: 1px solid var(--hb-border);
            border-radius: 3px;
            padding: 4px 10px;
            font-size: 10px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            text-decoration: none;
            transition: color 0.15s, border-color 0.15s;
        }
        #degenvault-floaty .dv-discord-link:hover {
            color: var(--hb-accent);
            border-color: var(--hb-accent);
            text-shadow: 0 0 6px rgba(0,255,65,0.5);
        }
        #degenvault-floaty .dv-discord-link svg { width: 14px; height: 14px; fill: currentColor; }
        #degenvault-floaty .dv-help {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 13px;
            height: 13px;
            border-radius: 50%;
            border: 1px solid var(--hb-border);
            color: var(--hb-text-dim);
            font-size: 9px;
            font-weight: 700;
            font-style: normal;
            text-transform: none;
            letter-spacing: 0;
            cursor: help;
            flex-shrink: 0;
        }
        #degenvault-floaty .dv-help:hover {
            color: #000;
            background: var(--hb-accent);
            border-color: var(--hb-accent);
        }
        #degenvault-floaty .dv-title .dv-help { margin-left: -2px; }
        #degenvault-tooltip {
            position: fixed;
            max-width: 210px;
            background: #0b100c;
            color: #cdf5cf;
            border: 1px solid #163019;
            border-radius: 4px;
            padding: 7px 9px;
            font-size: 10px;
            font-weight: 400;
            line-height: 1.45;
            text-align: left;
            font-family: 'Segoe UI', Arial, sans-serif;
            box-shadow: 0 4px 16px rgba(0,0,0,0.6);
            z-index: 2147483647;
            opacity: 0;
            pointer-events: none;
            transition: opacity 0.12s;
        }
        #degenvault-tooltip.visible { opacity: 1; }
        #degenvault-floaty .dv-log-toggle {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 6px 12px;
            background: var(--hb-panel-2);
            border-top: 1px solid var(--hb-border);
            cursor: pointer;
        }
        #degenvault-floaty .dv-log-toggle-text { font-size: 10px; color: var(--hb-text-dim); text-transform: uppercase; letter-spacing: 0.5px; }
        #degenvault-floaty .dv-log-toggle-icon { font-size: 10px; color: var(--hb-text-dim); transition: transform 0.2s; }
        #degenvault-floaty .dv-log-toggle.open .dv-log-toggle-icon { transform: rotate(180deg); }
        #degenvault-floaty .dv-log { max-height: 0; overflow: hidden; transition: max-height 0.25s ease-out; background: #070b06; }
        #degenvault-floaty .dv-log.open { max-height: 130px; }
        #degenvault-floaty .dv-log-inner { padding: 8px; max-height: 130px; overflow-y: auto; font-family: Monaco, Consolas, monospace; font-size: 10px; line-height: 1.4; }
        #degenvault-floaty .dv-log-entry { padding: 2px 0; color: var(--hb-text-dim); display: flex; gap: 6px; }
        #degenvault-floaty .dv-log-entry.success { color: var(--hb-accent); }
        #degenvault-floaty .dv-log-entry.profit { color: var(--hb-accent); }
        #degenvault-floaty .dv-log-entry.bigwin { color: #fbbf24; }
        #degenvault-floaty .dv-log-entry.warning { color: #f59e0b; }
        #degenvault-floaty .dv-log-entry.error { color: #ef4444; }
        #degenvault-floaty .dv-log-time { color: #3d4d38; flex-shrink: 0; }
        #degenvault-floaty .dv-log-empty { color: #3d4d38; font-style: italic; text-align: center; padding: 8px; }
        #degenvault-floaty.mini { min-width: auto; max-width: none; border-radius: 20px; }
        #degenvault-floaty.mini .dv-header { border-radius: 20px; padding: 6px 12px; border-bottom: none; }
        #degenvault-floaty.mini .dv-content, #degenvault-floaty.mini .dv-log-toggle,
        #degenvault-floaty.mini .dv-log, #degenvault-floaty.mini .dv-footer { display: none; }
        #degenvault-floaty.mini .dv-title span:not(.dv-hb-badge) { display: none; }
        #degenvault-stealth {
            position: fixed;
            bottom: 10px;
            right: 10px;
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: #4a5568;
            cursor: pointer;
            z-index: 999999;
            box-shadow: 0 1px 3px rgba(0,0,0,0.3);
        }
        #degenvault-stealth:hover { transform: scale(1.5); }
        #degenvault-stealth.running { background: #00FF41; }
        #degenvault-stealth.hidden { display: none; }
        @media (max-width: 500px) {
            #degenvault-floaty { max-width: none; min-width: auto; }
            #degenvault-floaty:not(.dv-dragged) { right: 10px !important; left: 10px !important; }
        }
        `;
        document.head.appendChild(style);

        const widget = document.createElement('div');
        widget.id = 'degenvault-floaty';

        const stealthDot = document.createElement('div');
        stealthDot.id = 'degenvault-stealth';
        stealthDot.className = 'hidden';
        stealthDot.title = 'DegenVault (click to expand)';
        document.body.appendChild(stealthDot);

        const header = document.createElement('div');
        header.className = 'dv-header';
        header.innerHTML = `
            <div class="dv-title">
                <div class="dv-status-dot" id="dvStatusDot"></div>
                <span class="dv-hb-badge">HB</span>
                <span>DegenVault</span>
                <span class="dv-help" data-tip="Reads your wallet balance straight from Degen's account API — no page-scraping or setup needed. DegenVault follows whichever currency is currently selected on Degen; it never forces a switch.">?</span>
            </div>
            <div class="dv-header-btns">
                <button class="dv-header-btn" id="dvMinBtn" title="Minimize">−</button>
                <button class="dv-header-btn" id="dvStealthBtn" title="Stealth Mode">○</button>
                <button class="dv-header-btn" id="dvCloseBtn" title="Close">×</button>
            </div>
        `;
        widget.appendChild(header);

        const content = document.createElement('div');
        content.className = 'dv-content';
        content.innerHTML = `
            <div class="dv-tabs">
                <button class="dv-tab active" id="dvTabAuto">Auto</button>
                <button class="dv-tab" id="dvTabManual">Manual</button>
            </div>
            <div class="dv-pane" id="dvPaneAuto">
            <div class="dv-row">
                <span class="dv-label-group">
                    <span class="dv-label">Tracking</span>
                    <span class="dv-help" data-tip="The currency DegenVault is currently auto-vaulting. This always follows whichever currency is selected as primary on Degen — switch currencies from Degen's own UI and tracking follows automatically. Use the sync button to re-check right now.">?</span>
                </span>
                <span class="dv-inline-group">
                    <span class="dv-stat-value" id="dvTrackedAsset">${ASSET || 'Waiting…'}</span>
                    <button class="dv-sync-btn" id="vaultSyncBtn" type="button" title="Sync currency">⟳</button>
                </span>
            </div>
            <div class="dv-row">
                <span class="dv-label-group">
                    <span class="dv-label">Save %</span>
                    <span class="dv-help" data-tip="The fraction of any profit that gets sent to the vault each time your balance goes up. 0.1 = 10% of a win is vaulted, the rest stays in your wallet to keep playing with.">?</span>
                </span>
                <input type="number" id="vaultSaveAmount" min="0" max="1" step="0.01" value="${getParams().saveAmount}">
            </div>
            <div class="dv-row">
                <span class="dv-label-group">
                    <span class="dv-label">Big Win Threshold</span>
                    <span class="dv-help" data-tip="If your balance jumps to at least this many times its previous value in one check, it counts as a 'Big Win' and uses the Big Win Multiplier instead of the normal Save %. E.g. 5 means your balance grew 5x or more.">?</span>
                </span>
                <input type="number" id="vaultBigWinThreshold" min="1" step="0.1" value="${getParams().bigWinThreshold}">
            </div>
            <div class="dv-row">
                <span class="dv-label-group">
                    <span class="dv-label">Big Win Multiplier</span>
                    <span class="dv-help" data-tip="On a Big Win, this multiplies the Save % instead of using it directly. E.g. Save % 0.1 with Multiplier 3 vaults 30% of a big win instead of the usual 10%.">?</span>
                </span>
                <input type="number" id="vaultBigWinMultiplier" min="1" step="0.1" value="${getParams().bigWinMultiplier}">
            </div>
            <div class="dv-row">
                <span class="dv-label-group">
                    <span class="dv-label">Check Interval (sec)</span>
                    <span class="dv-help" data-tip="How often DegenVault checks your balance for profit to vault. Lower values react faster but make more API calls; higher values are gentler on the rate limit.">?</span>
                </span>
                <input type="number" id="vaultCheckInterval" min="10" step="1" value="${getParams().checkInterval}">
            </div>
            <div class="dv-btn-row">
                <button class="dv-btn primary" id="vaultStartBtn">Start</button>
                <button class="dv-btn ghost" id="vaultSaveBtn">Save</button>
                <button class="dv-btn danger" id="vaultStopBtn" disabled>Stop</button>
            </div>
            </div>
            <div class="dv-pane hidden" id="dvPaneManual">
                <div class="dv-row">
                    <span class="dv-label-group">
                        <span class="dv-label">Currency</span>
                        <span class="dv-help" data-tip="Pick which wallet currency to vault from. The list comes straight from your Degen wallets; hit the refresh button to re-read balances.">?</span>
                    </span>
                    <span class="dv-inline-group">
                        <select id="dvManualAsset"></select>
                        <button class="dv-sync-btn" id="dvManualRefresh" type="button" title="Refresh balances">⟳</button>
                    </span>
                </div>
                <div class="dv-row">
                    <span class="dv-label-group">
                        <span class="dv-label">Amount</span>
                        <span class="dv-help" data-tip="How much of the selected currency to move into your vault right now. Max fills in your full wallet balance.">?</span>
                    </span>
                    <span class="dv-inline-group">
                        <input type="number" id="dvManualAmount" min="0" step="0.00000001" placeholder="0.0">
                        <button class="dv-btn ghost dv-max-btn" id="dvManualMax" type="button">Max</button>
                    </span>
                </div>
                <div class="dv-row">
                    <span class="dv-label">Available</span>
                    <span class="dv-stat-value" id="dvManualAvail">—</span>
                </div>
                <div class="dv-btn-row">
                    <button class="dv-btn primary" id="dvManualDeposit">Deposit to Vault</button>
                </div>
            </div>
            <div class="dv-stats">
                <div class="dv-stat">
                    <span class="dv-stat-label">Wallet Balance</span>
                    <span class="dv-stat-value" id="dvWalletBal">—</span>
                </div>
                <div class="dv-stat">
                    <span class="dv-stat-label">Vault Balance</span>
                    <span class="dv-stat-value" id="dvVaultBal">0.00</span>
                </div>
                <div class="dv-stat">
                    <span class="dv-stat-label">Actions/hr</span>
                    <span class="dv-stat-value" id="dvVaultCount">0/50</span>
                </div>
                <div class="dv-stat">
                    <span class="dv-stat-label">7d Wager <span class="dv-help" data-tip="Total wagered on Degen over the last 7 days (USD value, all currencies — read from Degen's own lifetime counter, so play from every device counts). Amber while the first week of tracking warms up; during warm-up the figure reads LOW. Tracks whenever a Degen tab is open, even while vaulting is stopped.">?</span></span>
                    <span class="dv-stat-value" id="dvWager7d">—</span>
                </div>
            </div>
        `;
        widget.appendChild(content);

        const logToggle = document.createElement('div');
        logToggle.className = 'dv-log-toggle';
        logToggle.innerHTML = `<span class="dv-log-toggle-text">Activity Log</span><span class="dv-log-toggle-icon">▼</span>`;
        widget.appendChild(logToggle);

        const logPanel = document.createElement('div');
        logPanel.className = 'dv-log';
        logPanel.innerHTML = `<div class="dv-log-inner" id="dvLogInner"><div class="dv-log-empty">No activity yet...</div></div>`;
        widget.appendChild(logPanel);

        const logInner = logPanel.querySelector('#dvLogInner');

        logToggle.onclick = () => {
            logToggle.classList.toggle('open');
            logPanel.classList.toggle('open');
        };

        const formatTime = (date) => {
            const h = date.getHours().toString().padStart(2, '0');
            const m = date.getMinutes().toString().padStart(2, '0');
            const s = date.getSeconds().toString().padStart(2, '0');
            return `${h}:${m}:${s}`;
        };

        function addLogEntry(entry) {
            const empty = logInner.querySelector('.dv-log-empty');
            if (empty) empty.remove();
            const div = document.createElement('div');
            div.className = `dv-log-entry ${entry.type}`;
            div.innerHTML = `<span class="dv-log-time">${formatTime(entry.time)}</span><span>${entry.message}</span>`;
            logInner.insertBefore(div, logInner.firstChild);
            while (logInner.children.length > 20) logInner.removeChild(logInner.lastChild);
        }
        onLogUpdate = addLogEntry;

        const footer = document.createElement('div');
        footer.className = 'dv-footer';
        footer.innerHTML = `
            <div class="dv-footer-tagline"><span>powered by <span class="dv-footer-accent">degens</span> for <span class="dv-footer-accent">degens</span></span></div>
            <a class="dv-discord-link" href="https://discord.gg/degenhomebase" target="_blank" rel="noopener noreferrer" title="Join the HomeBase Discord">
                <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M20.317 4.369a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.09-.32 13.68.099 18.21a.082.082 0 0 0 .031.056 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.099.246.198.373.292a.077.077 0 0 1-.006.128 12.3 12.3 0 0 1-1.873.891.076.076 0 0 0-.04.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.029 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.055c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.028zM8.02 15.331c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.418 2.157-2.418 1.211 0 2.176 1.094 2.157 2.418 0 1.334-.955 2.419-2.157 2.419zm7.974 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.418 2.157-2.418 1.211 0 2.176 1.094 2.157 2.418 0 1.334-.946 2.419-2.157 2.419z"/></svg>
                <span>Discord</span>
            </a>
        `;
        widget.appendChild(footer);

        const vaultBalEl = content.querySelector('#dvVaultBal');
        vaultDisplay._el = vaultBalEl;
        vaultDisplay.render();

        const statusDot = widget.querySelector('#dvStatusDot');
        const minBtn = widget.querySelector('#dvMinBtn');
        const stealthBtn = widget.querySelector('#dvStealthBtn');
        const closeBtn = widget.querySelector('#dvCloseBtn');

        function setViewMode(mode) {
            currentViewMode = mode;
            if (mode === 'full') {
                widget.classList.remove('mini', 'hidden');
                stealthDot.classList.add('hidden');
            } else if (mode === 'mini') {
                widget.classList.add('mini');
                widget.classList.remove('hidden');
                stealthDot.classList.add('hidden');
            } else if (mode === 'stealth') {
                widget.classList.add('hidden');
                stealthDot.classList.remove('hidden');
            }
        }

        minBtn.onclick = (e) => {
            e.stopPropagation();
            setViewMode(currentViewMode === 'mini' ? 'full' : 'mini');
            minBtn.textContent = currentViewMode === 'mini' ? '+' : '−';
        };
        stealthBtn.onclick = (e) => { e.stopPropagation(); setViewMode('stealth'); };
        stealthDot.onclick = () => { setViewMode('full'); minBtn.textContent = '−'; };
        closeBtn.onclick = () => { widget.remove(); stealthDot.remove(); };

        // Drag: mouse + touch, with the position persisted so the widget stays
        // where the user put it across page loads. On phones the widget is
        // stretched edge-to-edge by CSS until the first drag; the width is
        // locked at that moment so it doesn't snap while moving.
        const POS_KEY = 'degenvault-widget-pos';
        let isDragging = false, dragOffsetX = 0, dragOffsetY = 0;

        function savePosition() {
            try {
                localStorage.setItem(POS_KEY, JSON.stringify({
                    left: parseFloat(widget.style.left),
                    top: parseFloat(widget.style.top),
                    width: parseFloat(widget.style.width) || null
                }));
            } catch (e) {}
        }
        function restorePosition() {
            let pos = null;
            try { pos = JSON.parse(localStorage.getItem(POS_KEY)); } catch (e) {}
            if (!pos || !isFinite(pos.left) || !isFinite(pos.top)) return;
            widget.classList.add('dv-dragged');
            if (isFinite(pos.width) && pos.width > 0) widget.style.width = Math.min(pos.width, window.innerWidth - 8) + 'px';
            widget.style.left = Math.max(0, Math.min(window.innerWidth - widget.offsetWidth, pos.left)) + 'px';
            widget.style.top = Math.max(0, Math.min(window.innerHeight - 40, pos.top)) + 'px';
            widget.style.right = 'auto';
        }

        function dragStart(x, y, target) {
            if (target.closest && target.closest('.dv-header-btns')) return false;
            const rect = widget.getBoundingClientRect();
            isDragging = true;
            dragOffsetX = x - rect.left;
            dragOffsetY = y - rect.top;
            return true;
        }
        function dragMove(x, y) {
            if (!isDragging) return;
            if (!widget.classList.contains('dv-dragged')) {
                widget.style.width = widget.getBoundingClientRect().width + 'px';
                widget.classList.add('dv-dragged');
            }
            let newLeft = x - dragOffsetX;
            let newTop = y - dragOffsetY;
            newLeft = Math.max(0, Math.min(window.innerWidth - widget.offsetWidth, newLeft));
            newTop = Math.max(0, Math.min(window.innerHeight - widget.offsetHeight, newTop));
            widget.style.left = newLeft + 'px';
            widget.style.top = newTop + 'px';
            widget.style.right = 'auto';
        }
        function dragEnd() {
            if (!isDragging) return;
            isDragging = false;
            if (widget.classList.contains('dv-dragged') && widget.style.left) savePosition();
        }

        header.addEventListener('mousedown', function(e) {
            if (dragStart(e.clientX, e.clientY, e.target)) e.preventDefault();
        });
        document.addEventListener('mousemove', (e) => dragMove(e.clientX, e.clientY));
        document.addEventListener('mouseup', dragEnd);
        header.addEventListener('touchstart', function(e) {
            const t = e.touches[0];
            if (t && dragStart(t.clientX, t.clientY, e.target)) e.preventDefault();
        }, { passive: false });
        document.addEventListener('touchmove', function(e) {
            if (!isDragging) return;
            const t = e.touches[0];
            if (t) { dragMove(t.clientX, t.clientY); e.preventDefault(); }
        }, { passive: false });
        document.addEventListener('touchend', dragEnd);
        document.addEventListener('touchcancel', dragEnd);

        const startBtn = content.querySelector('#vaultStartBtn');
        const saveBtn = content.querySelector('#vaultSaveBtn');
        const stopBtn = content.querySelector('#vaultStopBtn');
        const saveAmountInput = content.querySelector('#vaultSaveAmount');
        const bigWinThresholdInput = content.querySelector('#vaultBigWinThreshold');
        const bigWinMultiplierInput = content.querySelector('#vaultBigWinMultiplier');
        const checkIntervalInput = content.querySelector('#vaultCheckInterval');

        // Read every setting straight from the inputs, clamp, and write the
        // clamped values back. Called on Start and Save so the numbers shown
        // are always exactly what gets used — mobile keyboards don't reliably
        // fire the change event before a button tap, so relying on onchange
        // alone silently reverted edits.
        function readSettingsFromInputs() {
            let sa = parseFloat(saveAmountInput.value);
            if (isNaN(sa) || sa < 0) sa = 0;
            if (sa > 1) sa = 1;
            let bt = parseFloat(bigWinThresholdInput.value);
            if (isNaN(bt) || bt < 1) bt = 1;
            let bm = parseFloat(bigWinMultiplierInput.value);
            if (isNaN(bm) || bm < 1) bm = 1;
            let ci = parseInt(checkIntervalInput.value, 10);
            if (isNaN(ci) || ci < 10) ci = 10;
            saveAmountInput.value = sa;
            bigWinThresholdInput.value = bt;
            bigWinMultiplierInput.value = bm;
            checkIntervalInput.value = ci;
            return { saveAmount: sa, bigWinThreshold: bt, bigWinMultiplier: bm, checkInterval: ci };
        }
        const vaultCountEl = content.querySelector('#dvVaultCount');
        const walletBalEl = content.querySelector('#dvWalletBal');
        const trackedAssetEl = content.querySelector('#dvTrackedAsset');
        const syncBtn = content.querySelector('#vaultSyncBtn');

        function updateVaultCountUI() {
            const count = getVaultCountLastHour();
            vaultCountEl.textContent = `${count}/50`;
            vaultCountEl.style.color = count >= 50 ? '#ef4444' : count >= 40 ? '#f59e0b' : '#00FF41';
        }
        window.__updateVaultCountUI = updateVaultCountUI;
        updateVaultCountUI();
        setInterval(updateVaultCountUI, 10000);

        function setRunningState(isRunning) {
            statusDot.classList.toggle('running', isRunning);
            stealthDot.classList.toggle('running', isRunning);
            startBtn.disabled = isRunning;
            stopBtn.disabled = !isRunning;
        }

        startBtn.onclick = () => {
            setParams(readSettingsFromInputs(), { restart: false });
            setRunningState(true);
            startCallback();
            updateVaultCountUI();
        };
        saveBtn.onclick = () => {
            setParams(readSettingsFromInputs());
            logActivity('Settings saved', 'success');
            saveBtn.textContent = 'Saved ✓';
            setTimeout(() => { saveBtn.textContent = 'Save'; }, 1200);
        };
        stopBtn.onclick = () => { setRunningState(false); stopCallback(); updateVaultCountUI(); };

        function updateWalletBalanceUI(value) {
            if (walletBalEl) walletBalEl.textContent = (typeof value === 'number' && !isNaN(value)) ? value.toFixed(8) : '—';
        }
        window.__updateWalletBalanceUI = updateWalletBalanceUI;

        function updateTrackedAssetUI(asset) {
            if (trackedAssetEl) trackedAssetEl.textContent = asset || 'Waiting…';
        }

        if (syncBtn) {
            syncBtn.onclick = () => {
                syncBtn.classList.add('spinning');
                syncBtn.disabled = true;
                Promise.resolve(syncCallback()).finally(() => {
                    syncBtn.classList.remove('spinning');
                    syncBtn.disabled = false;
                });
            };
        }

        // --- Tabs (Auto / Manual) ---
        const tabAuto = content.querySelector('#dvTabAuto');
        const tabManual = content.querySelector('#dvTabManual');
        const paneAuto = content.querySelector('#dvPaneAuto');
        const paneManual = content.querySelector('#dvPaneManual');
        function showTab(which) {
            const manual = which === 'manual';
            tabAuto.classList.toggle('active', !manual);
            tabManual.classList.toggle('active', manual);
            paneAuto.classList.toggle('hidden', manual);
            paneManual.classList.toggle('hidden', !manual);
            if (manual) populateManualAssets();
        }
        tabAuto.onclick = () => showTab('auto');
        tabManual.onclick = () => showTab('manual');

        // --- Manual vaulting ---
        const manualAssetSelect = content.querySelector('#dvManualAsset');
        const manualRefreshBtn = content.querySelector('#dvManualRefresh');
        const manualAmountInput = content.querySelector('#dvManualAmount');
        const manualMaxBtn = content.querySelector('#dvManualMax');
        const manualAvailEl = content.querySelector('#dvManualAvail');
        const manualDepositBtn = content.querySelector('#dvManualDeposit');
        let manualWallets = [];

        function manualSelected() {
            return manualWallets.find(w => (w.asset || '').toUpperCase() === manualAssetSelect.value) || null;
        }
        function updateManualAvail() {
            const w = manualSelected();
            const bal = w ? parseFloat(w.balance) : NaN;
            manualAvailEl.textContent = !isNaN(bal) ? `${bal.toFixed(8)} ${(w.asset || '').toUpperCase()}` : '—';
        }
        async function populateManualAssets() {
            manualRefreshBtn.classList.add('spinning');
            const prev = manualAssetSelect.value;
            const list = await fetchWalletsCallback();
            manualRefreshBtn.classList.remove('spinning');
            if (!Array.isArray(list)) {
                if (!manualWallets.length) manualAvailEl.textContent = 'API error';
                return;
            }
            manualWallets = list;
            manualAssetSelect.innerHTML = '';
            for (const w of list) {
                const a = (w.asset || '').toUpperCase();
                if (!a) continue;
                const opt = document.createElement('option');
                opt.value = a;
                opt.textContent = a;
                manualAssetSelect.appendChild(opt);
            }
            const want = prev || (ASSET || '').toUpperCase();
            if (want && [...manualAssetSelect.options].some(o => o.value === want)) manualAssetSelect.value = want;
            updateManualAvail();
        }
        manualAssetSelect.onchange = updateManualAvail;
        manualRefreshBtn.onclick = () => populateManualAssets();
        manualMaxBtn.onclick = () => {
            const w = manualSelected();
            const bal = w ? parseFloat(w.balance) : NaN;
            if (!isNaN(bal)) manualAmountInput.value = bal.toFixed(8);
        };
        manualDepositBtn.onclick = async () => {
            const asset = manualAssetSelect.value;
            const amt = parseFloat(manualAmountInput.value);
            if (!asset) { logActivity('Manual vault: pick a currency first', 'warning'); return; }
            if (isNaN(amt) || amt <= 0) { logActivity('Manual vault: enter an amount above 0', 'warning'); return; }
            const w = manualSelected();
            const bal = w ? parseFloat(w.balance) : NaN;
            if (!isNaN(bal) && amt > bal + 1e-9) {
                logActivity(`Manual vault: amount exceeds available ${bal.toFixed(8)} ${asset}`, 'warning');
                return;
            }
            manualDepositBtn.disabled = true;
            manualDepositBtn.textContent = 'Vaulting…';
            const ok = await manualVaultCallback(asset, amt);
            manualDepositBtn.textContent = ok ? 'Vaulted ✓' : 'Failed ✗';
            setTimeout(() => {
                manualDepositBtn.textContent = 'Deposit to Vault';
                manualDepositBtn.disabled = false;
            }, 1400);
            if (ok) {
                manualAmountInput.value = '';
                populateManualAssets();
            }
        };

        saveAmountInput.onchange = function() {
            let v = parseFloat(this.value);
            if (isNaN(v) || v < 0) v = 0;
            if (v > 1) v = 1;
            setParams({saveAmount: v});
            this.value = v;
        };
        bigWinThresholdInput.onchange = function() {
            let v = parseFloat(this.value);
            if (isNaN(v) || v < 1) v = 1;
            setParams({bigWinThreshold: v});
            this.value = v;
        };
        bigWinMultiplierInput.onchange = function() {
            let v = parseFloat(this.value);
            if (isNaN(v) || v < 1) v = 1;
            setParams({bigWinMultiplier: v});
            this.value = v;
        };
        checkIntervalInput.onchange = function() {
            let v = parseInt(this.value, 10);
            if (isNaN(v) || v < 10) v = 10;
            setParams({checkInterval: v});
            this.value = v;
        };
        // Persist as the user types (no clamping mid-edit, no restart) so the
        // value survives an SPA reload even if change never fires on mobile.
        saveAmountInput.addEventListener('input', function() {
            const v = parseFloat(this.value);
            if (!isNaN(v)) setParams({saveAmount: Math.max(0, Math.min(1, v))}, { restart: false });
        });
        bigWinThresholdInput.addEventListener('input', function() {
            const v = parseFloat(this.value);
            if (!isNaN(v)) setParams({bigWinThreshold: Math.max(1, v)}, { restart: false });
        });
        bigWinMultiplierInput.addEventListener('input', function() {
            const v = parseFloat(this.value);
            if (!isNaN(v)) setParams({bigWinMultiplier: Math.max(1, v)}, { restart: false });
        });
        checkIntervalInput.addEventListener('input', function() {
            const v = parseInt(this.value, 10);
            if (!isNaN(v)) setParams({checkInterval: Math.max(10, v)}, { restart: false });
        });

        document.body.appendChild(widget);
        restorePosition();
        initHelpTooltips(widget);

        return {
            setRunning: setRunningState,
            updateVaultCount: updateVaultCountUI,
            updateWalletBalance: updateWalletBalanceUI,
            updateTrackedAsset: updateTrackedAssetUI
        };
    }

    // --- Main logic ---
    let vaultInterval = null;
    let vaultDisplay = null;
    let degenApi = null;
    let apiVaultPollInterval = null;
    let oldBalance = 0;
    let isProcessing = false;
    let isInitialized = false;
    let lastBalance = 0;
    let running = false;
    let uiWidget = null;

    async function refreshApiVaultBalance() {
        try {
            if (!ASSET || !vaultDisplay) return;
            if (!degenApi) degenApi = new DegenApi();
            const resp = await degenApi.getVaults();
            if (!Array.isArray(resp)) return;
            const entry = resp.find(x => (x.asset || '').toUpperCase() === ASSET.toUpperCase());
            if (entry) vaultDisplay.setApiVaultBalance(entry.balance);
        } catch (e) {}
    }

    function startApiVaultPolling() {
        if (apiVaultPollInterval) clearInterval(apiVaultPollInterval);
        apiVaultPollInterval = setInterval(refreshApiVaultBalance, 15000);
        refreshApiVaultBalance();
    }
    function stopApiVaultPolling() {
        if (apiVaultPollInterval) clearInterval(apiVaultPollInterval);
        apiVaultPollInterval = null;
    }

    // ── Rolling 7-day wager tracker ─────────────────────────────────────
    // Same design as the Stake claimer's tracker: read the server-side lifetime
    // wagered counter (Degen's user statistics, USD-equivalent across all
    // currencies and devices), snapshot it per-account in localStorage, and
    // difference over 168h to get the rolling-7d wager. Because the lifetime
    // counter is authoritative, gaps in snapshotting (tab closed, phone off)
    // never lose wager — the next reading self-corrects; only granularity of
    // where the 7-day boundary falls is affected.
    const WAGER_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
    const WAGER_KEEP_MS = 9 * 24 * 60 * 60 * 1000;
    const WAGER_POLL_MS = 60 * 1000;

    let wagerUserId = null;
    let wagerLifetime = null;
    let wagerRolling = null;
    let wagerOk = false;
    let wagerPollTimer = null;
    let wagerBackoffUntil = 0;

    // Keys are namespaced per user id so switching accounts in one browser
    // never interleaves two different lifetime scales in one anchor array.
    // Null until the account is known — better not to snapshot at all than
    // to snapshot into the wrong bucket.
    function wagerKeys() {
        if (!wagerUserId) return null;
        return {
            anchors: `degenvault-wager-anchors::${wagerUserId}`,
            start: `degenvault-wager-start::${wagerUserId}`
        };
    }
    function wagerGet(key, fallback) {
        try {
            const raw = localStorage.getItem(key);
            return raw == null ? fallback : JSON.parse(raw);
        } catch (e) { return fallback; }
    }
    function wagerSet(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
    }

    // Compact figure for the stat box (120000 -> "$120.0k").
    function wagerFmtShort(n) {
        if (n == null || !isFinite(n)) return '—';
        if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
        if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'k';
        return '$' + Math.round(n);
    }

    // Degen reports lifetime wagered as a USD figure — sometimes a bare number,
    // sometimes a string like "12,345.67 USD".
    function wagerParseAmount(w) {
        if (typeof w === 'number') return w;
        if (typeof w !== 'string') return NaN;
        return parseFloat(w.replace(/[^0-9.]/g, ''));
    }

    // Append a lifetime snapshot (monotonic; throttle unchanged; prune past
    // window+margin, but always keep the newest anchor already ≥7d old — that
    // one is the rolling baseline).
    function wagerRecordAnchor(cum) {
        if (!isFinite(cum) || cum < 0) return;
        const K = wagerKeys();
        if (!K) return;
        const now = Date.now();
        let anchors = wagerGet(K.anchors, []);
        if (!Array.isArray(anchors)) anchors = [];
        const last = anchors[anchors.length - 1];
        if (last) {
            if (cum < last.cum - 1e-6) return;                                            // lifetime can't drop
            if (Math.abs(cum - last.cum) < 1e-9 && (now - last.t) < 10 * 60 * 1000) return; // throttle unchanged
        }
        anchors.push({ t: now, cum });
        const minT = now - WAGER_KEEP_MS, cutoff = now - WAGER_WINDOW_MS;
        let keepIdx = -1;
        for (let i = 0; i < anchors.length; i++) if (anchors[i].t <= cutoff) keepIdx = i;
        anchors = anchors.filter((p, idx) => p.t >= minT || idx === keepIdx);
        wagerSet(K.anchors, anchors);
    }

    // rolling 168h = lifetime(now) − lifetime(NEWEST snapshot already ≥7d old).
    // With no anchor that old yet (warm-up) the oldest anchor is the best lower
    // bound; the UI shows amber until the full window is covered.
    function wagerComputeRolling() {
        const K = wagerKeys();
        if (!K) return null;
        const anchors = wagerGet(K.anchors, []);
        if (!Array.isArray(anchors) || !anchors.length) return null;
        const now = Date.now(), cutoff = now - WAGER_WINDOW_MS;
        const cur = anchors[anchors.length - 1].cum;
        let baseline = null;
        for (let i = 0; i < anchors.length; i++) { if (anchors[i].t <= cutoff) baseline = anchors[i]; }
        if (!baseline) baseline = anchors[0];
        return Math.max(0, cur - baseline.cum);
    }

    function wagerCoverageMs() {
        const K = wagerKeys();
        const start = K ? wagerGet(K.start, 0) : 0;
        return start ? (Date.now() - start) : 0;
    }

    async function fetchWagerStats() {
        // Back off after a failure (usually logged out) so the activity log
        // isn't flooded with a failed API call every poll.
        if (Date.now() < wagerBackoffUntil) return;
        try {
            if (!degenApi) degenApi = new DegenApi();
            if (!wagerUserId) {
                const prof = await degenApi.getProfile();
                const id = prof && !prof.error ? (prof.id || (prof.user && prof.user.id)) : null;
                if (!id) { wagerFail(); return; }
                wagerUserId = String(id);
            }
            // The public user object is where Degen's own frontend reads
            // statistics from; /users/{id}/stats is the fallback.
            let stats = null;
            const pub = await degenApi.getPublicUser(wagerUserId);
            if (pub && !pub.error) stats = pub.statistics || pub.stats || null;
            if (!stats) {
                const alt = await degenApi.getUserStats(wagerUserId);
                if (alt && !alt.error) stats = alt.statistics || alt;
            }
            const lifetime = stats ? wagerParseAmount(stats.wagered) : NaN;
            if (isNaN(lifetime)) { wagerFail(); return; }
            const first = wagerLifetime == null;
            wagerOk = true;
            wagerBackoffUntil = 0;
            wagerLifetime = lifetime;
            const K = wagerKeys();
            if (K && !wagerGet(K.start, 0)) wagerSet(K.start, Date.now());   // start the coverage clock
            wagerRecordAnchor(lifetime);
            wagerRolling = wagerComputeRolling();
            if (first) logActivity(`7d wager tracking online — lifetime wagered $${Math.round(lifetime).toLocaleString()}`, 'info');
            updateWagerUI();
        } catch (e) {
            wagerFail();
        }
    }
    function wagerFail() {
        wagerOk = false;
        wagerBackoffUntil = Date.now() + 5 * 60 * 1000;
        updateWagerUI();
    }

    // Runs whenever a Degen tab is open, independent of Start/Stop — the
    // rolling window is only as good as its snapshot history.
    function startWagerTracking() {
        if (wagerPollTimer) return;
        fetchWagerStats();
        wagerPollTimer = setInterval(fetchWagerStats, WAGER_POLL_MS);
        document.addEventListener('visibilitychange', () => { if (!document.hidden) fetchWagerStats(); });
    }

    function updateWagerUI() {
        const el = document.getElementById('dvWager7d');
        if (!el) return;
        if (wagerRolling == null) {
            el.textContent = '—';
            el.style.color = '';
            el.title = wagerOk
                ? 'First reading in — computing the window…'
                : 'Waiting for the first wager reading (log in to Degen if this persists)';
            return;
        }
        const coverMs = wagerCoverageMs();
        const full = coverMs >= WAGER_WINDOW_MS;
        el.textContent = wagerFmtShort(wagerRolling);
        el.style.color = full ? '' : '#f59e0b';   // amber while the window warms up
        el.title =
            `Rolling 7d: $${Math.round(wagerRolling).toLocaleString()}\n` +
            `Lifetime: ${wagerLifetime != null ? '$' + Math.round(wagerLifetime).toLocaleString() : '—'}\n` +
            (full ? 'Coverage: full 7d window ✅'
                  : `Coverage: warming up ${(coverMs / 864e5).toFixed(1)}/7d — reads LOW until a full week is covered`);
    }

    // F12 console helpers: __degenWagerStatus() / __degenWagerRefresh()
    window.__degenWagerRefresh = () => fetchWagerStats();
    window.__degenWagerStatus = () => {
        const K = wagerKeys();
        const anchors = K ? wagerGet(K.anchors, []) : [];
        const coverD = wagerCoverageMs() / 864e5;
        return {
            userId: wagerUserId, rolling7d: wagerRolling, lifetime: wagerLifetime,
            anchors: Array.isArray(anchors) ? anchors.length : 0,
            coverageDays: +coverD.toFixed(2), full: coverD >= 7, ok: wagerOk
        };
    };

    function getParams() {
        return {
            saveAmount: SAVE_AMOUNT,
            bigWinThreshold: BIG_WIN_THRESHOLD,
            bigWinMultiplier: BIG_WIN_MULTIPLIER,
            checkInterval: Math.round(CHECK_INTERVAL/1000)
        };
    }
    function setParams(obj, opts) {
        if (obj.saveAmount !== undefined) SAVE_AMOUNT = obj.saveAmount;
        if (obj.bigWinThreshold !== undefined) BIG_WIN_THRESHOLD = obj.bigWinThreshold;
        if (obj.bigWinMultiplier !== undefined) BIG_WIN_MULTIPLIER = obj.bigWinMultiplier;
        if (obj.checkInterval !== undefined) CHECK_INTERVAL = obj.checkInterval * 1000;

        config = {
            saveAmount: SAVE_AMOUNT,
            bigWinThreshold: BIG_WIN_THRESHOLD,
            bigWinMultiplier: BIG_WIN_MULTIPLIER,
            checkInterval: CHECK_INTERVAL
        };
        saveConfig(config);

        const restart = !opts || opts.restart !== false;
        if (restart && running) {
            stopVaultScript();
            startVaultScript();
        }
    }


    async function fetchWalletBalance() {
        if (!degenApi) degenApi = new DegenApi();
        const resp = await degenApi.getWallets();
        if (!Array.isArray(resp)) {
            if (resp && resp.error) log(`Balance check failed: ${resp.message || resp.status}`);
            return NaN;
        }
        const primary = resp.find(x => x.isPrimary);
        if (!primary) {
            log('⚠️ No primary wallet found.');
            return NaN;
        }
        setTrackedAsset(primary.asset);
        const n = parseFloat(primary.balance);
        return isNaN(n) ? NaN : n;
    }

    async function fetchWalletsList() {
        if (!degenApi) degenApi = new DegenApi();
        const resp = await degenApi.getWallets();
        return Array.isArray(resp) ? resp : null;
    }

    // Manual one-off vault deposit from the Manual tab. Counts against the same
    // client-side rate limit as auto deposits. Returns true on success.
    let manualProcessing = false;
    async function manualVault(asset, amount) {
        if (manualProcessing) return false;
        if (!canVaultNow()) {
            logActivity(pickFlavor(FLAVOR.rateLimit), 'warning');
            if (uiWidget) uiWidget.updateVaultCount();
            return false;
        }
        manualProcessing = true;
        try {
            if (!degenApi) degenApi = new DegenApi();
            const resp = await degenApi.depositToVault(asset, amount);
            if (resp && !resp.error && resp.vaultBalance !== undefined) {
                vaultActionTimestamps.push(Date.now());
                saveRateLimitData(vaultActionTimestamps);
                if (vaultDisplay && (asset || '').toUpperCase() === (ASSET || '').toUpperCase()) {
                    vaultDisplay.update(amount);
                    vaultDisplay.setApiVaultBalance(resp.vaultBalance);
                    if (resp.walletBalance !== undefined) {
                        const wb = parseFloat(resp.walletBalance);
                        if (!isNaN(wb)) {
                            oldBalance = wb;
                            if (uiWidget) uiWidget.updateWalletBalance(wb);
                        }
                    }
                }
                if (uiWidget) uiWidget.updateVaultCount();
                logActivity(`Secured ${(+amount).toFixed(6)} ${asset} (manual)`, 'success');
                return true;
            }
            logActivity('Manual vault failed — check amount, balance and rate limit', 'error');
            return false;
        } catch (e) {
            logActivity('Manual vault error: ' + (e.message || 'unknown'), 'error');
            return false;
        } finally {
            manualProcessing = false;
        }
    }

    async function syncCurrency() {
        logActivity('Syncing currency…', 'info');
        const cur = await fetchWalletBalance();
        if (uiWidget) uiWidget.updateWalletBalance(cur);
        if (!isNaN(cur)) {
            logActivity(`Synced — currently tracking ${ASSET}`, 'success');
        } else {
            logActivity('Sync failed — could not reach the balance API.', 'error');
        }
    }

    async function processDeposit(amount, isBigWin) {
        if (amount < 1e-8 || isProcessing) return;
        if (!canVaultNow()) {
            logActivity(`${pickFlavor(FLAVOR.rateLimit)}`, 'warning');
            if (uiWidget) uiWidget.updateVaultCount();
            return;
        }
        isProcessing = true;
        const pct = (SAVE_AMOUNT * (isBigWin ? BIG_WIN_MULTIPLIER : 1) * 100).toFixed(0);
        const flavor = pickFlavor(isBigWin ? FLAVOR.bigWin : FLAVOR.profit);
        logActivity(`${flavor} — vaulting ${pct}%: ${amount.toFixed(6)} ${ASSET}`, isBigWin ? 'bigwin' : 'profit');
        try {
            const resp = await degenApi.depositToVault(ASSET, amount);
            isProcessing = false;
            if (resp && !resp.error && resp.vaultBalance !== undefined) {
                vaultDisplay.update(amount);
                vaultDisplay.setApiVaultBalance(resp.vaultBalance);
                vaultActionTimestamps.push(Date.now());
                saveRateLimitData(vaultActionTimestamps);
                if (resp.walletBalance !== undefined) {
                    const wb = parseFloat(resp.walletBalance);
                    if (!isNaN(wb)) {
                        oldBalance = wb;
                        if (uiWidget) uiWidget.updateWalletBalance(wb);
                    }
                }
                if (uiWidget) uiWidget.updateVaultCount();
                logActivity(`Secured ${amount.toFixed(6)} ${ASSET}`, 'success');
            } else {
                logActivity('Vault failed — may be rate limited or asset mismatch', 'error');
            }
        } catch (e) {
            isProcessing = false;
            logActivity('Vault error: ' + (e.message || 'unknown'), 'error');
        }
    }

    async function checkBalanceChanges() {
        const cur = await fetchWalletBalance();
        if (uiWidget) uiWidget.updateWalletBalance(cur);
        if (isNaN(cur)) return;

        if (!isInitialized) {
            oldBalance = cur;
            isInitialized = true;
            log(`🐾 Initial balance: ${oldBalance.toFixed(8)} ${ASSET}`);
            lastBalance = cur;
            return;
        }

        if (cur > oldBalance) {
            const profit = cur - oldBalance;
            const isBig = cur > oldBalance * BIG_WIN_THRESHOLD;
            const depAmt = profit * SAVE_AMOUNT * (isBig ? BIG_WIN_MULTIPLIER : 1);
            processDeposit(depAmt, isBig);
            oldBalance = cur;
        } else if (cur < oldBalance) {
            oldBalance = cur;
        }
        lastBalance = cur;
        if (uiWidget) uiWidget.updateVaultCount();
    }

    async function startVaultScript() {
        if (running) return;
        isScriptInitialized = true;
        running = true;
        logActivity(pickFlavor(FLAVOR.start), 'success');
        if (!vaultDisplay) vaultDisplay = new VaultDisplay();
        degenApi = new DegenApi();
        startApiVaultPolling();
        if (ASSET) vaultDisplay.setAsset(ASSET);
        oldBalance = 0;
        isProcessing = false;
        isInitialized = false;
        lastBalance = 0;
        vaultActionTimestamps = [];
        await checkBalanceChanges();
        vaultInterval = setInterval(checkBalanceChanges, CHECK_INTERVAL);
        if (uiWidget) {
            uiWidget.setRunning(true);
            uiWidget.updateVaultCount();
        }
    }
    function stopVaultScript() {
        if (!running) return;
        running = false;
        isScriptInitialized = false;
        if (vaultInterval) clearInterval(vaultInterval);
        vaultInterval = null;
        stopApiVaultPolling();
        if (uiWidget) {
            uiWidget.setRunning(false);
            uiWidget.updateVaultCount();
        }
        logActivity(pickFlavor(FLAVOR.stop), 'info');
    }

    // --- UI Widget setup (floaty) ---
    setTimeout(() => {
        if (!uiWidget) {
            if (!vaultDisplay) vaultDisplay = new VaultDisplay();
            uiWidget = createVaultFloatyUI(
                startVaultScript,
                stopVaultScript,
                getParams,
                setParams,
                vaultDisplay,
                syncCurrency,
                fetchWalletsList,
                manualVault
            );
            vaultDisplay.setAsset(ASSET);
            refreshApiVaultBalance();
            startWagerTracking();
            updateWagerUI();
        }
    }, INIT_DELAY);

})();
