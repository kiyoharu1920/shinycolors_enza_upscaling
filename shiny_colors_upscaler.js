// ==UserScript==
// @name         シャニマス Canvas 高解像度化
// @name:en      Shiny Colors Canvas Upscaler
// @namespace    local.kiyoh.shinycolors
// @version      2.6.3
// @description  Shiny ColorsのCanvasを高解像度化します。
// @description:en Upscales the Canvas of Shiny Colors.
// @license      MIT
// @match        https://shinycolors.enza.fun/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @noframes
// @downloadURL https://update.greasyfork.org/scripts/590709/%E3%82%B7%E3%83%A3%E3%83%8B%E3%83%9E%E3%82%B9%20Canvas%20%E9%AB%98%E8%A7%A3%E5%83%8F%E5%BA%A6%E5%8C%96.user.js
// @updateURL https://update.greasyfork.org/scripts/590709/%E3%82%B7%E3%83%A3%E3%83%8B%E3%83%9E%E3%82%B9%20Canvas%20%E9%AB%98%E8%A7%A3%E5%83%8F%E5%BA%A6%E5%8C%96.meta.js
// ==/UserScript==

// @ts-check

(() => {
  "use strict";

  /** @typedef {"auto" | number} ScaleMode */
  /** @typedef {"sync" | number} FilterMode */
  /** Rendererをどの経路で取得したか。 @typedef {"ezg" | "pixi" | "none"} RendererSource */

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
  /** @typedef {Window & typeof globalThis & { ezg?: EzgApi, PIXI?: object, __shinyColorsUpscaler?: DiagnosticApi }} ShinyWindow */

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
   * @property {FilterMode} filterMode
   * @property {number | null} filterScale
   * @property {RendererSource} source
   * @property {() => ApplyResult | null} apply
   * @property {() => DiagnosticInfo} info
   */

  /**
   * 倍率適用結果。
   * @typedef {object} ApplyResult
   * @property {boolean} applied
   * @property {number} scale
   * @property {[number, number]} logical
   * @property {[number, number]} backingStore
   * @property {number=} filterScale
   */

  /**
   * DevToolsへ公開する現在の描画状態。
   * @typedef {object} DiagnosticInfo
   * @property {ScaleMode} mode
   * @property {number | null} scale
   * @property {FilterMode} filterMode
   * @property {number | null} filterScale
   * @property {number | null} rendererResolution
   * @property {[number, number] | null} logical
   * @property {[number, number] | null} backingStore
   * @property {[number, number] | null} cssSize
   * @property {number} devicePixelRatio
   * @property {RendererSource} source
   * @property {boolean} unsafeWindowGranted
   * @property {boolean} ezgVisible
   * @property {boolean} pixiVisible
   * @property {number} pixiNamespaceCount
   * @property {boolean} pixiHookInstalled
   * @property {[number, number] | null} domCanvasBackingStore
   * @property {[number, number] | null} domCanvasCssSize
   */

  /**
   * アップスケーラーの起動・適用・診断操作。
   * @typedef {object} UpscalerRuntime
   * @property {() => void} start
   * @property {(force?: boolean) => ApplyResult | null} apply
   * @property {() => DiagnosticInfo} info
   */

  /** コンソール出力を識別する接頭辞。 @type {string} */
  const LOG_PREFIX = "[shiny-colors-upscaler]";
  /** Canvas描画倍率を保存する現行キー。 @type {string} */
  const STORAGE_KEY = "canvas-render-scale";
  /** Filter解像度を保存する現行キー。 @type {string} */
  const FILTER_STORAGE_KEY = "canvas-filter-scale";
  /** 旧版のGMストレージからCanvas倍率を移行するキー。 @type {string} */
  const LEGACY_GM_KEY = "scale";
  /** 旧版のlocalStorageからCanvas倍率を移行するキー。 @type {string} */
  const LEGACY_LOCAL_STORAGE_KEY = "enzaUpscaler.mode";
  /** Canvas描画倍率を切り替えるホットキー表示名。 @type {string} */
  const HOTKEY_LABEL = "Alt+U";
  // Filter解像度のホットキー切り替えは無効化中。
  // const FILTER_HOTKEY_LABEL = "Alt+Y";
  /** Canvas描画倍率の既定値。 @type {ScaleMode} */
  const DEFAULT_MODE = 2;
  /** Filter解像度の既定値。 @type {FilterMode} */
  const DEFAULT_FILTER_MODE = 2;
  /** トーストを表示し続けるミリ秒。診断情報を読み切れる長さにする。 @type {number} */
  const TOAST_DURATION_MS = 3000;
  /** PIXI名前空間から探すRendererコンストラクタ名。 @type {readonly string[]} */
  const RENDERER_CTOR_NAMES = Object.freeze([
    "Renderer",
    "WebGLRenderer",
    "CanvasRenderer",
    "SystemRenderer",
  ]);
  /** renderを二重に包まないための目印。 @type {string} */
  const PIXI_HOOK_FLAG = "__shinyColorsUpscalerHooked";
  /** 手動選択できる共通倍率一覧。 @type {readonly number[]} */
  const MANUAL_SCALES = Object.freeze([1, 1.5, 2, 3, 4]);
  /** 手動倍率一覧の最小値。 @type {number} */
  const MIN_SCALE = MANUAL_SCALES[0];
  /** 手動倍率一覧の最大値。 @type {number} */
  const MAX_SCALE = MANUAL_SCALES[MANUAL_SCALES.length - 1];
  /** Canvas描画倍率メニューとAlt+Uの巡回順。 @type {readonly ScaleMode[]} */
  const MENU_MODES = Object.freeze(["auto", ...MANUAL_SCALES]);
  /** Filter解像度メニューの表示順。 @type {readonly FilterMode[]} */
  const FILTER_MENU_MODES = Object.freeze(["sync", ...MANUAL_SCALES]);

  /**
   * 倍率一覧を設定の唯一の基準にする。旧版の2.5x/3.5xは同距離なら低い倍率へ移行する。
   * @param {unknown} value
   * @returns {ScaleMode}
   */
  function normalizeMode(value) {
    if (typeof value === "string" && value.trim().toLowerCase() === "auto") return "auto";

    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MODE;

    return nearestManualScale(parsed);
  }

  /**
   * Filter設定を描画倍率への連動または対応倍率へ正規化する。
   * @param {unknown} value
   * @returns {FilterMode}
   */
  function normalizeFilterMode(value) {
    if (typeof value === "string" && value.trim().toLowerCase() === "sync") return "sync";

    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_FILTER_MODE;

    return nearestManualScale(parsed);
  }

  /**
   * 対応倍率のうち最も近い値を返す。同距離なら低い倍率を優先する。
   * @param {number} value
   * @returns {number}
   */
  function nearestManualScale(value) {
    return MANUAL_SCALES.reduce((nearest, candidate) =>
      Math.abs(candidate - value) < Math.abs(nearest - value) ? candidate : nearest,
    );
  }

  /**
   * CSS拡大率と端末DPRの両方を満たす最小の対応倍率を選ぶ。
   * 選択後にGPU上限を適用するため、結果は一覧外の端数になる場合がある。
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

  // Filter解像度のホットキー切り替えは無効化中。
  // function nextFilterMode(currentMode) {
  //   const normalized = normalizeFilterMode(currentMode);
  //   const currentIndex = FILTER_MENU_MODES.findIndex((candidate) => candidate === normalized);
  //   return FILTER_MENU_MODES[(currentIndex + 1) % FILTER_MENU_MODES.length];
  // }

  /**
   * 連動モードでは実際のCanvas倍率、それ以外では選択したFilter倍率を返す。
   * @param {FilterMode} filterMode
   * @param {number} renderScale
   * @returns {number}
   */
  function resolveFilterScale(filterMode, renderScale) {
    return filterMode === "sync" ? renderScale : filterMode;
  }

  /**
   * Apple系キーボードではkeyが"Dead"になる場合があるため、物理キーのcodeも許可する。
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

  // Filter解像度のホットキー切り替えは無効化中。
  // function isFilterHotkey(event) {
  //   return (
  //     event.altKey &&
  //     !event.ctrlKey &&
  //     !event.metaKey &&
  //     !event.shiftKey &&
  //     !event.repeat &&
  //     (event.code === "KeyY" || event.key.toLowerCase() === "y")
  //   );
  // }

  /**
   * 指定倍率をスクリプト上限とGPU上限へ収める。
   * @param {number} scale
   * @param {number} gpuLimitScale
   * @returns {number}
   */
  function clampScale(scale, gpuLimitScale) {
    const upper = Math.min(MAX_SCALE, Number.isFinite(gpuLimitScale) ? gpuLimitScale : MAX_SCALE);
    return Math.min(Math.max(MIN_SCALE, scale), upper > 0 ? upper : MIN_SCALE);
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
   * Renderer、描画先、入力座標変換を同じ倍率へ更新する。
   * renderer.resize()はCSSサイズも書き換えるため、呼び出し前の値を必ず復元する。
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
    if (![logicalWidth, logicalHeight].every((value) => Number.isFinite(value) && value > 0)) return null;

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
      } catch (rollbackError) {
        console.error(`${LOG_PREFIX} 倍率適用後の復元にも失敗しました。`, rollbackError);
      }
      console.warn(LOG_PREFIX + " 倍率の適用に失敗しました。", error);
      return null;
    } finally {
      // 復元用resizeまで失敗しても、画面レイアウトは必ず元に戻す。
      renderer.view.style.width = cssWidth;
      renderer.view.style.height = cssHeight;
    }
  }

  /**
   * シーン階層内のFilterだけをRenderer倍率へ同期する。
   * Texture解像度は画像データの解釈を変えるため、描画倍率の対象に含めない。
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
   * @param {FilterMode=} filterMode
   * @returns {ApplyResult | null}
   */
  function applyGameScale(game, stage, mode, devicePixelRatio, force = false, filterMode = DEFAULT_FILTER_MODE) {
    const result = applyRendererScale(game, mode, devicePixelRatio, force);
    if (!result) return null;

    const filterScale = resolveFilterScale(filterMode, result.scale);
    syncFilterResolutions(stage, filterScale);
    return { ...result, filterScale };
  }

  /**
   * GMストレージを優先し、未設定時だけlocalStorageへフォールバックする。
   * 各保存先では現行キーを旧版キーより優先し、既存利用者の設定を引き継ぐ。
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
   * Filter解像度設定を読む。未設定時は既定の2xを使う。
   * @param {ShinyWindow} targetWindow
   * @param {((key: string, defaultValue: unknown) => unknown) | undefined} getValue
   * @returns {FilterMode}
   */
  function readFilterMode(targetWindow, getValue) {
    const missing = `__missing_${Date.now()}_${Math.random()}__`;
    if (typeof getValue === "function") {
      const current = getValue(FILTER_STORAGE_KEY, missing);
      if (current !== missing) return normalizeFilterMode(current);
    }

    try {
      const currentLocal = targetWindow.localStorage?.getItem(FILTER_STORAGE_KEY);
      if (currentLocal !== null && currentLocal !== undefined) return normalizeFilterMode(currentLocal);
    } catch (error) {
      console.warn(`${LOG_PREFIX} Filter設定を読めませんでした。`, error);
    }

    return DEFAULT_FILTER_MODE;
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
   * Filter解像度設定を保存する。
   * @param {ShinyWindow} targetWindow
   * @param {FilterMode} mode
   * @param {((key: string, value: unknown) => void) | undefined} setValue
   * @returns {void}
   */
  function writeFilterMode(targetWindow, mode, setValue) {
    if (typeof setValue === "function") {
      setValue(FILTER_STORAGE_KEY, mode);
      return;
    }
    try {
      targetWindow.localStorage?.setItem(FILTER_STORAGE_KEY, String(mode));
    } catch (error) {
      console.warn(`${LOG_PREFIX} Filter設定を保存できませんでした。`, error);
    }
  }

  /**
   * 倍率選択メニューとホットキー案内をUserscript Managerへ登録する。
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
      // Userscript Managerのメニューに無効項目はないため、案内専用の空処理とする。
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
   * Filter解像度選択メニューをUserscript Managerへ登録する。
   * @param {ShinyWindow} targetWindow
   * @param {FilterMode} currentMode
   * @param {((key: string, value: unknown) => void) | undefined} setValue
   * @param {((caption: string, onClick: () => void) => unknown) | undefined} registerMenuCommand
   * @returns {void}
   */
  function registerFilterMenu(targetWindow, currentMode, setValue, registerMenuCommand) {
    if (typeof registerMenuCommand !== "function") return;

    // Filter解像度のホットキー切り替えは無効化中。
    // registerMenuCommand(`ホットキー: ${FILTER_HOTKEY_LABEL}（Filter解像度を順番に切り替え）`, () => {});

    for (const mode of FILTER_MENU_MODES) {
      const selected = mode === currentMode ? " ✓" : "";
      const label = mode === "sync" ? "Canvas倍率に連動" : `${mode}x`;
      registerMenuCommand(`Filter解像度 ${label}${selected}`, () => {
        writeFilterMode(targetWindow, mode, setValue);
        targetWindow.location.reload();
      });
    }
  }

  /**
   * ezgの代入を捕捉する。ゲーム側は代入直後にwindow.ezgをnull化するため、
   * 実体が入るまでsetterを維持し、値を受け取ってから通常のプロパティへ戻す。
   *
   * Stayのようにゲーム本体より後で実行される環境ではezgが既にnull化済みなので、
   * 「プロパティが存在する＝諦める」ではなく、再代入を待てるよう差し替える。
   * @param {ShinyWindow} targetWindow
   * @param {(value: EzgApi) => void} onAssigned
   * @returns {boolean}
   */
  function installEzgHook(targetWindow, onAssigned) {
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(targetWindow, "ezg");
    } catch (error) {
      console.warn(`${LOG_PREFIX} ezgプロパティを参照できませんでした。`, error);
      return false;
    }

    // 実体が既に入っているなら差し替えずにそのまま使う。
    if (descriptor && descriptor.value) {
      onAssigned(descriptor.value);
      return true;
    }
    if (!descriptor && targetWindow.ezg) {
      onAssigned(targetWindow.ezg);
      return true;
    }
    // 再定義できないプロパティは監視できない。
    if (descriptor && descriptor.configurable === false) return false;

    let stored = descriptor ? descriptor.value : undefined;
    try {
      Object.defineProperty(targetWindow, "ezg", {
        configurable: true,
        enumerable: true,
        get() {
          return stored;
        },
        set(value) {
          stored = value;
          // null化の再代入では監視を続け、実体が入った時点でデータプロパティへ戻す。
          if (!value) return;
          try {
            Object.defineProperty(targetWindow, "ezg", {
              configurable: true,
              enumerable: true,
              writable: true,
              value,
            });
          } catch (error) {
            console.warn(`${LOG_PREFIX} ezgプロパティを復元できませんでした。`, error);
          }
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
   * Rendererコンストラクタを持つPIXI名前空間を集める。
   * グローバル名が`PIXI`とは限らないため、無ければwindow直下を走査する。
   * getterは副作用を持ち得るので読まず、データプロパティの値だけを見る。
   * @param {ShinyWindow} targetWindow
   * @returns {object[]}
   */
  function findPixiNamespaces(targetWindow) {
    /** @type {object[]} */
    const namespaces = [];
    /**
     * @param {unknown} candidate
     * @returns {boolean}
     */
    const hasRendererCtor = (candidate) => {
      if (!candidate || typeof candidate !== "object") return false;
      return RENDERER_CTOR_NAMES.some((name) => {
        try {
          return typeof (/** @type {Record<string, unknown>} */ (candidate)[name]) === "function";
        } catch {
          return false;
        }
      });
    };

    if (hasRendererCtor(targetWindow.PIXI)) namespaces.push(/** @type {object} */ (targetWindow.PIXI));

    let names = [];
    try {
      names = Object.getOwnPropertyNames(targetWindow);
    } catch (error) {
      console.warn(`${LOG_PREFIX} グローバルを走査できませんでした。`, error);
      return namespaces;
    }

    for (const name of names) {
      if (name === "PIXI") continue;
      let value;
      try {
        // getterは副作用を避けるため呼ばない。
        const descriptor = Object.getOwnPropertyDescriptor(targetWindow, name);
        if (!descriptor || !("value" in descriptor)) continue;
        value = descriptor.value;
      } catch {
        continue;
      }
      if (hasRendererCtor(value) && !namespaces.includes(value)) namespaces.push(value);
    }

    return namespaces;
  }

  /**
   * 名前空間からrenderメソッドを持つprototypeを重複なく集める。
   * 継承したrenderは除外し、同じprototypeへの別名参照だけを重複排除する。
   * @param {object[]} namespaces
   * @returns {Record<string, unknown>[]}
   */
  function collectRenderPrototypes(namespaces) {
    /** @type {Record<string, unknown>[]} */
    const prototypes = [];
    const seenPrototypes = new Set();

    for (const namespace of namespaces) {
      for (const ctorName of RENDERER_CTOR_NAMES) {
        let prototype;
        try {
          const ctor = /** @type {Record<string, unknown>} */ (namespace)[ctorName];
          if (typeof ctor !== "function") continue;
          prototype = /** @type {Record<string, unknown>} */ (
            /** @type {{ prototype?: unknown }} */ (ctor).prototype
          );
        } catch {
          continue;
        }
        if (!prototype || typeof prototype !== "object") continue;
        // 継承したrenderを包むと基底クラス側を二重に包むため、自前のものだけを対象にする。
        if (!Object.prototype.hasOwnProperty.call(prototype, "render")) continue;
        const renderFn = prototype.render;
        if (typeof renderFn !== "function" || seenPrototypes.has(prototype)) continue;
        seenPrototypes.add(prototype);
        prototypes.push(prototype);
      }
    }

    return prototypes;
  }

  /**
   * PIXIのrenderを包み、実際に描画しているRendererとシーンを捕捉する。
   * ezgを取得できない環境でも倍率を適用するための代替経路。
   * @param {ShinyWindow} targetWindow
   * @param {(renderer: PixiRenderer, stage: PixiDisplayObject | null) => void} onCapture
   * @param {object[]=} namespaces 代入時に捕捉した名前空間。省略時はwindowを走査する。
   * @returns {boolean} フックを1つ以上設置できたか
   */
  function installPixiRendererHook(targetWindow, onCapture, namespaces = findPixiNamespaces(targetWindow)) {
    const prototypes = collectRenderPrototypes(namespaces);
    let installed = false;

    for (const prototype of prototypes) {
      if (prototype[PIXI_HOOK_FLAG] === prototype.render) {
        installed = true;
        continue;
      }
      const originalRender = /** @type {(...args: unknown[]) => unknown} */ (prototype.render);
      /**
       * @this {PixiRenderer}
       * @param {...unknown} args
       */
      const wrapped = function (...args) {
        try {
          const [displayObject, second] = args;
          // 第2引数がRenderTextureの呼び出しはオフスクリーン描画なのでシーンとして扱わない。
          const rendersToTexture =
            !!second && typeof second === "object" && "baseTexture" in /** @type {object} */ (second);
          // 画面に繋がっていないRendererは採用しない。
          const connected = this?.view?.isConnected !== false;
          if (!rendersToTexture && connected && typeof this?.resize === "function") {
            onCapture(this, /** @type {PixiDisplayObject | null} */ (displayObject) ?? null);
          }
        } catch (error) {
          // 捕捉に失敗しても描画は止めない。
          console.warn(`${LOG_PREFIX} Renderer捕捉に失敗しました。`, error);
        }
        return originalRender.apply(this, args);
      };

      try {
        prototype.render = wrapped;
        Object.defineProperty(prototype, PIXI_HOOK_FLAG, {
          configurable: true,
          enumerable: false,
          value: wrapped,
        });
        installed = true;
      } catch (error) {
        console.warn(`${LOG_PREFIX} PIXIフックを設定できませんでした。`, error);
      }
    }

    return installed;
  }

  /**
   * PIXIの各代入を捕捉する。短時間で別コピーへ上書きされても両方へフックを設置する。
   * 他スクリプトのaccessorを維持し、再定義できない場合は定期走査へ任せる。
   * @param {ShinyWindow} targetWindow
   * @param {(namespace: object) => void} onAssigned
   * @returns {boolean}
   */
  function installPixiAssignmentHook(targetWindow, onAssigned) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(targetWindow, "PIXI");
      const current = targetWindow.PIXI;
      if (current && typeof current === "object") onAssigned(current);
      if (descriptor?.configurable === false) return false;
      const accessor = descriptor && !("value" in descriptor);
      // 読み取り専用プロパティを代入可能に変えない。
      if (descriptor && (accessor ? !descriptor.set : descriptor.writable === false)) return false;
      let stored = current;
      Object.defineProperty(targetWindow, "PIXI", {
        configurable: true,
        enumerable: descriptor?.enumerable ?? true,
        get() {
          return accessor ? descriptor.get?.call(this) : stored;
        },
        set(value) {
          if (accessor) descriptor.set?.call(this, value);
          else stored = value;
          const namespace = accessor ? descriptor.get?.call(this) : stored;
          if (namespace && typeof namespace === "object") {
            // フック失敗をゲーム側の代入へ伝播させない。
            try {
              onAssigned(namespace);
            } catch (error) {
              console.warn(LOG_PREFIX + " PIXI代入の捕捉に失敗しました。", error);
            }
          }
        },
      });
      return true;
    } catch (error) {
      console.warn(LOG_PREFIX + " PIXI代入フックを設定できませんでした。", error);
      return false;
    }
  }

  /**
   * 捕捉したRendererから、ezgに依存しない最小のGame相当オブジェクトを組み立てる。
   * @param {PixiRenderer | null | undefined} renderer
   * @returns {EzgGame | null}
   */
  function createFallbackGame(renderer) {
    if (!renderer) return null;

    const resolution = Number(renderer.resolution) > 0 ? Number(renderer.resolution) : 1;
    const width = Number(renderer.screen?.width ?? Number(renderer.width ?? renderer.view?.width) / resolution);
    const height = Number(
      renderer.screen?.height ?? Number(renderer.height ?? renderer.view?.height) / resolution,
    );
    if (![width, height].every((value) => Number.isFinite(value) && value > 0)) return null;

    return { width, height, renderer };
  }

  /**
   * appがwindow.ezgをnull化した後も、代入時に捕捉した参照やPIXI経由の代替からGameを取得する。
   * Rendererを持つ候補を優先する。
   * @param {ShinyWindow} targetWindow
   * @param {EzgApi | null} capturedEzg
   * @param {EzgGame | null=} fallbackGame
   * @returns {EzgGame | null}
   */
  function resolveGame(targetWindow, capturedEzg, fallbackGame = null) {
    const candidates = [targetWindow.ezg?.game, capturedEzg?.game, fallbackGame];
    return candidates.find((candidate) =>
      candidate?.renderer?.view && candidate.renderer.view.isConnected !== false &&
      typeof candidate.renderer.resize === "function",
    ) ?? candidates.find((candidate) => candidate && !candidate.renderer) ?? null;
  }

  /**
   * appがwindow.ezgをnull化した後も、捕捉済み参照から現在のシーンを取得する。
   * @param {ShinyWindow} targetWindow
   * @param {EzgApi | null} capturedEzg
   * @param {EzgGame | null | undefined} game
   * @param {PixiDisplayObject | null=} fallbackStage
   * @returns {PixiDisplayObject | null}
   */
  function resolveStage(targetWindow, capturedEzg, game, fallbackStage = null) {
    return (
      (!game || targetWindow.ezg?.game === game ? targetWindow.ezg?.sceneManager?.stage : null) ??
      (!game || capturedEzg?.game === game ? capturedEzg?.sceneManager?.stage : null) ??
      game?._sceneManager?.stage ??
      fallbackStage ??
      null
    );
  }

  /**
   * ページのDOMから最大面積のCanvasを探す。
   * 隔離コンテキストで実行されてもDOMだけは共有されるため、
   * 「ページ変数が見えないのか」「Canvas自体が無いのか」を切り分ける材料にする。
   * @param {ShinyWindow} targetWindow
   * @returns {{ backingStore: [number, number], cssSize: [number, number] } | null}
   */
  function findDomCanvas(targetWindow) {
    /** @type {HTMLCanvasElement | null} */
    let largest = null;
    try {
      const canvases = targetWindow.document?.querySelectorAll?.("canvas");
      if (!canvases) return null;
      for (const canvas of /** @type {Iterable<HTMLCanvasElement>} */ (canvases)) {
        if (!largest || canvas.width * canvas.height > largest.width * largest.height) largest = canvas;
      }
    } catch (error) {
      console.warn(`${LOG_PREFIX} DOMからCanvasを探せませんでした。`, error);
      return null;
    }
    if (!largest) return null;

    const rect = largest.getBoundingClientRect();
    return {
      backingStore: [largest.width, largest.height],
      cssSize: [rect.width, rect.height],
    };
  }

  /**
   * DevToolsを使えない端末向けに、診断情報を1行ずつの文字列へ整形する。
   * @param {DiagnosticInfo} info
   * @returns {string}
   */
  function formatDiagnostics(info) {
    /**
     * @param {[number, number] | null} size
     * @returns {string}
     */
    const formatSize = (size) =>
      size ? `${Math.round(size[0])}×${Math.round(size[1])}` : "取得できず";
    const sourceLabel = { ezg: "ezg", pixi: "pixi", none: "未取得" }[info.source];

    return [
      `倍率: ${info.mode === "auto" ? "自動" : `${info.mode}x`} → ${info.scale ?? "-"}x`,
      `Filter: ${info.filterMode === "sync" ? "連動" : `${info.filterMode}x`} → ${info.filterScale ?? "-"}x`,
      `resolution: ${info.rendererResolution ?? "-"}`,
      `論理: ${formatSize(info.logical)}`,
      `描画: ${formatSize(info.backingStore)}`,
      `CSS: ${formatSize(info.cssSize)}`,
      `DPR: ${info.devicePixelRatio}`,
      `取得経路: ${sourceLabel}`,
      `unsafeWindow: ${info.unsafeWindowGranted ? "あり" : "なし"}`,
      `ページ変数: ezg=${info.ezgVisible ? "見える" : "見えない"} ` +
        `PIXI=${info.pixiVisible ? "見える" : "見えない"} 候補=${info.pixiNamespaceCount}`,
      `PIXIフック: ${info.pixiHookInstalled ? "設置済み" : "未設置"}`,
      `DOM Canvas: ${formatSize(info.domCanvasBackingStore)} / CSS ${formatSize(info.domCanvasCssSize)}`,
    ].join("\n");
  }

  /**
   * 端末上で状態を確認・復旧するためのメニューを登録する。
   * iPhoneではDevToolsを使えないため、再適用と診断表示をメニューから行えるようにする。
   * @param {{ apply: (force?: boolean) => ApplyResult | null, info: () => DiagnosticInfo }} runtime
   * @param {(message: string) => void} showToast
   * @param {((caption: string, onClick: () => void) => unknown) | undefined} registerMenuCommand
   * @returns {void}
   */
  function registerActionMenu(runtime, showToast, registerMenuCommand) {
    if (typeof registerMenuCommand !== "function") return;

    registerMenuCommand("現在の設定を再適用", () => {
      const result = runtime.apply(true);
      showToast(formatScaleToast(runtime.info().mode, result));
    });
    registerMenuCommand("診断情報を表示", () => {
      showToast(formatDiagnostics(runtime.info()));
    });
  }

  /**
   * 設定倍率と実際の描画結果をトースト用の文章へまとめる。
   * @param {ScaleMode} mode
   * @param {ApplyResult | null} result
   * @returns {string}
   */
  function formatScaleToast(mode, result) {
    const label = mode === "auto" ? "auto（画面に合わせる）" : `${mode}倍`;
    const actual = result
      ? `実際：${Number(result.scale.toFixed(3))}倍（${result.backingStore[0]} × ${result.backingStore[1]}px）`
      : "描画倍率を適用できません（Renderer未取得・描画待ち・適用失敗）";
    return `描画倍率：${label}\n${actual}`;
  }

  /**
   * 設定、ゲーム参照、監視状態を1つのmoduleへ集約する。
   * ブラウザ依存は引数から受け取り、起動前でも倍率適用と診断情報を検証できるようにする。
   * @param {ShinyWindow} targetWindow
   * @param {UserscriptApi} api
   * @returns {UpscalerRuntime}
   */
  function createUpscalerRuntime(targetWindow, api) {
    /** 現在選択されているCanvas描画倍率。 @type {ScaleMode} */
    let mode = readMode(targetWindow, api.GM_getValue);
    /** 現在選択されているFilter解像度。 @type {FilterMode} */
    let filterMode = readFilterMode(targetWindow, api.GM_getValue);
    /** window.ezgがnull化される前に保持した参照。 @type {EzgApi | null} */
    let capturedEzg = null;
    /** PIXIのrender経由で捕捉したRenderer。 @type {PixiRenderer | null} */
    let capturedRenderer = null;
    /** PIXIのrender経由で捕捉したシーン。 @type {PixiDisplayObject | null} */
    let capturedStage = null;
    /** PIXIフックを設置済みか。 @type {boolean} */
    let pixiHookInstalled = false;
    /** 最後に成功した倍率適用結果。 @type {ApplyResult | null} */
    let lastResult = null;
    /** 画面遷移による再生成を検出するため、現在のRendererを保持する。 @type {PixiRenderer | null} */
    let activeRenderer = null;
    /** 現在のCanvasサイズ監視。 @type {ResizeObserver | null} */
    let resizeObserver = null;
    /** 現在ResizeObserverが監視するCanvas。 @type {CanvasView | null} */
    let observedResizeView = null;
    /** Renderer捕捉の連続通知を1つの適用へまとめるフラグ。 @type {boolean} */
    let captureApplyPending = false;
    /** イベントを二重登録しないための監視済みCanvas集合。 @type {WeakSet<object>} */
    const observedViews = new WeakSet();
    /** 画面下部へ設定結果を表示する要素。 @type {HTMLDivElement | null} */
    let toastElement = null;
    /** トースト非表示タイマーの識別子。 @type {number} */
    let toastTimer = 0;
    /** 同じ状態の定期通知を抑制するための最後の表示内容。 @type {string} */
    let lastToastStatus = "";
    /** 同じruntimeの二重起動を防止するフラグ。 @type {boolean} */
    let started = false;

    /** 現在有効なゲーム参照を取得する。 @returns {EzgGame | null} */
    const currentGame = () => resolveGame(targetWindow, capturedEzg, createFallbackGame(capturedRenderer));

    /**
     * ホットキー変更結果や診断情報を画面下部へ一定時間表示する。
     * @param {string} message
     * @returns {void}
     */
    const showToast = (message) => {
      if (!targetWindow.document.body) return;
      if (!toastElement) {
        toastElement = targetWindow.document.createElement("div");
        toastElement.setAttribute("role", "status");
        toastElement.setAttribute("aria-live", "polite");
        toastElement.style.cssText =
          "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;padding:12px 18px;" +
          "background:rgba(20,20,20,.9);color:#fff;font:14px/1.5 sans-serif;" +
          "border-radius:8px;pointer-events:none;transition:opacity .3s;white-space:pre-line;" +
          "text-align:center;max-width:90vw;box-sizing:border-box;";
        targetWindow.document.body.appendChild(toastElement);
      }
      toastElement.textContent = message;
      toastElement.style.opacity = "1";
      targetWindow.clearTimeout(toastTimer);
      toastTimer = targetWindow.setTimeout(() => {
        if (toastElement) toastElement.style.opacity = "0";
      }, TOAST_DURATION_MS);
    };

    /**
     * 現在の設定をRendererとシーンへ適用する。
     * @param {boolean} [force=false] 適用済みでもRendererを再設定するか
     * @returns {ApplyResult | null}
     */
    const apply = (force = false) => {
      const game = currentGame();
      if (!game?.renderer) {
        lastResult = null;
        return null;
      }
      const stage = resolveStage(
        targetWindow, capturedEzg, game, game.renderer === capturedRenderer ? capturedStage : null,
      );
      lastResult = applyGameScale(
        game,
        stage,
        mode,
        targetWindow.devicePixelRatio || 1,
        force,
        filterMode,
      );
      // 初回適用・autoの実倍率変化も通知。同じ状態の定期適用では再表示しない。
      if (targetWindow.document.body) {
        const status = formatScaleToast(mode, lastResult);
        if (status !== lastToastStatus) {
          showToast(status);
          lastToastStatus = status;
        }
      }
      return lastResult;
    };

    /**
     * Rendererの差し替えとCanvasイベント監視を更新する。
     * @returns {boolean} Rendererが変わったか
     */
    const observeCurrentRenderer = () => {
      const renderer = currentGame()?.renderer ?? null;
      const changed = renderer !== activeRenderer;
      activeRenderer = renderer;
      const view = renderer?.view ?? null;

      // 一度監視したCanvasに戻っても、現在の監視先を再接続する。
      if (view !== observedResizeView) {
        resizeObserver?.disconnect();
        resizeObserver = null;
        observedResizeView = view;
        if (view && typeof targetWindow.ResizeObserver === "function") {
          resizeObserver = new targetWindow.ResizeObserver(() => apply(false));
          resizeObserver.observe(/** @type {Element} */ (/** @type {unknown} */ (view)));
        }
      }
      if (view && !observedViews.has(view)) {
        observedViews.add(view);
        view.addEventListener?.("webglcontextrestored", () => apply(true));
      }
      return changed;
    };

    /** 描画中のresizeを避け、連続する捕捉通知を次のタスクで一度だけ適用する。 */
    const scheduleCapturedApply = () => {
      if (captureApplyPending) return;
      captureApplyPending = true;
      targetWindow.setTimeout(() => {
        captureApplyPending = false;
        observeCurrentRenderer();
        apply(true);
      }, 0);
    };

    /**
     * PIXIのrenderから捕捉したRendererとシーンを保存する。
     * 毎フレーム呼ばれるため、Rendererが変わったときだけ適用処理へ進む。
     * @param {PixiRenderer} renderer
     * @param {PixiDisplayObject | null} stage
     * @returns {void}
     */
    const captureFromPixi = (renderer, stage) => {
      const changed = renderer !== capturedRenderer;
      capturedRenderer = renderer;
      capturedStage = stage;
      if (changed) scheduleCapturedApply();
    };

    /**
     * 現在の設定と描画サイズを診断用オブジェクトへまとめる。
     * @returns {DiagnosticInfo}
     */
    const info = () => {
      const domCanvas = findDomCanvas(targetWindow);
      const ezgGame = targetWindow.ezg?.game ?? capturedEzg?.game ?? null;
      const game = currentGame();
      const renderer = game?.renderer;
      /** @type {RendererSource} */
      const source = !renderer ? "none" : ezgGame?.renderer === renderer ? "ezg" : "pixi";
      return {
        mode,
        scale: lastResult?.scale ?? null,
        filterMode,
        filterScale: lastResult?.filterScale ?? null,
        rendererResolution: renderer?.resolution ?? null,
        logical: game ? [game.width, game.height] : null,
        backingStore: renderer?.view ? [renderer.view.width, renderer.view.height] : null,
        cssSize: renderer?.view
          ? [renderer.view.getBoundingClientRect().width, renderer.view.getBoundingClientRect().height]
          : null,
        devicePixelRatio: targetWindow.devicePixelRatio || 1,
        source,
        unsafeWindowGranted: !!api.unsafeWindow,
        ezgVisible: !!targetWindow.ezg,
        pixiVisible: !!targetWindow.PIXI,
        pixiNamespaceCount: findPixiNamespaces(targetWindow).length,
        pixiHookInstalled,
        domCanvasBackingStore: domCanvas?.backingStore ?? null,
        domCanvasCssSize: domCanvas?.cssSize ?? null,
      };
    };

    /**
     * メニュー、ゲーム参照フック、画面監視、診断APIを一度だけ登録する。
     * @returns {void}
     */
    const start = () => {
      // 二重起動はメニュー・監視・ホットキー処理を重複登録するため、同じruntimeでは一度だけ開始する。
      if (started) return;
      started = true;

      registerScaleMenu(targetWindow, mode, api.GM_setValue, api.GM_registerMenuCommand);
      registerFilterMenu(targetWindow, filterMode, api.GM_setValue, api.GM_registerMenuCommand);
      registerActionMenu({ apply, info }, showToast, api.GM_registerMenuCommand);
      installEzgHook(targetWindow, (ezg) => {
        // ゲーム側はwindow.ezgを同期的にnull化するため、タイマーへ渡す前に参照を保持する。
        capturedEzg = ezg;
        scheduleCapturedApply();
      });
      // ezgを取得できない環境（Stayのようにゲーム本体より後で実行される場合）の代替経路。
      installPixiAssignmentHook(targetWindow, (namespace) => {
        pixiHookInstalled = installPixiRendererHook(targetWindow, captureFromPixi, [namespace]) || pixiHookInstalled;
      });
      pixiHookInstalled = installPixiRendererHook(targetWindow, captureFromPixi) || pixiHookInstalled;

      targetWindow.addEventListener("resize", () => targetWindow.setTimeout(() => apply(false), 250));
      targetWindow.addEventListener("orientationchange", () => targetWindow.setTimeout(() => apply(true), 400));
      targetWindow.addEventListener(
        "keydown",
        (event) => {
          // Filter解像度のホットキー切り替えは無効化中。
          // const changesFilterScale = isFilterHotkey(event);
          if (!isUpscalerHotkey(event)) return;
          event.preventDefault();
          event.stopPropagation();
          mode = nextMode(mode);
          writeMode(targetWindow, mode, api.GM_setValue);
          const result = apply(true);
          showToast(formatScaleToast(mode, result));

          // Filter解像度のホットキー切り替えは無効化中。
          // filterMode = nextFilterMode(filterMode);
          // writeFilterMode(targetWindow, filterMode, api.GM_setValue);
          // const filterResult = apply(false);
          // const filterLabel = filterMode === "sync" ? "Canvas倍率に連動" : `${filterMode}x`;
          // showToast(`Filter解像度: ${filterLabel} → ${filterResult?.filterScale ?? "-"}x`);
        },
        true,
      );
      targetWindow.setInterval(() => {
        // 別名の追加、コンストラクタの後付け、renderの再定義も継続して追跡する。
        pixiHookInstalled = installPixiRendererHook(targetWindow, captureFromPixi) || pixiHookInstalled;
        const changed = observeCurrentRenderer();
        apply(changed);
      }, 1000);

      targetWindow.__shinyColorsUpscaler = {
        get mode() {
          return mode;
        },
        get scale() {
          return lastResult?.scale ?? null;
        },
        get filterMode() {
          return filterMode;
        },
        get filterScale() {
          return lastResult?.filterScale ?? null;
        },
        get source() {
          return info().source;
        },
        apply: () => apply(true),
        info,
      };
    };

    return { apply, info, start };
  }

  /**
   * Userscript Managerの実行環境を選び、runtimeを起動する。
   * @returns {void}
   */
  function main() {
    /** @type {UserscriptApi} */
    const globalApi = /** @type {UserscriptApi} */ (/** @type {unknown} */ (globalThis));
    /** @type {UserscriptApi} */
    const injectedApi = {};
    // StayはGM APIとunsafeWindowをglobalThisのプロパティではなく、外側のスコープへ変数として注入する。
    // @ts-ignore Userscript Managerが実行時に注入する識別子。
    if (typeof unsafeWindow !== "undefined") injectedApi.unsafeWindow = unsafeWindow;
    // @ts-ignore Userscript Managerが実行時に注入する識別子。
    if (typeof GM_getValue !== "undefined") injectedApi.GM_getValue = GM_getValue;
    // @ts-ignore Userscript Managerが実行時に注入する識別子。
    if (typeof GM_setValue !== "undefined") injectedApi.GM_setValue = GM_setValue;
    // @ts-ignore Userscript Managerが実行時に注入する識別子。
    if (typeof GM_registerMenuCommand !== "undefined") {
      // @ts-ignore Userscript Managerが実行時に注入する識別子。
      injectedApi.GM_registerMenuCommand = GM_registerMenuCommand;
    }
    const api = {
      unsafeWindow: injectedApi.unsafeWindow ?? globalApi.unsafeWindow,
      GM_getValue: injectedApi.GM_getValue ?? globalApi.GM_getValue,
      GM_setValue: injectedApi.GM_setValue ?? globalApi.GM_setValue,
      GM_registerMenuCommand: injectedApi.GM_registerMenuCommand ?? globalApi.GM_registerMenuCommand,
    };
    /** @type {ShinyWindow} */
    const targetWindow = api.unsafeWindow || window;
    createUpscalerRuntime(targetWindow, api).start();
  }

  if (typeof module === "object" && module.exports) {
    module.exports = {
      applyGameScale,
      applyRendererScale,
      clampScale,
      collectRenderPrototypes,
      computeAutoScale,
      createFallbackGame,
      createUpscalerRuntime,
      findDomCanvas,
      findPixiNamespaces,
      formatDiagnostics,
      formatScaleToast,
      getGpuScaleLimit,
      // isFilterHotkey,
      installEzgHook,
      installPixiAssignmentHook,
      installPixiRendererHook,
      isUpscalerHotkey,
      // nextFilterMode,
      nextMode,
      normalizeFilterMode,
      normalizeMode,
      readFilterMode,
      readMode,
      registerActionMenu,
      registerFilterMenu,
      registerScaleMenu,
      resolveFilterScale,
      resolveGame,
      resolveScale,
      resolveStage,
      syncFilterResolutions,
    };
    return;
  }

  main();
})();
