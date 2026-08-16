// ==UserScript==
// @name         シャニマス Canvas 高解像度化
// @name:en      Shiny Colors Canvas Upscaler
// @namespace    local.kiyoh.shinycolors
// @version      2.3.1
// @description  Canvasを高解像度化し、Spineキャラクターだけをシャープ化します。描画倍率とFilter解像度は個別に変更できます。
// @description:en Upscales the Canvas and sharpens only Spine characters. Render and filter resolutions can be configured separately.
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
  /** @typedef {"sync" | number} FilterMode */

  /**
   * PIXI Filterのうち本スクリプトが利用する最小構造。
   * @typedef {object} PixiFilter
   * @property {number} resolution
   * @property {number} padding
   * @property {boolean} autoFit
   * @property {Record<string, unknown>} uniforms
   * @property {(filterManager: PixiFilterManager, input: PixiRenderTarget, output: unknown, clear: boolean) => void} apply
   * @property {(() => void)=} destroy
   */

  /**
   * PIXI FilterManagerの最小構造。
   * @typedef {object} PixiFilterManager
   * @property {(filter: PixiFilter, input: PixiRenderTarget, output: unknown, clear: boolean) => void} applyFilter
   */

  /**
   * Filter入力RenderTargetの最小構造。
   * @typedef {object} PixiRenderTarget
   * @property {{ width: number, height: number }} size
   * @property {number=} resolution
   */

  /**
   * PIXI Containerプロトタイプの最小構造。
   * @typedef {object} PixiContainerPrototype
   * @property {(...children: PixiDisplayObject[]) => PixiDisplayObject=} addChild
   * @property {(child: PixiDisplayObject, index: number) => PixiDisplayObject=} addChildAt
   */

  /**
   * 本スクリプトが利用するPIXI名前空間の最小構造。
   * @typedef {object} PixiNamespace
   * @property {{ prototype: PixiContainerPrototype }} Container
   * @property {new (vertexSrc?: string, fragmentSrc?: string, uniforms?: Record<string, unknown>) => PixiFilter} Filter
   */

  /**
   * このスクリプトが利用するPIXI DisplayObjectの最小構造。
   * @typedef {object} PixiDisplayObject
   * @property {ResolutionTarget[] | null=} filters
   * @property {PixiDisplayObject[] | null=} children
   * @property {object=} skeleton
   * @property {PixiDisplayObject[]=} slotContainers
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
  /** @typedef {Window & typeof globalThis & { ezg?: EzgApi, PIXI?: PixiNamespace, __shinyColorsUpscaler?: DiagnosticApi }} ShinyWindow */

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
   * @property {boolean} sharpenEnabled
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
   * @property {boolean} sharpenEnabled
   * @property {number} sharpenedSpines
   * @property {number | null} rendererResolution
   * @property {[number, number] | null} logical
   * @property {[number, number] | null} backingStore
   * @property {[number, number] | null} cssSize
   * @property {number} devicePixelRatio
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
  /** Spineシャープ化の有効状態を保存するキー。 @type {string} */
  const SHARPEN_STORAGE_KEY = "spine-sharpen-enabled";
  /** 旧版のGMストレージからCanvas倍率を移行するキー。 @type {string} */
  const LEGACY_GM_KEY = "scale";
  /** 旧版のlocalStorageからCanvas倍率を移行するキー。 @type {string} */
  const LEGACY_LOCAL_STORAGE_KEY = "enzaUpscaler.mode";
  /** Canvas描画倍率を切り替えるホットキー表示名。 @type {string} */
  const HOTKEY_LABEL = "Alt+U";
  /** Spineシャープ化を切り替えるホットキー表示名。 @type {string} */
  const SHARPEN_HOTKEY_LABEL = "Alt+S";
  // Filter解像度のホットキー切り替えは無効化中。
  // const FILTER_HOTKEY_LABEL = "Alt+Y";
  /** Canvas描画倍率の既定値。 @type {ScaleMode} */
  const DEFAULT_MODE = 2;
  /** Filter解像度の既定値。 @type {FilterMode} */
  const DEFAULT_FILTER_MODE = 2;
  /** Spineシャープ化の既定状態。 @type {boolean} */
  const DEFAULT_SHARPEN_ENABLED = true;
  /** Spineシャープ化の強度。 @type {number} */
  const SHARPEN_AMOUNT = 0.7;
  /** 本スクリプトが生成したFilterを識別するプロパティ。 @type {string} */
  const SHARPEN_FILTER_TAG = "__shinyColorsSpineSharpenFilter";
  /** PIXI ContainerプロトタイプごとのSpine追加監視。 @type {WeakMap<object, Set<(spine: PixiDisplayObject) => void>>} */
  const SPINE_ADD_HOOKS = new WeakMap();
  /** Spineの輪郭だけを補正するクランプ付きUnsharp Mask。 @type {string} */
  const SPINE_SHARPEN_FRAGMENT_SHADER = `
varying vec2 vTextureCoord;
uniform sampler2D uSampler;
uniform vec4 filterClamp;
uniform vec2 texelSize;
uniform float sharpness;

vec4 sampleClamped(vec2 offset) {
  return texture2D(uSampler, clamp(vTextureCoord + offset, filterClamp.xy, filterClamp.zw));
}

void main(void) {
  vec4 center = sampleClamped(vec2(0.0));
  vec3 surrounding = (
    sampleClamped(vec2(texelSize.x, 0.0)).rgb +
    sampleClamped(vec2(-texelSize.x, 0.0)).rgb +
    sampleClamped(vec2(0.0, texelSize.y)).rgb +
    sampleClamped(vec2(0.0, -texelSize.y)).rgb
  ) * 0.25;
  vec3 sharpened = center.rgb + sharpness * (center.rgb - surrounding);
  gl_FragColor = vec4(clamp(sharpened, vec3(0.0), vec3(center.a)), center.a);
}`;
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

    return MANUAL_SCALES.reduce((nearest, candidate) =>
      Math.abs(candidate - parsed) < Math.abs(nearest - parsed) ? candidate : nearest,
    );
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

    return MANUAL_SCALES.reduce((nearest, candidate) =>
      Math.abs(candidate - parsed) < Math.abs(nearest - parsed) ? candidate : nearest,
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

  /**
   * 保存値をSpineシャープ化の有効状態へ正規化する。
   * @param {unknown} value
   * @returns {boolean}
   */
  function normalizeSharpenEnabled(value) {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["false", "0", "off"].includes(normalized)) return false;
      if (["true", "1", "on"].includes(normalized)) return true;
    }
    return DEFAULT_SHARPEN_ENABLED;
  }

  /**
   * Apple系キーボードではkeyが"Dead"になる場合があるため、物理キーのcodeも許可する。
   * @param {Pick<KeyboardEvent, "altKey" | "ctrlKey" | "metaKey" | "shiftKey" | "repeat" | "key" | "code">} event
   * @returns {boolean}
   */
  function isSharpenHotkey(event) {
    return (
      event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      !event.repeat &&
      (event.code === "KeyS" || event.key.toLowerCase() === "s")
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
   * Spineシャープ化Filterを生成する。Filter入力の物理解像度から1pxのサンプル間隔を毎回更新する。
   * @param {PixiNamespace} pixi
   * @param {number} amount
   * @param {number} resolution
   * @returns {PixiFilter}
   */
  function createSpineSharpenFilter(pixi, amount = SHARPEN_AMOUNT, resolution = 2) {
    const filter = new pixi.Filter(undefined, SPINE_SHARPEN_FRAGMENT_SHADER, {
      sharpness: { type: "1f", value: amount },
      texelSize: { type: "v2", value: [1, 1] },
    });
    filter.resolution = resolution;
    filter.padding = 1;
    filter.autoFit = true;
    Object.defineProperty(filter, SHARPEN_FILTER_TAG, { value: true });
    filter.apply = (filterManager, input, output, clear) => {
      const inputResolution = Number(input.resolution) > 0 ? Number(input.resolution) : filter.resolution;
      const physicalWidth = Math.max(1, Number(input.size.width) * inputResolution);
      const physicalHeight = Math.max(1, Number(input.size.height) * inputResolution);
      const texelSize = /** @type {number[]} */ (filter.uniforms.texelSize);
      texelSize[0] = 1 / physicalWidth;
      texelSize[1] = 1 / physicalHeight;
      filterManager.applyFilter(filter, input, output, clear);
    };
    return filter;
  }

  /**
   * DisplayObjectがSpine本体かを、プラグイン版に依存しない実体構造で判定する。
   * @param {PixiDisplayObject | null | undefined} node
   * @returns {boolean}
   */
  function isSpineDisplayObject(node) {
    return Boolean(node?.skeleton && Array.isArray(node.slotContainers));
  }

  /**
   * Filterが本スクリプトのSpineシャープ化Filterかを判定する。
   * @param {ResolutionTarget | null | undefined} filter
   * @returns {boolean}
   */
  function isSpineSharpenFilter(filter) {
    return Boolean(filter && /** @type {Record<string, unknown>} */ (filter)[SHARPEN_FILTER_TAG]);
  }

  /**
   * Spineへシャープ化Filterだけを着脱し、ゲーム側の既存Filterは保持する。
   * @param {PixiDisplayObject} spine
   * @param {PixiNamespace | null | undefined} pixi
   * @param {boolean} enabled
   * @param {number} resolution
   * @param {number=} amount
   * @returns {boolean} 適用後にシャープ化が有効か
   */
  function setSpineSharpening(spine, pixi, enabled, resolution, amount = SHARPEN_AMOUNT) {
    if (!isSpineDisplayObject(spine)) return false;
    // nullはゲーム側がこのSpineでFilter処理を使用していない状態として尊重する。
    if (spine.filters === null) return false;

    const filters = Array.isArray(spine.filters) ? [...spine.filters] : [];
    let sharpenFilter = filters.find(isSpineSharpenFilter);
    if (!enabled) {
      if (sharpenFilter) /** @type {PixiFilter} */ (sharpenFilter).destroy?.();
      const remaining = filters.filter((filter) => filter !== sharpenFilter);
      spine.filters = remaining;
      return false;
    }
    if (!pixi?.Filter) return false;

    if (!sharpenFilter) {
      sharpenFilter = createSpineSharpenFilter(pixi, amount, resolution);
      filters.push(sharpenFilter);
      spine.filters = filters;
    } else {
      sharpenFilter.resolution = resolution;
      /** @type {PixiFilter} */ (sharpenFilter).uniforms.sharpness = amount;
    }
    return true;
  }

  /**
   * DisplayObjectを生成したPIXIコピーをプロトタイプから特定する。
   * @param {Iterable<PixiNamespace>} pixiCopies
   * @param {PixiDisplayObject} node
   * @returns {PixiNamespace | null}
   */
  function findPixiForDisplayObject(pixiCopies, node) {
    let compatibleFallback = null;
    for (const pixi of pixiCopies) {
      if (!compatibleFallback && typeof pixi.Filter === "function") compatibleFallback = pixi;
      if (pixi.Container?.prototype && Object.prototype.isPrototypeOf.call(pixi.Container.prototype, node)) return pixi;
    }
    // enza-gameとpixi-aeは別のPIXIコピーだが、同じFilter契約を利用する。
    // document-start後に残ったコピーしか参照できない場合も、互換Filterで既存Spineへ適用する。
    return compatibleFallback;
  }

  /**
   * シーン内のSpineだけへ現在のシャープ化状態を同期する。
   * @param {PixiDisplayObject | null | undefined} stage
   * @param {Iterable<PixiNamespace>} pixiCopies
   * @param {boolean} enabled
   * @param {number} resolution
   * @returns {number} シャープ化が有効なSpine数
   */
  function syncSpineSharpening(stage, pixiCopies, enabled, resolution) {
    if (!stage || !Number.isFinite(resolution) || resolution <= 0) return 0;

    const pending = [stage];
    const visited = new Set();
    let sharpened = 0;
    while (pending.length > 0) {
      const node = pending.pop();
      if (!node || visited.has(node)) continue;
      visited.add(node);

      if (isSpineDisplayObject(node)) {
        const pixi = findPixiForDisplayObject(pixiCopies, node);
        if (setSpineSharpening(node, pixi, enabled, resolution)) sharpened += 1;
      }
      if (Array.isArray(node.children)) pending.push(...node.children);
    }
    return sharpened;
  }

  /**
   * シーン内で本スクリプトのFilterが有効なSpine数を数える。
   * @param {PixiDisplayObject | null | undefined} stage
   * @returns {number}
   */
  function countSharpenedSpines(stage) {
    if (!stage) return 0;
    const pending = [stage];
    const visited = new Set();
    let count = 0;
    while (pending.length > 0) {
      const node = pending.pop();
      if (!node || visited.has(node)) continue;
      visited.add(node);
      if (isSpineDisplayObject(node) && Array.isArray(node.filters) && node.filters.some(isSpineSharpenFilter)) {
        count += 1;
      }
      if (Array.isArray(node.children)) pending.push(...node.children);
    }
    return count;
  }

  /**
   * Containerへ後から追加されるSpineを検出する。複数runtimeでも元メソッドは一度だけラップする。
   * @param {PixiNamespace} pixi
   * @param {(spine: PixiDisplayObject) => void} onSpine
   * @returns {boolean}
   */
  function installSpineAddChildHook(pixi, onSpine) {
    const prototype = pixi?.Container?.prototype;
    if (!prototype) return false;

    const existingListeners = SPINE_ADD_HOOKS.get(/** @type {object} */ (prototype));
    if (existingListeners) {
      existingListeners.add(onSpine);
      return true;
    }

    const listeners = new Set([onSpine]);
    SPINE_ADD_HOOKS.set(/** @type {object} */ (prototype), listeners);
    /** @param {PixiDisplayObject} root */
    const notifyTree = (root) => {
      const pending = [root];
      const visited = new Set();
      while (pending.length > 0) {
        const node = pending.pop();
        if (!node || visited.has(node)) continue;
        visited.add(node);
        if (isSpineDisplayObject(node)) {
          for (const listener of listeners) {
            try {
              listener(node);
            } catch (error) {
              console.warn(`${LOG_PREFIX} Spineシャープ化の適用に失敗しました。`, error);
            }
          }
        }
        if (Array.isArray(node.children)) pending.push(...node.children);
      }
    };

    if (typeof prototype.addChild === "function") {
      const originalAddChild = prototype.addChild;
      prototype.addChild = function (...children) {
        const result = originalAddChild.apply(this, children);
        children.forEach(notifyTree);
        return result;
      };
    }
    if (typeof prototype.addChildAt === "function") {
      const originalAddChildAt = prototype.addChildAt;
      prototype.addChildAt = function (child, index) {
        const result = originalAddChildAt.call(this, child, index);
        notifyTree(child);
        return result;
      };
    }
    return true;
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
   * Filter解像度設定を読む。未設定時はCanvas倍率への連動を使う。
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
   * Spineシャープ化設定を読む。未設定時は有効にする。
   * @param {ShinyWindow} targetWindow
   * @param {((key: string, defaultValue: unknown) => unknown) | undefined} getValue
   * @returns {boolean}
   */
  function readSharpenEnabled(targetWindow, getValue) {
    const missing = `__missing_${Date.now()}_${Math.random()}__`;
    if (typeof getValue === "function") {
      const current = getValue(SHARPEN_STORAGE_KEY, missing);
      if (current !== missing) return normalizeSharpenEnabled(current);
    }

    try {
      const currentLocal = targetWindow.localStorage?.getItem(SHARPEN_STORAGE_KEY);
      if (currentLocal !== null && currentLocal !== undefined) return normalizeSharpenEnabled(currentLocal);
    } catch (error) {
      console.warn(`${LOG_PREFIX} Spineシャープ化設定を読めませんでした。`, error);
    }
    return DEFAULT_SHARPEN_ENABLED;
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
   * Spineシャープ化設定を保存する。
   * @param {ShinyWindow} targetWindow
   * @param {boolean} enabled
   * @param {((key: string, value: unknown) => void) | undefined} setValue
   * @returns {void}
   */
  function writeSharpenEnabled(targetWindow, enabled, setValue) {
    if (typeof setValue === "function") {
      setValue(SHARPEN_STORAGE_KEY, enabled);
      return;
    }
    try {
      targetWindow.localStorage?.setItem(SHARPEN_STORAGE_KEY, String(enabled));
    } catch (error) {
      console.warn(`${LOG_PREFIX} Spineシャープ化設定を保存できませんでした。`, error);
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
   * Filter解像度選択メニューをTampermonkeyへ登録する。
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
   * Spineシャープ化の現在状態とホットキーをTampermonkeyメニューへ登録する。
   * @param {ShinyWindow} targetWindow
   * @param {boolean} enabled
   * @param {((key: string, value: unknown) => void) | undefined} setValue
   * @param {((caption: string, onClick: () => void) => unknown) | undefined} registerMenuCommand
   * @returns {void}
   */
  function registerSharpenMenu(targetWindow, enabled, setValue, registerMenuCommand) {
    if (typeof registerMenuCommand !== "function") return;
    const label = enabled ? "ON ✓" : "OFF";
    registerMenuCommand(`Spineシャープ化 ${label}（${SHARPEN_HOTKEY_LABEL}で切り替え）`, () => {
      writeSharpenEnabled(targetWindow, !enabled, setValue);
      targetWindow.location.reload();
    });
  }

  /**
   * window.PIXIへの全代入を、既存descriptorを壊さず捕捉する。
   * @param {ShinyWindow} targetWindow
   * @param {(pixi: PixiNamespace) => void} onAssigned
   * @returns {boolean}
   */
  function installPixiHook(targetWindow, onAssigned) {
    /** @param {PixiNamespace} pixi */
    const safeNotify = (pixi) => {
      try {
        onAssigned(pixi);
      } catch (error) {
        console.warn(`${LOG_PREFIX} PIXI代入通知を処理できませんでした。`, error);
      }
    };
    const descriptor = Object.getOwnPropertyDescriptor(targetWindow, "PIXI");
    if (descriptor && !descriptor.configurable) {
      if (targetWindow.PIXI) safeNotify(targetWindow.PIXI);
      return false;
    }

    const previousGet = descriptor?.get;
    const previousSet = descriptor?.set;
    let currentValue = descriptor && "value" in descriptor ? descriptor.value : targetWindow.PIXI;
    if (currentValue) safeNotify(currentValue);

    try {
      Object.defineProperty(targetWindow, "PIXI", {
        configurable: true,
        enumerable: descriptor?.enumerable ?? true,
        get() {
          return previousGet ? previousGet.call(targetWindow) : currentValue;
        },
        set(value) {
          if (previousSet) previousSet.call(targetWindow, value);
          else currentValue = value;
          const assigned = previousGet ? previousGet.call(targetWindow) : value;
          if (assigned) safeNotify(assigned);
        },
      });
      return true;
    } catch (error) {
      console.warn(`${LOG_PREFIX} PIXIフックを設定できませんでした。`, error);
      return false;
    }
  }

  /**
   * ezg初回代入を同期的に捕捉する。ゲーム側が直後にwindow.ezgをnull化するため、
   * setter内で参照を退避してから通常の書き換え可能プロパティへ戻す。
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
    /** Spineシャープ化の現在状態。 @type {boolean} */
    let sharpenEnabled = readSharpenEnabled(targetWindow, api.GM_getValue);
    /** window.ezgがnull化される前に保持した参照。 @type {EzgApi | null} */
    let capturedEzg = null;
    /** 最後に成功した倍率適用結果。 @type {ApplyResult | null} */
    let lastResult = null;
    /** 画面遷移による再生成を検出するため、現在のRendererを保持する。 @type {PixiRenderer | null} */
    let activeRenderer = null;
    /** 現在のCanvasサイズ監視。 @type {ResizeObserver | null} */
    let resizeObserver = null;
    /** イベントを二重登録しないための監視済みCanvas集合。 @type {WeakSet<object>} */
    const observedViews = new WeakSet();
    /** 画面左下へ設定結果を表示する要素。 @type {HTMLDivElement | null} */
    let toastElement = null;
    /** トースト非表示タイマーの識別子。 @type {number} */
    let toastTimer = 0;
    /** 同じruntimeの二重起動を防止するフラグ。 @type {boolean} */
    let started = false;
    /** ページ内で代入されたPIXIコピー。 @type {Set<PixiNamespace>} */
    const pixiCopies = new Set();

    /**
     * Spine Filterへ適用する現在の解像度を返す。
     * @returns {number}
     */
    const getSharpenResolution = () => {
      if (lastResult?.filterScale) return lastResult.filterScale;
      if (filterMode !== "sync") return filterMode;
      return lastResult?.scale ?? Number(DEFAULT_MODE);
    };

    /**
     * 現在のシーンへSpineシャープ化状態を同期する。
     * @returns {number}
     */
    const applySpineSharpening = () => {
      const game = resolveGame(targetWindow, capturedEzg);
      return syncSpineSharpening(
        resolveStage(targetWindow, capturedEzg, game),
        pixiCopies,
        sharpenEnabled,
        getSharpenResolution(),
      );
    };

    /**
     * 後から追加されたSpineへ現在設定を即時適用する。
     * @param {PixiDisplayObject} spine
     * @returns {void}
     */
    const onSpineAdded = (spine) => {
      setSpineSharpening(
        spine,
        findPixiForDisplayObject(pixiCopies, spine),
        sharpenEnabled,
        getSharpenResolution(),
      );
    };

    /**
     * 新しく公開されたPIXIコピーへSpine追加監視を設定する。
     * @param {PixiNamespace} pixi
     * @returns {void}
     */
    const onPixiAssigned = (pixi) => {
      if (!pixi?.Container?.prototype || typeof pixi.Filter !== "function") return;
      pixiCopies.add(pixi);
      installSpineAddChildHook(pixi, onSpineAdded);
      applySpineSharpening();
    };

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

    /**
     * 現在の設定をRendererとシーンへ適用する。
     * @param {boolean} [force=false] 適用済みでもRendererを再設定するか
     * @returns {ApplyResult | null}
     */
    const apply = (force = false) => {
      const game = resolveGame(targetWindow, capturedEzg);
      if (!game?.renderer) return null;
      activeRenderer = game.renderer;
      const stage = resolveStage(targetWindow, capturedEzg, game);
      lastResult = applyGameScale(
        game,
        stage,
        mode,
        targetWindow.devicePixelRatio || 1,
        force,
        filterMode,
      );
      if (lastResult) {
        syncSpineSharpening(stage, pixiCopies, sharpenEnabled, lastResult.filterScale ?? lastResult.scale);
      }
      return lastResult;
    };

    /**
     * Rendererの差し替えとCanvasイベント監視を更新する。
     * @returns {void}
     */
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

    /**
     * 現在の設定と描画サイズを診断用オブジェクトへまとめる。
     * @returns {DiagnosticInfo}
     */
    const info = () => {
      const game = resolveGame(targetWindow, capturedEzg);
      const renderer = game?.renderer;
      return {
        mode,
        scale: lastResult?.scale ?? null,
        filterMode,
        filterScale: lastResult?.filterScale ?? null,
        sharpenEnabled,
        sharpenedSpines: countSharpenedSpines(resolveStage(targetWindow, capturedEzg, game)),
        rendererResolution: renderer?.resolution ?? null,
        logical: game ? [game.width, game.height] : null,
        backingStore: renderer?.view ? [renderer.view.width, renderer.view.height] : null,
        cssSize: renderer?.view
          ? [renderer.view.getBoundingClientRect().width, renderer.view.getBoundingClientRect().height]
          : null,
        devicePixelRatio: targetWindow.devicePixelRatio || 1,
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
      registerSharpenMenu(targetWindow, sharpenEnabled, api.GM_setValue, api.GM_registerMenuCommand);
      installPixiHook(targetWindow, onPixiAssigned);
      installEzgHook(targetWindow, (ezg) => {
        // ゲーム側はwindow.ezgを同期的にnull化するため、タイマーへ渡す前に参照を保持する。
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
          const changesRenderScale = isUpscalerHotkey(event);
          const changesSharpen = isSharpenHotkey(event);
          // Filter解像度のホットキー切り替えは無効化中。
          // const changesFilterScale = isFilterHotkey(event);
          if (!changesRenderScale && !changesSharpen) return;
          event.preventDefault();
          event.stopPropagation();
          if (changesSharpen) {
            sharpenEnabled = !sharpenEnabled;
            writeSharpenEnabled(targetWindow, sharpenEnabled, api.GM_setValue);
            applySpineSharpening();
            showToast(`Spineシャープ化: ${sharpenEnabled ? "ON" : "OFF"}`);
            return;
          }
          mode = nextMode(mode);
          writeMode(targetWindow, mode, api.GM_setValue);
          const result = apply(true);
          const label = mode === "auto" ? "自動" : `${mode}x`;
          const actual = mode === "auto" && result ? ` → ${result.scale}x` : "";
          showToast(`Canvas描画倍率: ${label}${actual}`);

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
        get filterMode() {
          return filterMode;
        },
        get filterScale() {
          return lastResult?.filterScale ?? null;
        },
        get sharpenEnabled() {
          return sharpenEnabled;
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
    const api = /** @type {UserscriptApi} */ (/** @type {unknown} */ (globalThis));
    /** @type {ShinyWindow} */
    const targetWindow = api.unsafeWindow || window;
    createUpscalerRuntime(targetWindow, api).start();
  }

  if (typeof module === "object" && module.exports) {
    module.exports = {
      applyGameScale,
      applyRendererScale,
      clampScale,
      computeAutoScale,
      createSpineSharpenFilter,
      createUpscalerRuntime,
      getGpuScaleLimit,
      // isFilterHotkey,
      installEzgHook,
      installPixiHook,
      installSpineAddChildHook,
      isSharpenHotkey,
      isUpscalerHotkey,
      // nextFilterMode,
      nextMode,
      normalizeFilterMode,
      normalizeMode,
      normalizeSharpenEnabled,
      readFilterMode,
      readMode,
      readSharpenEnabled,
      registerFilterMenu,
      registerScaleMenu,
      registerSharpenMenu,
      resolveFilterScale,
      resolveGame,
      resolveScale,
      resolveStage,
      setSpineSharpening,
      syncFilterResolutions,
      syncSpineSharpening,
    };
    return;
  }

  main();
})();
