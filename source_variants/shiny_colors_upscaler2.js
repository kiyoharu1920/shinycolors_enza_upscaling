// ==UserScript==
// @name         シャニマス(enza) Canvas 高解像度化
// @name:en      Shiny Colors (enza) canvas upscaler
// @namespace    https://shinycolors.enza.fun/
// @version      1.0.0
// @description  PixiJS の描画解像度(settings.RESOLUTION)を引き上げ、1136x640 固定だった canvas のバックバッファを実表示ピクセルに合わせて拡大する
// @author       -
// @match        https://shinycolors.enza.fun/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @noframes
// ==/UserScript==

/*
 * 仕組み
 * ------
 * このゲームは PixiJS 4.7.0 製で、enza-game.min.js が読み込まれた時点で
 *   game = new Game()  ->  new PIXI.WebGLRenderer(1136, 640, {preserveDrawingBuffer:true})
 * を即時実行する。renderer の解像度は PIXI.settings.RESOLUTION (既定 1) で決まるため、
 * canvas のバックバッファは常に 1136x640。CSS 側は Resolution(CONTAIN_WINDOW) が
 * ウィンドウ一杯まで引き伸ばすので、PC の大画面ではブラウザによる拡大でボケる。
 *
 * そこで renderer 生成より前に settings.RESOLUTION を上げる。フックできる唯一の地点が
 * pixi 本体モジュール末尾の `window.PIXI = <namespace>` 代入なので、そこに setter を仕掛ける。
 * (この代入は Game のコンストラクタより確実に先に走る)
 *
 * なお window.PIXI は 2 回、別々の PixiJS コピーで代入される:
 *   1) enza-game.min.js  … renderer / シーン描画に使われる本体
 *   2) pixi-ae.min.js    … AfterEffects 用に自前の pixi を同梱しており、後から上書きする
 * どちらにも同じ設定を入れる。
 */

(function () {
  'use strict';

  // ------------------------------------------------------------------
  // 設定
  // ------------------------------------------------------------------
  var DEFAULT_SCALE = 'auto'; // 'auto' または 1〜MAX_SCALE の数値
  var MAX_SCALE = 4;          // auto の上限。重い場合は 2 などに下げる

  var BASE_W = 1136;
  var BASE_H = 640;
  var ASPECT = BASE_W / BASE_H;

  var W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;
  var hasGM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';

  function readSetting() {
    if (!hasGM) return DEFAULT_SCALE;
    var v = GM_getValue('scale', DEFAULT_SCALE);
    return v === 'auto' || (typeof v === 'number' && v > 0) ? v : DEFAULT_SCALE;
  }

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  /**
   * canvas は CONTAIN_WINDOW なので表示高さ = min(innerHeight, innerWidth / アスペクト)。
   * 実デバイスピクセルでの高さを 640 で割った値が「ボケない解像度」になる。
   * 途中で全画面にされても足りるよう、現在のウィンドウと画面サイズの大きい方で見積もる。
   */
  function autoScale() {
    var dpr = W.devicePixelRatio || 1;
    var scr = W.screen || {};
    var nowH = Math.min(W.innerHeight || 0, (W.innerWidth || 0) / ASPECT);
    var maxH = Math.min(scr.height || 0, (scr.width || 0) / ASPECT);
    var need = (Math.max(nowH, maxH) * dpr) / BASE_H;
    if (!isFinite(need) || need <= 0) return 1;
    return clamp(Math.ceil(need * 2) / 2, 1, MAX_SCALE); // 0.5 刻みで切り上げ
  }

  var setting = readSetting();
  var SCALE = setting === 'auto' ? autoScale() : clamp(setting, 1, MAX_SCALE);

  // ------------------------------------------------------------------
  // テクスチャ側の巻き添えを防ぐガード
  // ------------------------------------------------------------------
  // PixiJS v4 の BaseTexture は解像度未指定だと settings.RESOLUTION を採用し、
  // 論理サイズを realWidth / resolution で算出する。画像 URL 経由 (fromImage) や
  // スプライトシート、RenderTexture、Text は解像度を明示するので影響を受けないが、
  //   - BaseTexture.fromCanvas (Texture.fromCanvas 経由。場面転換の白フェード等で使用)
  //   - BaseTexture.from(HTMLImageElement)
  //   - VideoBaseTexture (ムービー再生)
  // は既定値をそのまま拾うため、放置すると 1/SCALE のサイズで描画されてしまう。
  var patched = new WeakSet(); // 静的プロパティは継承されるのでフラグ用プロパティは使わない

  function installTextureGuards(P) {
    var BT = P.BaseTexture;
    if (BT && !patched.has(BT)) {
      patched.add(BT);

      // 既定値由来 (= SCALE と一致) のときだけ 1 に戻す。@2x 素材の指定は壊さない。
      var pin = function (bt) {
        if (bt && bt.resolution === SCALE && !/@[\d.]+x/.test(bt.imageUrl || '')) {
          bt.resolution = 1;
          if (bt.hasLoaded && bt.update) bt.update();
        }
        return bt;
      };

      var origFromCanvas = BT.fromCanvas;
      BT.fromCanvas = function (canvas, scaleMode, origin) {
        var bt = origFromCanvas.apply(this, arguments);
        // origin==='text' は PIXI.Text 内部用。Text は自前で解像度を設定するので触らない
        return origin === 'text' ? bt : pin(bt);
      };

      var origFrom = BT.from;
      BT.from = function () {
        return pin(origFrom.apply(this, arguments));
      };
    }

    var V = P.VideoBaseTexture;
    if (V && V.prototype && !patched.has(V)) {
      patched.add(V);
      var origUpdate = V.prototype.update; // BaseTexture から継承。毎フレーム呼ばれる
      V.prototype.update = function () {
        this.resolution = 1;
        return origUpdate.apply(this, arguments);
      };
      var origCanPlay = V.prototype._onCanPlay;
      if (origCanPlay) {
        V.prototype._onCanPlay = function () {
          this.resolution = 1;
          return origCanPlay.apply(this, arguments);
        };
      }
    }
  }

  // ------------------------------------------------------------------
  // window.PIXI 代入をフックして renderer 生成前に解像度を上げる
  // ------------------------------------------------------------------
  var applied = [];

  function applyTo(P) {
    if (!P || !P.settings || applied.indexOf(P) !== -1) return;
    applied.push(P);
    P.settings.RESOLUTION = SCALE;
    installTextureGuards(P);
  }

  var pixiRef;
  try {
    Object.defineProperty(W, 'PIXI', {
      configurable: true,
      enumerable: true,
      get: function () {
        return pixiRef;
      },
      set: function (v) {
        pixiRef = v; // glCore が `window.PIXI = window.PIXI || {}` をするので値は素通しする
        try {
          applyTo(v);
        } catch (e) {
          console.error('[enza-upscale] failed to apply:', e);
        }
      }
    });
  } catch (e) {
    console.error('[enza-upscale] could not hook window.PIXI:', e);
  }

  // ------------------------------------------------------------------
  // 動作確認用 / メニュー
  // ------------------------------------------------------------------
  W.__enzaUpscale = {
    scale: SCALE,
    setting: setting,
    pixiCopies: applied,
    info: function () {
      var g = W.ezg && W.ezg.game;
      var view = g && g.renderer && g.renderer.view;
      return {
        scale: SCALE,
        setting: setting,
        pixiCopies: applied.length,
        rendererResolution: g && g.renderer.resolution,
        logical: g && [g.width, g.height],
        backingStore: view && [view.width, view.height],
        cssSize: view && [view.style.width, view.style.height],
        devicePixelRatio: W.devicePixelRatio
      };
    }
  };

  if (typeof GM_registerMenuCommand === 'function' && hasGM) {
    GM_registerMenuCommand('描画倍率を変更 (現在: ' + setting + ' → ' + SCALE + 'x)', function () {
      var input = W.prompt(
        '描画倍率を入力してください。\n' +
          'auto = 画面解像度から自動 (上限 ' + MAX_SCALE + 'x)\n' +
          '1 = 元の 1136x640',
        String(setting)
      );
      if (input === null) return;
      input = input.trim();
      var next = input === 'auto' ? 'auto' : parseFloat(input);
      if (next !== 'auto' && (!isFinite(next) || next <= 0)) {
        W.alert('数値または auto を入力してください。');
        return;
      }
      GM_setValue('scale', next);
      W.location.reload();
    });
  }
})();
