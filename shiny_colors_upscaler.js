// ==UserScript==
// @name         シャニマス Canvas 高解像度化
// @name:en      Shiny Colors Canvas Upscaler
// @namespace    local.kiyoh.shinycolors
// @version      2.1.2
// @description  PIXIの論理座標とCSS表示サイズを維持してCanvasを高解像度化します。Alt+Uで倍率を切り替えられます。
// @description:en Upscales the Canvas while preserving PIXI logical coordinates and CSS display size. Press Alt+U to change the scale.
// @license      MIT
// @match        https://shinycolors.enza.fun/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @noframes
// ==/UserScript==

// @ts-check

(() => {
  "use strict";

  /** @typedef {"auto" | number} ScaleMode */

  /**
   * このスクリプトが利用するPIXI DisplayObjectの最小構造。
   * @typedef {object} PixiDisplayObject
   * @property {ResolutionTarget[] | null=} filters
   * @property {PixiDisplayObject[] | null=} children
   */

  /**
   * 解像度を保持するPIXI内部オブジェクト。
   * @typedef {object} ResolutionTarget
   * @property {number} resolution
   */

  /**
   * このスクリプトが利用するCanvasの最小構造。
   * @typedef {object} CanvasView
   * @property {number} width
   * @property {number} height
   * @property {boolean=} isConnected
   * @property {CSSStyleDeclaration | { width: string, height: string }} style
   * @property {DOMStringMap | Record<string, string>} dataset
   * @property {() => DOMRect | { width: number, height: number }} getBoundingClientRect
   * @property {(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => void=} addEventListener
   */

  /**
   * このスクリプトが利用するPIXI Rendererの最小構造。
   * @typedef {object} PixiRenderer
   * @property {number} resolution
   * @property {number=} width
   * @property {number=} height
   * @property {{ width: number, height: number }=} screen
   * @property {ResolutionTarget=} rootRenderTarget
   * @property {{ interaction?: ResolutionTarget }=} plugins
   * @property {CanvasView} view
   * @property {{
   *   MAX_TEXTURE_SIZE?: number,
   *   MAX_RENDERBUFFER_SIZE?: number,
   *   MAX_VIEWPORT_DIMS?: number,
   *   getParameter?: (parameter: number) => number | Int32Array | number[],
   *   isContextLost?: () => boolean
   * }=} gl
   * @property {(width: number, height: number) => void} resize
   */

  /**
   * enza-gameが公開するゲーム情報。
   * @typedef {object} EzgGame
   * @property {number} width
   * @property {number} height
   * @property {PixiRenderer=} renderer
   * @property {{ stage?: PixiDisplayObject }=} _sceneManager
   */

  /** @typedef {{ game?: EzgGame, sceneManager?: { stage?: PixiDisplayObject } }} EzgApi */
  /** @typedef {Window & typeof globalThis & { ezg?: EzgApi, __shinyColorsUpscaler?: DiagnosticApi }} ShinyWindow */

  /**
   * Userscript Managerが公開するAPI。
   * @typedef {object} UserscriptApi
   * @property {ShinyWindow=} unsafeWindow
   * @property {((key: string, defaultValue: unknown) => unknown)=} GM_getValue
   * @property {((key: string, value: unknown) => void)=} GM_setValue
   * @property {((caption: string, onClick: () => void) => unknown)=} GM_registerMenuCommand
   */

  /**
   * DevToolsから参照する診断API。
   * @typedef {object} DiagnosticApi
   * @property {ScaleMode} mode
   * @property {number | null} scale
   * @property {() => ApplyResult | null} apply
   * @property {() => Record<string, unknown>} info
   */

  /**
   * 倍率適用結果。
   * @typedef {object} ApplyResult
   * @property {boolean} applied
   * @property {number} scale
   * @property {[number, number]} logical
   * @property {[number, number]} backingStore
   */

  const LOG_PREFIX = "[shiny-colors-upscaler]";
  const STORAGE_KEY = "canvas-render-scale";
  const LEGACY_GM_KEY = "scale";
  const LEGACY_LOCAL_STORAGE_KEY = "enzaUpscaler.mode";
  const HOTKEY_LABEL = "Alt+U";
  /** @type {ScaleMode} */
  const DEFAULT_MODE = 2;
  /** @type {readonly number[]} */
  const MANUAL_SCALES = Object.freeze([1, 1.5, 2, 3, 4]);
  const MIN_SCALE = MANUAL_SCALES[0];
  const MAX_SCALE = MANUAL_SCALES[MANUAL_SCALES.length - 1];
  /** @type {readonly ScaleMode[]} */
  const MENU_MODES = ["auto", ...MANUAL_SCALES];

  /**
   * 保存値を対応倍率へ正規化する。
   * @param {unknown} value
   * @returns {ScaleMode}
   */
  function normalizeMode(value) {
    if (typeof value === "string" && value.trim().toLowerCase() === "auto") return "auto";

    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MODE;

    return MANUAL_SCALES.reduce((nearest, candidate) =>
      Math.abs(candidate - parsed) < Math.abs(nearest - parsed) ? candidate : nearest,
    );
  }

  /**
   * 表示ピクセル密度を満たす自動倍率を計算する。
   * @param {number} displayWidth CSS表示幅
   * @param {number} displayHeight CSS表示高
   * @param {number} logicalWidth 論理幅
   * @param {number} logicalHeight 論理高
   * @param {number} devicePixelRatio
   * @param {number} gpuLimitScale
   * @returns {number}
   */
  function computeAutoScale(
    displayWidth,
    displayHeight,
    logicalWidth,
    logicalHeight,
    devicePixelRatio,
    gpuLimitScale,
  ) {
    if (logicalWidth <= 0 || logicalHeight <= 0) return MIN_SCALE;

    const widthRatio = displayWidth > 0 ? displayWidth / logicalWidth : 0;
    const heightRatio = displayHeight > 0 ? displayHeight / logicalHeight : 0;
    const cssRatio = Math.max(widthRatio, heightRatio, 1 / Math.max(devicePixelRatio, 1));
    const required = cssRatio * Math.max(devicePixelRatio, 1);
    const selected = MANUAL_SCALES.find((candidate) => candidate >= required) ?? MAX_SCALE;
    return clampScale(selected, gpuLimitScale);
  }

  /**
   * ホットキーで次に使う倍率を返す。
   * @param {ScaleMode} currentMode
   * @returns {ScaleMode}
   */
  function nextMode(currentMode) {
    const normalized = normalizeMode(currentMode);
    const currentIndex = MENU_MODES.findIndex((candidate) => candidate === normalized);
    return MENU_MODES[(currentIndex + 1) % MENU_MODES.length];
  }

  /**
   * Alt+Uの初回keydownか判定する。
   * @param {Pick<KeyboardEvent, "altKey" | "ctrlKey" | "metaKey" | "shiftKey" | "repeat" | "key" | "code">} event
   * @returns {boolean}
   */
  function isUpscalerHotkey(event) {
    return (
      event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      !event.repeat &&
      (event.code === "KeyU" || event.key.toLowerCase() === "u")
    );
  }

  /**
   * 指定倍率をスクリプト上限とGPU上限へ収める。
   * @param {number} scale
   * @param {number} gpuLimitScale
   * @returns {number}
   */
  function clampScale(scale, gpuLimitScale) {
    const upper = Math.min(MAX_SCALE, Number.isFinite(gpuLimitScale) ? gpuLimitScale : MAX_SCALE);
    return Math.max(MIN_SCALE, Math.min(scale, upper));
  }

  /**
   * WebGLの描画先サイズ上限から利用可能倍率を得る。
   * @param {PixiRenderer} renderer
   * @param {number} logicalWidth
   * @param {number} logicalHeight
   * @returns {number}
   */
  function getGpuScaleLimit(renderer, logicalWidth, logicalHeight) {
    const gl = renderer.gl;
    if (!gl || typeof gl.getParameter !== "function") return MAX_SCALE;

    try {
      const maxTexture = Number(gl.getParameter(/** @type {number} */ (gl.MAX_TEXTURE_SIZE)));
      const maxRenderbuffer = Number(gl.getParameter(/** @type {number} */ (gl.MAX_RENDERBUFFER_SIZE)));
      const viewport = /** @type {Int32Array | number[]} */ (
        gl.getParameter(/** @type {number} */ (gl.MAX_VIEWPORT_DIMS))
      );
      const viewportWidth = Number(viewport?.[0]);
      const viewportHeight = Number(viewport?.[1]);
      const maxWidth = Math.min(maxTexture, maxRenderbuffer, viewportWidth);
      const maxHeight = Math.min(maxTexture, maxRenderbuffer, viewportHeight);

      if (![maxWidth, maxHeight].every((value) => Number.isFinite(value) && value > 0)) return MAX_SCALE;
      return Math.min(maxWidth / logicalWidth, maxHeight / logicalHeight);
    } catch (error) {
      console.warn(`${LOG_PREFIX} GPU上限の取得に失敗しました。`, error);
      return MAX_SCALE;
    }
  }

  /**
   * Rendererと画面状態から実際の倍率を決める。
   * @param {PixiRenderer} renderer
   * @param {number} logicalWidth
   * @param {number} logicalHeight
   * @param {ScaleMode} mode
   * @param {number} devicePixelRatio
   * @returns {number}
   */
  function resolveScale(renderer, logicalWidth, logicalHeight, mode, devicePixelRatio) {
    const gpuLimit = getGpuScaleLimit(renderer, logicalWidth, logicalHeight);
    if (mode !== "auto") return clampScale(mode, gpuLimit);

    const rect = renderer.view.getBoundingClientRect();
    return computeAutoScale(
      rect.width,
      rect.height,
      logicalWidth,
      logicalHeight,
      devicePixelRatio,
      gpuLimit,
    );
  }

  /**
   * 論理サイズとCSS表示サイズを維持し、PIXI描画解像度を変更する。
   * @param {EzgGame | null | undefined} game
   * @param {ScaleMode} mode
   * @param {number} devicePixelRatio
   * @param {boolean=} force
   * @returns {ApplyResult | null}
   */
  function applyRendererScale(game, mode, devicePixelRatio, force = false) {
    const renderer = game?.renderer;
    if (!game || !renderer || typeof renderer.resize !== "function" || !renderer.view) return null;
    if (renderer.gl?.isContextLost?.()) return null;

    const logicalWidth = Number(game.width || renderer.screen?.width || renderer.width);
    const logicalHeight = Number(game.height || renderer.screen?.height || renderer.height);
    if (!(logicalWidth > 0 && logicalHeight > 0)) return null;

    const scale = resolveScale(renderer, logicalWidth, logicalHeight, mode, devicePixelRatio);
    const expectedWidth = Math.round(logicalWidth * scale);
    const expectedHeight = Math.round(logicalHeight * scale);
    const targets = [renderer, renderer.rootRenderTarget, renderer.plugins?.interaction].filter(Boolean);
    const alreadyApplied =
      Math.abs(renderer.resolution - scale) < 0.01 &&
      renderer.view.width === expectedWidth &&
      renderer.view.height === expectedHeight &&
      targets.every((target) => Math.abs(/** @type {ResolutionTarget} */ (target).resolution - scale) < 0.01);

    if (!force && alreadyApplied) {
      return {
        applied: false,
        scale,
        logical: [logicalWidth, logicalHeight],
        backingStore: [renderer.view.width, renderer.view.height],
      };
    }

    const previousResolutions = targets.map((target) => /** @type {ResolutionTarget} */ (target).resolution);
    const cssWidth = renderer.view.style.width;
    const cssHeight = renderer.view.style.height;

    try {
      targets.forEach((target) => {
        /** @type {ResolutionTarget} */ (target).resolution = scale;
      });
      renderer.resize(logicalWidth, logicalHeight);
      renderer.view.style.width = cssWidth;
      renderer.view.style.height = cssHeight;
      renderer.view.dataset.shinyColorsUpscaleMode = String(mode);
      renderer.view.dataset.shinyColorsUpscaleScale = String(scale);

      return {
        applied: true,
        scale,
        logical: [logicalWidth, logicalHeight],
        backingStore: [renderer.view.width, renderer.view.height],
      };
    } catch (error) {
      targets.forEach((target, index) => {
        /** @type {ResolutionTarget} */ (target).resolution = previousResolutions[index];
      });
      try {
        renderer.resize(logicalWidth, logicalHeight);
        renderer.view.style.width = cssWidth;
        renderer.view.style.height = cssHeight;
      } catch (rollbackError) {
        console.error(`${LOG_PREFIX} 倍率適用後の復元にも失敗しました。`, rollbackError);
      }
      console.warn(`${LOG_PREFIX} 倍率の適用に失敗しました。`, error);
      return null;
    }
  }

  /**
   * シーン階層内のFilterだけをRenderer倍率へ同期する。
   * @param {PixiDisplayObject | null | undefined} stage
   * @param {number} scale
   * @returns {number} 更新したFilter数
   */
  function syncFilterResolutions(stage, scale) {
    if (!stage || !Number.isFinite(scale) || scale <= 0) return 0;

    const pending = [stage];
    const visited = new Set();
    let updated = 0;

    while (pending.length > 0) {
      const node = pending.pop();
      if (!node || visited.has(node)) continue;
      visited.add(node);

      if (Array.isArray(node.filters)) {
        for (const filter of node.filters) {
          if (!filter || Math.abs(filter.resolution - scale) < 0.01) continue;
          filter.resolution = scale;
          updated += 1;
        }
      }
      if (Array.isArray(node.children)) pending.push(...node.children);
    }

    return updated;
  }

  /**
   * Rendererと現在のシーンFilterへ同じ倍率を適用する。
   * @param {EzgGame | null | undefined} game
   * @param {PixiDisplayObject | null | undefined} stage
   * @param {ScaleMode} mode
   * @param {number} devicePixelRatio
   * @param {boolean=} force
   * @returns {ApplyResult | null}
   */
  function applyGameScale(game, stage, mode, devicePixelRatio, force = false) {
    const result = applyRendererScale(game, mode, devicePixelRatio, force);
    if (!result) return null;

    syncFilterResolutions(stage, result.scale);
    return result;
  }

  /**
   * 利用可能な保存先から設定を読み、旧スクリプトの設定も引き継ぐ。
   * @param {ShinyWindow} targetWindow
   * @param {((key: string, defaultValue: unknown) => unknown) | undefined} getValue
   * @returns {ScaleMode}
   */
  function readMode(targetWindow, getValue) {
    const missing = `__missing_${Date.now()}_${Math.random()}__`;
    if (typeof getValue === "function") {
      const current = getValue(STORAGE_KEY, missing);
      if (current !== missing) return normalizeMode(current);

      const legacy = getValue(LEGACY_GM_KEY, missing);
      if (legacy !== missing) return normalizeMode(legacy);
    }

    try {
      const currentLocal = targetWindow.localStorage?.getItem(STORAGE_KEY);
      if (currentLocal !== null && currentLocal !== undefined) return normalizeMode(currentLocal);

      const legacyLocal = targetWindow.localStorage?.getItem(LEGACY_LOCAL_STORAGE_KEY);
      if (legacyLocal !== null && legacyLocal !== undefined) return normalizeMode(legacyLocal);
    } catch (error) {
      console.warn(`${LOG_PREFIX} localStorage設定を読めませんでした。`, error);
    }

    return DEFAULT_MODE;
  }

  /**
   * 設定を保存する。
   * @param {ShinyWindow} targetWindow
   * @param {ScaleMode} mode
   * @param {((key: string, value: unknown) => void) | undefined} setValue
   * @returns {void}
   */
  function writeMode(targetWindow, mode, setValue) {
    if (typeof setValue === "function") {
      setValue(STORAGE_KEY, mode);
      return;
    }
    try {
      targetWindow.localStorage?.setItem(STORAGE_KEY, String(mode));
    } catch (error) {
      console.warn(`${LOG_PREFIX} localStorage設定を保存できませんでした。`, error);
    }
  }

  /**
   * 倍率選択メニューとホットキー案内をTampermonkeyへ登録する。
   * ホットキー案内は情報表示専用で、選択されても設定を変更しない。
   * @param {ShinyWindow} targetWindow
   * @param {ScaleMode} currentMode
   * @param {((key: string, value: unknown) => void) | undefined} setValue
   * @param {((caption: string, onClick: () => void) => unknown) | undefined} registerMenuCommand
   * @returns {void}
   */
  function registerScaleMenu(targetWindow, currentMode, setValue, registerMenuCommand) {
    if (typeof registerMenuCommand !== "function") return;

    registerMenuCommand(`ホットキー: ${HOTKEY_LABEL}（倍率を順番に切り替え）`, () => {
      // Tampermonkeyメニューに無効項目はないため、案内専用の空処理とする。
    });

    for (const mode of MENU_MODES) {
      const selected = mode === currentMode ? " ✓" : "";
      const label = mode === "auto" ? "自動" : `${mode}x`;
      registerMenuCommand(`Canvas描画倍率 ${label}${selected}`, () => {
        writeMode(targetWindow, mode, setValue);
        targetWindow.location.reload();
      });
    }
  }

  /**
   * ezg公開時の代入を捕捉する。既存プロパティがある場合は監視処理へ任せる。
   * @param {ShinyWindow} targetWindow
   * @param {(value: EzgApi) => void} onAssigned
   * @returns {boolean}
   */
  function installEzgHook(targetWindow, onAssigned) {
    if (targetWindow.ezg) {
      onAssigned(targetWindow.ezg);
      return true;
    }

    const descriptor = Object.getOwnPropertyDescriptor(targetWindow, "ezg");
    if (descriptor) return false;

    try {
      Object.defineProperty(targetWindow, "ezg", {
        configurable: true,
        enumerable: true,
        set(value) {
          Object.defineProperty(targetWindow, "ezg", {
            configurable: true,
            enumerable: true,
            writable: true,
            value,
          });
          onAssigned(value);
        },
      });
      return true;
    } catch (error) {
      console.warn(`${LOG_PREFIX} ezgフックを設定できませんでした。`, error);
      return false;
    }
  }

  /**
   * appがwindow.ezgをnull化した後も、代入時に捕捉した参照からGameを取得する。
   * @param {ShinyWindow} targetWindow
   * @param {EzgApi | null} capturedEzg
   * @returns {EzgGame | null}
   */
  function resolveGame(targetWindow, capturedEzg) {
    return targetWindow.ezg?.game ?? capturedEzg?.game ?? null;
  }

  /**
   * appがwindow.ezgをnull化した後も、捕捉済み参照から現在のシーンを取得する。
   * @param {ShinyWindow} targetWindow
   * @param {EzgApi | null} capturedEzg
   * @param {EzgGame | null | undefined} game
   * @returns {PixiDisplayObject | null}
   */
  function resolveStage(targetWindow, capturedEzg, game) {
    return (
      targetWindow.ezg?.sceneManager?.stage ??
      capturedEzg?.sceneManager?.stage ??
      game?._sceneManager?.stage ??
      null
    );
  }

  /**
   * 保存倍率でメニュー登録、Renderer捕捉、再生成・表示サイズ変更監視を開始する。
   * @returns {void}
   */
  function main() {
    /** @type {UserscriptApi} */
    const api = /** @type {UserscriptApi} */ (/** @type {unknown} */ (globalThis));
    /** @type {ShinyWindow} */
    const targetWindow = api.unsafeWindow || window;
    let mode = readMode(targetWindow, api.GM_getValue);
    /** @type {EzgApi | null} */
    let capturedEzg = null;
    /** @type {ApplyResult | null} */
    let lastResult = null;
    /** @type {PixiRenderer | null} */
    let activeRenderer = null;
    /** @type {ResizeObserver | null} */
    let resizeObserver = null;
    const observedViews = new WeakSet();
    /** @type {HTMLDivElement | null} */
    let toastElement = null;
    let toastTimer = 0;

    /**
     * ホットキー変更結果を画面左下へ短時間表示する。
     * @param {string} message
     * @returns {void}
     */
    const showToast = (message) => {
      if (!targetWindow.document.body) return;
      if (!toastElement) {
        toastElement = targetWindow.document.createElement("div");
        toastElement.style.cssText =
          "position:fixed;left:8px;bottom:8px;z-index:2147483647;padding:6px 10px;" +
          "background:rgba(0,0,0,.72);color:#fff;font:12px/1.4 sans-serif;" +
          "border-radius:4px;pointer-events:none;transition:opacity .3s;";
        targetWindow.document.body.appendChild(toastElement);
      }
      toastElement.textContent = message;
      toastElement.style.opacity = "1";
      targetWindow.clearTimeout(toastTimer);
      toastTimer = targetWindow.setTimeout(() => {
        if (toastElement) toastElement.style.opacity = "0";
      }, 1800);
    };

    const apply = (force = false) => {
      const game = resolveGame(targetWindow, capturedEzg);
      if (!game?.renderer) return null;
      activeRenderer = game.renderer;
      lastResult = applyGameScale(
        game,
        resolveStage(targetWindow, capturedEzg, game),
        mode,
        targetWindow.devicePixelRatio || 1,
        force,
      );
      return lastResult;
    };

    const observeCurrentRenderer = () => {
      const renderer = resolveGame(targetWindow, capturedEzg)?.renderer;
      if (!renderer?.view) return;

      if (renderer !== activeRenderer) {
        activeRenderer = renderer;
        apply(true);
      }

      const viewObject = /** @type {object} */ (renderer.view);
      if (observedViews.has(viewObject)) return;
      observedViews.add(viewObject);
      renderer.view.addEventListener?.("webglcontextrestored", () => apply(true));

      if (typeof targetWindow.ResizeObserver === "function") {
        resizeObserver?.disconnect();
        resizeObserver = new targetWindow.ResizeObserver(() => apply(false));
        resizeObserver.observe(/** @type {Element} */ (/** @type {unknown} */ (renderer.view)));
      }
    };

    registerScaleMenu(targetWindow, mode, api.GM_setValue, api.GM_registerMenuCommand);
    installEzgHook(targetWindow, (ezg) => {
      // appはwindow.ezgを同期的にnull化するため、非同期処理へ入る前に参照を保持する。
      capturedEzg = ezg;
      targetWindow.setTimeout(() => {
        observeCurrentRenderer();
        apply(true);
      }, 0);
    });

    targetWindow.addEventListener("resize", () => targetWindow.setTimeout(() => apply(false), 250));
    targetWindow.addEventListener("orientationchange", () => targetWindow.setTimeout(() => apply(true), 400));
    targetWindow.addEventListener(
      "keydown",
      (event) => {
        if (!isUpscalerHotkey(event)) return;
        event.preventDefault();
        event.stopPropagation();
        mode = nextMode(mode);
        writeMode(targetWindow, mode, api.GM_setValue);
        const result = apply(true);
        const label = mode === "auto" ? "自動" : `${mode}x`;
        const actual = mode === "auto" && result ? ` → ${result.scale}x` : "";
        showToast(`Canvas描画倍率: ${label}${actual}`);
      },
      true,
    );
    targetWindow.setInterval(() => {
      observeCurrentRenderer();
      apply(false);
    }, 1000);

    targetWindow.__shinyColorsUpscaler = {
      get mode() {
        return mode;
      },
      get scale() {
        return lastResult?.scale ?? null;
      },
      apply: () => apply(true),
      info: () => {
        const game = resolveGame(targetWindow, capturedEzg);
        const renderer = game?.renderer;
        return {
          mode,
          scale: lastResult?.scale ?? null,
          rendererResolution: renderer?.resolution ?? null,
          logical: game ? [game.width, game.height] : null,
          backingStore: renderer?.view ? [renderer.view.width, renderer.view.height] : null,
          cssSize: renderer?.view
            ? [renderer.view.getBoundingClientRect().width, renderer.view.getBoundingClientRect().height]
            : null,
          devicePixelRatio: targetWindow.devicePixelRatio || 1,
        };
      },
    };
  }

  if (typeof module === "object" && module.exports) {
    module.exports = {
      applyGameScale,
      applyRendererScale,
      clampScale,
      computeAutoScale,
      getGpuScaleLimit,
      installEzgHook,
      isUpscalerHotkey,
      nextMode,
      normalizeMode,
      readMode,
      registerScaleMenu,
      resolveGame,
      resolveScale,
      resolveStage,
      syncFilterResolutions,
    };
    return;
  }

  main();
})();
