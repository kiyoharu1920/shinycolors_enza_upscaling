// ==UserScript==
// @name         シャニマス Canvas 高解像度化
// @namespace    local.kiyoh.shinycolors
// @version      1.4.2
// @description  PIXIの論理座標を変えずにCanvas描画バッファだけを高解像度化します。
// @license      MIT
// @match        https://shinycolors.enza.fun/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @downloadURL https://update.greasyfork.org/scripts/590519/%E3%82%B7%E3%83%A3%E3%83%8B%E3%83%9E%E3%82%B9%20Canvas%20%E9%AB%98%E8%A7%A3%E5%83%8F%E5%BA%A6%E5%8C%96.user.js
// @updateURL https://update.greasyfork.org/scripts/590519/%E3%82%B7%E3%83%A3%E3%83%8B%E3%83%9E%E3%82%B9%20Canvas%20%E9%AB%98%E8%A7%A3%E5%83%8F%E5%BA%A6%E5%8C%96.meta.js
// ==/UserScript==

// @ts-check

(function () {
  "use strict";

  /** @typedef {1 | 1.5 | 2 | 3 | 4} CanvasScale Canvas描画倍率 */

  /**
   * 解像度を保持するPIXI内部オブジェクト。
   * @typedef {object} ResolutionTarget
   * @property {number} resolution
   */

  /**
   * このスクリプトが利用するPIXI Rendererの最小構造。
   * @typedef {object} PixiRenderer
   * @property {number} resolution
   * @property {ResolutionTarget=} rootRenderTarget
   * @property {{ interaction?: ResolutionTarget }=} plugins
   * @property {(HTMLCanvasElement & { dataset: DOMStringMap })=} view
   * @property {(width: number, height: number) => void} resize
   */

  /**
   * enza-gameが公開するゲーム情報。
   * @typedef {object} EzgGame
   * @property {number} width
   * @property {number} height
   * @property {PixiRenderer=} renderer
   */

  /**
   * enza-gameのグローバルAPI。
   * @typedef {object} EzgApi
   * @property {EzgGame=} game
   */

  /** @typedef {Window & typeof globalThis & { ezg?: EzgApi }} ShinyWindow */

  /**
   * Tampermonkeyがユーザースクリプトへ公開するAPI。
   * @typedef {object} UserscriptApi
   * @property {ShinyWindow=} unsafeWindow
   * @property {(key: string, defaultValue: unknown) => unknown} GM_getValue
   * @property {(key: string, value: unknown) => void} GM_setValue
   * @property {(caption: string, onClick: () => void) => unknown} GM_registerMenuCommand
   */

  /** @type {UserscriptApi} */
  const userscriptApi = /** @type {UserscriptApi} */ (/** @type {unknown} */ (globalThis));

  const LOG_PREFIX = "[canvas-render-scale]";
  const STORAGE_KEY = "canvas-render-scale";
  /** @type {CanvasScale} */
  const DEFAULT_SCALE = 2;
  /** @type {readonly CanvasScale[]} */
  const ALLOWED_SCALES = [1, 1.5, 2, 3, 4];

  /**
   * 保存値を最も近い対応倍率へ丸める。
   * @param {unknown} value 保存値
   * @returns {CanvasScale} 数値化できない場合はDEFAULT_SCALE
   */
  function normalizeScale(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return DEFAULT_SCALE;

    return ALLOWED_SCALES.reduce((nearest, candidate) =>
      Math.abs(candidate - parsed) < Math.abs(nearest - parsed) ? candidate : nearest,
    );
  }

  /**
   * 論理サイズを維持したままPIXIの描画解像度を変更する。
   * 倍率の正規化は呼び出し口(main)で済ませる前提。
   * @param {EzgApi | null | undefined} ezg
   * @param {CanvasScale} scale 設定したい倍率
   * @returns {boolean} 適用できた場合はtrue
   */
  function applyRendererScale(ezg, scale) {
    const game = ezg?.game;
    const renderer = game?.renderer;
    if (!game || !renderer || typeof renderer.resize !== "function") return false;

    // Canvas本体・WebGL描画先・入力座標で同じ倍率を使い、表示とクリック位置のずれを防ぐ。
    for (const target of [renderer, renderer.rootRenderTarget, renderer.plugins?.interaction]) {
      if (target) target.resolution = scale;
    }

    renderer.resize(game.width, game.height);
    // 適用済み倍率を外部(DevTools等)から確認できるようdata属性へ残す。
    if (renderer.view) renderer.view.dataset.canvasRenderScale = String(scale);
    return true;
  }

  /**
   * 一時アクセサーを通常のezgプロパティへ戻す。
   * @param {ShinyWindow} targetWindow
   * @param {EzgApi} value
   * @returns {void}
   */
  function exposeEzgAsValue(targetWindow, value) {
    Object.defineProperty(targetWindow, "ezg", {
      configurable: true,
      enumerable: true,
      writable: true,
      value,
    });
  }

  /**
   * ezgの公開前後どちらでも描画倍率を適用できるようにする。
   * @param {ShinyWindow} targetWindow
   * @param {CanvasScale} scale
   * @returns {boolean} フックまたは倍率を適用できた場合はtrue
   */
  function installEzgHook(targetWindow, scale) {
    if (targetWindow.ezg) return applyRendererScale(targetWindow.ezg, scale);

    const descriptor = Object.getOwnPropertyDescriptor(targetWindow, "ezg");
    if (descriptor && !descriptor.configurable) {
      console.warn(`${LOG_PREFIX} ezgを再定義できないため高解像度化を中止しました。`);
      return false;
    }

    // ezgはゲーム側スクリプトが後から公開するため、最初の代入を捕捉して初期化直後に倍率を適用する。
    // getterは持たせず、公開前の参照は通常のプロパティと同じくundefinedになるようにする。
    Object.defineProperty(targetWindow, "ezg", {
      configurable: true,
      enumerable: true,
      set(value) {
        // 先に通常のプロパティへ戻し、以降のezgアクセスをゲーム側の想定どおりにする。
        exposeEzgAsValue(targetWindow, value);
        try {
          applyRendererScale(value, scale);
        } catch (error) {
          // 代入式へ例外を伝播させるとゲーム初期化ごと巻き込むため、ここで止める。
          console.warn(`${LOG_PREFIX} 倍率の適用に失敗しました。`, error);
        }
      },
    });
    return true;
  }

  /**
   * Tampermonkeyメニューへ倍率選択肢を登録する。
   * @param {ShinyWindow} targetWindow
   * @param {CanvasScale} currentScale
   * @returns {void}
   */
  function registerScaleMenu(targetWindow, currentScale) {
    for (const scale of ALLOWED_SCALES) {
      const selected = scale === currentScale ? " ✓" : "";
      userscriptApi.GM_registerMenuCommand(`Canvas描画倍率 ${scale}x${selected}`, () => {
        userscriptApi.GM_setValue(STORAGE_KEY, scale);
        targetWindow.location.reload();
      });
    }
  }

  /**
   * 保存された倍率でメニュー登録とCanvas高解像度化を行う。
   * @returns {void}
   */
  function main() {
    // unsafeWindow経由でページ本体のPIXIインスタンスへアクセスする。
    /** @type {ShinyWindow} */
    const targetWindow = userscriptApi.unsafeWindow || window;
    const scale = normalizeScale(userscriptApi.GM_getValue(STORAGE_KEY, DEFAULT_SCALE));

    registerScaleMenu(targetWindow, scale);
    installEzgHook(targetWindow, scale);
  }

  // Node.jsではブラウザ初期化を行わず、検証対象の関数だけを公開する。
  if (typeof module === "object" && module.exports) {
    module.exports = { applyRendererScale, installEzgHook, normalizeScale };
    return;
  }

  main();
})();
