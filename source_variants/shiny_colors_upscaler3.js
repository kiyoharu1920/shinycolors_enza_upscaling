// ==UserScript==
// @name         enza Canvas Upscaler (PixiJS resolution)
// @namespace    local.enza.upscaler
// @version      1.1.0
// @description  enza(シャイニーカラーズ)のPixiJS canvasを高解像度でレンダリングする
// @match        https://shinycolors.enza.fun/*
// @run-at       document-start
// @grant        none
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG = {
    // 'auto' = 表示ピクセルと1:1になる倍率を自動計算 / 数値指定も可 (2, 2.5, 3 ...)
    mode: 'auto',
    maxScale: 16,        // 上限。重い場合は 2 などに下げる
    minScale: 1,
    hotkey: 'u',        // Alt+U で倍率を切り替え
    // Alt+U で巡回する倍率。GPU上限を超える値は自動でクランプされる
    cycle: ['auto', 1, 1.5, 2, 3, 4, 6, 8],
    // PIXI.settings.RESOLUTION も引き上げる。PIXI.Text やフィルタが高精細になるが
    // RenderTexture も巨大化するためVRAM消費増。不安定なら false のまま。
    sharpText: false,
    debug: false,
  };

  const LS_KEY = 'enzaUpscaler.mode';
  const log = (...a) => CONFIG.debug && console.log('[upscaler]', ...a);

  let mode = (() => {
    const v = localStorage.getItem(LS_KEY);
    if (v === null) return CONFIG.mode;
    return v === 'auto' ? 'auto' : (parseFloat(v) || CONFIG.mode);
  })();

  let renderer = null;
  let hooking = false;
  let pixiPatched = false;

  // ---- レンダラ実体の捕捉 -------------------------------------------------
  // window.PIXI とレンダラのPIXIが別インスタンスのため prototype.render は使えない。
  // Container.prototype.renderWebGL の第一引数から実体を取得し、取得後すぐ復元する。
  function hookForRenderer() {
    if (renderer || hooking) return;
    const P = window.PIXI;
    if (!P || !P.Container || typeof P.Container.prototype.renderWebGL !== 'function') return;

    hooking = true;
    const proto = P.Container.prototype;
    const orig = proto.renderWebGL;
    let done = false;
    const restore = () => {
      if (done) return;
      done = true;
      if (proto.renderWebGL === patched) proto.renderWebGL = orig;
      hooking = false;
    };

    function patched(r) {
      if (!renderer && r && r.gl && r.view instanceof HTMLCanvasElement &&
          r.screen && typeof r.resize === 'function') {
        renderer = r;
        setTimeout(() => { restore(); onCaptured(); }, 0);
      }
      return orig.apply(this, arguments);
    }

    proto.renderWebGL = patched;
    setTimeout(restore, 15000); // 取れなければ諦めて元に戻す（次の巡回で再試行）
  }

  function onCaptured() {
    log('renderer captured', renderer.screen.width + 'x' + renderer.screen.height);
    renderer.view.addEventListener('webglcontextlost', () => { renderer = null; }, false);
    apply(true);
    toast('Upscaler: ' + describe());
  }

  // ---- 倍率計算 -----------------------------------------------------------
  function gpuLimit(R) {
    try {
      const gl = R.gl;
      return Math.min(
        gl.getParameter(gl.MAX_TEXTURE_SIZE),
        gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
        gl.getParameter(gl.MAX_VIEWPORT_DIMS)[0]
      );
    } catch (e) { return 4096; }
  }

  function computeScale(R) {
    const sw = (R.screen && R.screen.width) || R.width;
    const sh = (R.screen && R.screen.height) || R.height;
    let k;
    if (mode === 'auto') {
      const rect = R.view.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      k = rect.width > 0 ? (rect.width * dpr) / sw : dpr;
    } else {
      k = mode;
    }
    const lim = gpuLimit(R);
    k = Math.min(k, CONFIG.maxScale, lim / sw, lim / sh);
    k = Math.max(CONFIG.minScale, Math.round(k * 100) / 100);
    return k;
  }

  // ---- 適用 ---------------------------------------------------------------
  function apply(force) {
    const R = renderer;
    if (!R || !R.gl || R.gl.isContextLost() || !R.view.isConnected) return;

    const sw = (R.screen && R.screen.width) || R.width;
    const sh = (R.screen && R.screen.height) || R.height;
    const k = computeScale(R);

    if (!force &&
        Math.abs(R.resolution - k) < 0.01 &&
        R.view.width === Math.round(sw * k)) return;

    // ゲーム側が管理しているCSSサイズは絶対に変えない（表示レイアウト維持）
    const cssW = R.view.style.width;
    const cssH = R.view.style.height;

    try {
      R.resolution = k;
      if (R.rootRenderTarget) R.rootRenderTarget.resolution = k;
      // これが無いとクリック座標が倍率分ずれる
      if (R.plugins && R.plugins.interaction) R.plugins.interaction.resolution = k;
      R.resize(sw, sh);
    } catch (e) {
      console.warn('[upscaler] apply failed, reverting', e);
      try {
        R.resolution = 1;
        if (R.rootRenderTarget) R.rootRenderTarget.resolution = 1;
        if (R.plugins && R.plugins.interaction) R.plugins.interaction.resolution = 1;
        R.resize(sw, sh);
      } catch (_) {}
    }

    if (cssW) R.view.style.width = cssW;
    if (cssH) R.view.style.height = cssH;
    log('applied', k, R.view.width + 'x' + R.view.height);
  }

  // ---- PIXI 出現待ち / 巡回監視 ------------------------------------------
  function patchSettings() {
    if (pixiPatched || !CONFIG.sharpText || !window.PIXI || !PIXI.settings) return;
    pixiPatched = true;
    const k = Math.min(window.devicePixelRatio || 1, CONFIG.maxScale);
    PIXI.settings.RESOLUTION = k;
    PIXI.settings.FILTER_RESOLUTION = k;
    log('settings.RESOLUTION =', k);
  }

  setInterval(() => {
    patchSettings();
    if (!renderer) { hookForRenderer(); return; }
    if (!renderer.view.isConnected || (renderer.gl && renderer.gl.isContextLost())) {
      renderer = null;              // 画面遷移などで再生成された場合
      hookForRenderer();
      return;
    }
    apply(false);
  }, 2000);

  let rt = null;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => apply(true), 250); // ゲーム側のリサイズ処理の後に走らせる
  });
  window.addEventListener('orientationchange', () => setTimeout(() => apply(true), 400));

  // ---- 倍率切り替え -------------------------------------------------------
  const CYCLE = CONFIG.cycle;
  function describe() {
    const r = renderer;
    const s = (mode === 'auto' ? 'auto' : mode + 'x');
    return r ? s + ' → ' + r.view.width + '×' + r.view.height : s;
  }
  window.addEventListener('keydown', (e) => {
    if (!e.altKey || e.key.toLowerCase() !== CONFIG.hotkey) return;
    const i = CYCLE.findIndex(v => String(v) === String(mode));
    mode = CYCLE[(i + 1) % CYCLE.length];
    localStorage.setItem(LS_KEY, String(mode));
    apply(true);
    toast('Upscaler: ' + describe());
  });

  // ---- 簡易トースト -------------------------------------------------------
  let toastEl = null, toastTimer = null;
  function toast(msg) {
    if (!document.body) return;
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.style.cssText =
        'position:fixed;left:8px;bottom:8px;z-index:2147483647;padding:6px 10px;' +
        'background:rgba(0,0,0,.72);color:#fff;font:12px/1.4 sans-serif;' +
        'border-radius:4px;pointer-events:none;transition:opacity .3s;';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.style.opacity = '0'; }, 1800);
  }

  hookForRenderer();
})();
