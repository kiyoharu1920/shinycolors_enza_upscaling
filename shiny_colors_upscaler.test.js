"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");

const {
  applyGameScale,
  applyRendererScale,
  collectRenderPrototypes,
  computeAutoScale,
  createFallbackGame,
  createUpscalerRuntime,
  findDomCanvas,
  findPixiNamespaces,
  formatDiagnostics,
  getGpuScaleLimit,
  installEzgHook,
  installPixiRendererHook,
  isUpscalerHotkey,
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
  resolveStage,
} = require("./shiny_colors_upscaler.js");

function createRenderer(options = {}) {
  const logicalWidth = options.logicalWidth ?? 1136;
  const logicalHeight = options.logicalHeight ?? 640;
  const viewListeners = new Map();
  const view = {
    width: logicalWidth,
    height: logicalHeight,
    style: { width: "80vw", height: "auto" },
    dataset: {},
    getBoundingClientRect: () => ({
      width: options.displayWidth ?? logicalWidth,
      height: options.displayHeight ?? logicalHeight,
    }),
    addEventListener(type, listener) {
      const listeners = viewListeners.get(type) ?? [];
      listeners.push(listener);
      viewListeners.set(type, listeners);
    },
    dispatch(type, event = {}) {
      for (const listener of viewListeners.get(type) ?? []) listener(event);
    },
  };
  const renderer = {
    resolution: 1,
    rootRenderTarget: { resolution: 1 },
    plugins: { interaction: { resolution: 1 } },
    view,
    resizeCalls: 0,
    resize(width, height) {
      this.resizeCalls += 1;
      view.width = Math.round(width * this.resolution);
      view.height = Math.round(height * this.resolution);
      view.style.width = "changed-by-renderer";
      view.style.height = "changed-by-renderer";
    },
  };
  return renderer;
}

function createWindowHarness() {
  const listeners = new Map();
  const timeouts = [];
  const intervals = [];
  const resizeObservers = [];
  const appendedElements = [];
  let nextTimerId = 1;

  class FakeResizeObserver {
    constructor(callback) {
      this.callback = callback;
      this.observed = null;
      this.disconnected = false;
      resizeObservers.push(this);
    }

    observe(target) {
      this.observed = target;
    }

    disconnect() {
      this.disconnected = true;
    }
  }

  const targetWindow = {
    devicePixelRatio: 1,
    document: {
      body: {
        appendChild(element) {
          appendedElements.push(element);
        },
      },
      createElement: () => ({ style: {}, textContent: "" }),
    },
    localStorage: {
      getItem: () => null,
      setItem: () => {},
    },
    location: { reload: () => {} },
    ResizeObserver: FakeResizeObserver,
    addEventListener(type, listener) {
      const registered = listeners.get(type) ?? [];
      registered.push(listener);
      listeners.set(type, registered);
    },
    setTimeout(callback, delay) {
      const id = nextTimerId++;
      timeouts.push({ id, callback, delay, cancelled: false });
      return id;
    },
    clearTimeout(id) {
      const timer = timeouts.find((candidate) => candidate.id === id);
      if (timer) timer.cancelled = true;
    },
    setInterval(callback, delay) {
      const id = nextTimerId++;
      intervals.push({ id, callback, delay });
      return id;
    },
  };

  return {
    appendedElements,
    resizeObservers,
    targetWindow,
    dispatch(type, event = {}) {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
    runIntervals(delay) {
      for (const timer of intervals.filter((candidate) => candidate.delay === delay)) timer.callback();
    },
    runTimeouts(delay) {
      const pending = timeouts.filter((timer) => !timer.cancelled && timer.delay === delay);
      for (const timer of pending) {
        timer.cancelled = true;
        timer.callback();
      }
    },
    countListeners(type) {
      return listeners.get(type)?.length ?? 0;
    },
    countIntervals(delay) {
      return intervals.filter((timer) => timer.delay === delay).length;
    },
  };
}

test("normalizeModeはautoと対応倍率へ正規化する", () => {
  assert.equal(normalizeMode("AUTO"), "auto");
  assert.equal(normalizeMode(2.5), 2);
  assert.equal(normalizeMode(3.5), 3);
  assert.equal(normalizeMode(3.6), 4);
  assert.equal(normalizeMode(0.1), 1);
  assert.equal(normalizeMode(10), 4);
  assert.equal(normalizeMode("invalid"), 2);
});

test("normalizeFilterModeはsyncと対応倍率へ正規化する", () => {
  assert.equal(normalizeFilterMode("SYNC"), "sync");
  assert.equal(normalizeFilterMode(2.5), 2);
  assert.equal(normalizeFilterMode(3.6), 4);
  assert.equal(normalizeFilterMode("invalid"), 2);
});

test("resolveFilterScaleはsyncだけCanvas倍率へ連動する", () => {
  assert.equal(resolveFilterScale("sync", 4), 4);
  assert.equal(resolveFilterScale(2, 4), 2);
  assert.equal(resolveFilterScale(4, 2), 4);
});

test("computeAutoScaleは表示ピクセル密度を満たす対応倍率へ切り上げる", () => {
  assert.equal(computeAutoScale(1136, 640, 1136, 640, 1, 4), 1);
  assert.equal(computeAutoScale(800, 450, 1136, 640, 2, 4), 1.5);
  assert.equal(computeAutoScale(1193, 672, 1136, 640, 2, 4), 3);
  assert.equal(computeAutoScale(1704, 960, 1136, 640, 2, 4), 3);
});

test("computeAutoScaleはGPU上限で倍率を制限する", () => {
  assert.equal(computeAutoScale(2272, 1280, 1136, 640, 2, 3.25), 3.25);
});

test("getGpuScaleLimitは幅・高さの厳しい方を返す", () => {
  const values = new Map([
    [1, 4096],
    [2, 8192],
    [3, [5000, 3000]],
  ]);
  const renderer = createRenderer();
  renderer.gl = {
    MAX_TEXTURE_SIZE: 1,
    MAX_RENDERBUFFER_SIZE: 2,
    MAX_VIEWPORT_DIMS: 3,
    getParameter: (parameter) => values.get(parameter),
  };

  assert.equal(getGpuScaleLimit(renderer, 1136, 640), 4096 / 1136);
});

test("applyRendererScaleはPIXI各部を同期しCSS表示サイズを保持する", () => {
  const renderer = createRenderer();
  const result = applyRendererScale({ width: 1136, height: 640, renderer }, 2, 1);

  assert.deepEqual(result, {
    applied: true,
    scale: 2,
    logical: [1136, 640],
    backingStore: [2272, 1280],
  });
  assert.equal(renderer.resolution, 2);
  assert.equal(renderer.rootRenderTarget.resolution, 2);
  assert.equal(renderer.plugins.interaction.resolution, 2);
  assert.equal(renderer.view.style.width, "80vw");
  assert.equal(renderer.view.style.height, "auto");
  assert.equal(renderer.view.dataset.shinyColorsUpscaleScale, "2");
});

test("applyRendererScaleは適用済みならresizeを繰り返さない", () => {
  const renderer = createRenderer();
  const game = { width: 1136, height: 640, renderer };
  applyRendererScale(game, 2, 1);
  const result = applyRendererScale(game, 2, 1);

  assert.equal(result.applied, false);
  assert.equal(renderer.resizeCalls, 1);
});

test("applyGameScaleは後から追加されたシーンFilterもRenderer倍率へ同期する", () => {
  const renderer = createRenderer();
  const game = { width: 1136, height: 640, renderer };
  const baseTexture = { resolution: 1 };
  const firstFilter = { resolution: 1 };
  const stage = {
    filters: [firstFilter],
    children: [{ filters: null, children: [], texture: { baseTexture } }],
  };

  applyGameScale(game, stage, 4, 1, false, "sync");
  assert.equal(firstFilter.resolution, 4);
  assert.equal(baseTexture.resolution, 1);

  const laterFilter = { resolution: 1 };
  stage.children.push({ filters: [laterFilter], children: [] });
  const result = applyGameScale(game, stage, 4, 1, false, "sync");

  assert.equal(result.applied, false);
  assert.equal(renderer.resizeCalls, 1);
  assert.equal(laterFilter.resolution, 4);

  applyGameScale(game, stage, 1, 1, false, "sync");
  assert.equal(firstFilter.resolution, 1);
  assert.equal(laterFilter.resolution, 1);
});

test("applyGameScaleはCanvasとFilterへ異なる倍率を適用できる", () => {
  const renderer = createRenderer();
  const filter = { resolution: 1 };
  const game = { width: 1136, height: 640, renderer };
  const stage = { filters: [filter], children: [] };

  const result = applyGameScale(game, stage, 4, 1, false, 2);

  assert.equal(renderer.resolution, 4);
  assert.equal(filter.resolution, 2);
  assert.equal(result.scale, 4);
  assert.equal(result.filterScale, 2);
});

test("applyRendererScaleは失敗時に元の倍率へ戻す", () => {
  const renderer = createRenderer();
  let shouldThrow = true;
  renderer.resize = function (width, height) {
    if (shouldThrow) {
      shouldThrow = false;
      throw new Error("resize failed");
    }
    this.view.width = Math.round(width * this.resolution);
    this.view.height = Math.round(height * this.resolution);
  };

  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(applyRendererScale({ width: 1136, height: 640, renderer }, 2, 1), null);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(renderer.resolution, 1);
  assert.equal(renderer.rootRenderTarget.resolution, 1);
  assert.equal(renderer.plugins.interaction.resolution, 1);
  assert.equal(renderer.view.width, 1136);
  assert.equal(renderer.view.height, 640);
});

test("readModeは現行GM設定、旧GM設定、現行localStorage、旧localStorageの順に移行する", () => {
  const values = new Map([
    ["canvas-render-scale", "2.5"],
    ["enzaUpscaler.mode", "3"],
  ]);
  const targetWindow = { localStorage: { getItem: (key) => values.get(key) ?? null } };

  assert.equal(readMode(targetWindow, (key, fallback) => (key === "canvas-render-scale" ? 2 : fallback)), 2);
  assert.equal(readMode(targetWindow, (key, fallback) => (key === "scale" ? 1.5 : fallback)), 1.5);
  assert.equal(readMode(targetWindow, (_key, fallback) => fallback), 2);
  values.delete("canvas-render-scale");
  assert.equal(readMode(targetWindow, (_key, fallback) => fallback), 3);
});

test("readModeは保存値がなければ既定の2xを返す", () => {
  const targetWindow = { localStorage: { getItem: () => null } };

  assert.equal(readMode(targetWindow, (_key, fallback) => fallback), 2);
});

test("readFilterModeは保存値を読み、未設定時は2xを返す", () => {
  const values = new Map([["canvas-filter-scale", "2"]]);
  const targetWindow = { localStorage: { getItem: (key) => values.get(key) ?? null } };

  assert.equal(readFilterMode(targetWindow, (key, fallback) => (key === "canvas-filter-scale" ? 3 : fallback)), 3);
  assert.equal(readFilterMode(targetWindow, (_key, fallback) => fallback), 2);
  values.clear();
  assert.equal(readFilterMode(targetWindow, (_key, fallback) => fallback), 2);
});

test("registerScaleMenuはAlt+Uを案内し、案内項目の選択では何もしない", () => {
  const commands = [];
  const storedValues = [];
  let reloadCount = 0;
  const targetWindow = {
    location: { reload: () => { reloadCount += 1; } },
  };

  registerScaleMenu(
    targetWindow,
    2,
    (key, value) => storedValues.push([key, value]),
    (caption, onClick) => commands.push({ caption, onClick }),
  );

  assert.match(commands[0].caption, /Alt\+U/);
  commands[0].onClick();
  assert.deepEqual(storedValues, []);
  assert.equal(reloadCount, 0);

  const scale3Command = commands.find(({ caption }) => caption.includes("3x"));
  scale3Command.onClick();
  assert.deepEqual(storedValues, [["canvas-render-scale", 3]]);
  assert.equal(reloadCount, 1);
});

test("registerFilterMenuはFilter解像度と既定の2xを登録する", () => {
  const commands = [];
  const storedValues = [];
  let reloadCount = 0;
  const targetWindow = {
    location: { reload: () => { reloadCount += 1; } },
  };

  registerFilterMenu(
    targetWindow,
    2,
    (key, value) => storedValues.push([key, value]),
    (caption, onClick) => commands.push({ caption, onClick }),
  );

  assert.equal(commands.length, 6);
  const scale2Command = commands.find(({ caption }) => caption.includes("2x"));
  assert.match(scale2Command.caption, /2x ✓/);
  scale2Command.onClick();
  assert.deepEqual(storedValues, [["canvas-filter-scale", 2]]);
  assert.equal(reloadCount, 1);
});

test("installEzgHookは最初の代入を通知して通常プロパティへ戻す", () => {
  const targetWindow = {};
  let captured = null;
  assert.equal(installEzgHook(targetWindow, (value) => { captured = value; }), true);

  const ezg = { game: { width: 1136, height: 640 } };
  targetWindow.ezg = ezg;

  assert.equal(captured, ezg);
  assert.equal(targetWindow.ezg, ezg);
  assert.equal(Object.getOwnPropertyDescriptor(targetWindow, "ezg").writable, true);
});

test("appがwindow.ezgをnull化しても捕捉値から4xを適用できる", () => {
  const targetWindow = {};
  const renderer = createRenderer();
  const game = { width: 1136, height: 640, renderer };
  let capturedEzg = null;

  installEzgHook(targetWindow, (value) => { capturedEzg = value; });
  targetWindow.ezg = { game };
  targetWindow.ezg = null;

  const activeGame = resolveGame(targetWindow, capturedEzg);
  const result = applyRendererScale(activeGame, 4, 1);

  assert.equal(activeGame, game);
  assert.equal(result.scale, 4);
  assert.deepEqual(result.backingStore, [4544, 2560]);
});

test("appがwindow.ezgをnull化しても捕捉値からシーンを取得できる", () => {
  const targetWindow = { ezg: null };
  const stage = { filters: [{ resolution: 1 }], children: [] };
  const capturedEzg = { sceneManager: { stage } };

  assert.equal(resolveStage(targetWindow, capturedEzg, null), stage);
});

test("ブラウザ読込時はunsafeWindowを選びruntimeを自動起動する", () => {
  const pageHarness = createWindowHarness();
  const managerHarness = createWindowHarness();
  const menuCommands = [];
  const source = fs.readFileSync(require.resolve("./shiny_colors_upscaler.js"), "utf8");

  vm.runInNewContext(
    source,
    {
      console,
      window: managerHarness.targetWindow,
      unsafeWindow: pageHarness.targetWindow,
      GM_getValue: (key, fallback) => (key === "canvas-render-scale" ? 2 : fallback),
      GM_setValue: () => {},
      GM_registerMenuCommand: (caption, onClick) => menuCommands.push({ caption, onClick }),
    },
    { filename: "shiny_colors_upscaler.js" },
  );

  assert.equal(pageHarness.targetWindow.__shinyColorsUpscaler.mode, 2);
  assert.equal(pageHarness.targetWindow.__shinyColorsUpscaler.filterMode, 2);
  assert.equal(typeof pageHarness.targetWindow.__shinyColorsUpscaler.apply, "function");
  assert.equal(typeof pageHarness.targetWindow.__shinyColorsUpscaler.info, "function");
  assert.equal(pageHarness.countListeners("resize"), 1);
  assert.equal(pageHarness.countListeners("orientationchange"), 1);
  assert.equal(pageHarness.countListeners("keydown"), 1);
  assert.equal(pageHarness.countIntervals(1000), 1);
  assert.equal(menuCommands.length, 15);
  assert.match(menuCommands[0].caption, /Alt\+U/);
  assert.match(menuCommands[7].caption, /Canvas倍率に連動/);

  assert.equal(managerHarness.targetWindow.__shinyColorsUpscaler, undefined);
  assert.equal(managerHarness.countListeners("resize"), 0);
  assert.equal(managerHarness.countListeners("orientationchange"), 0);
  assert.equal(managerHarness.countListeners("keydown"), 0);
  assert.equal(managerHarness.countIntervals(1000), 0);
});

test("Stayがレキシカルに注入するGM APIで設定メニューを登録する", () => {
  const pageHarness = createWindowHarness();
  const managerHarness = createWindowHarness();
  const menuCommands = [];
  const storedValues = [];
  const source = fs.readFileSync(require.resolve("./shiny_colors_upscaler.js"), "utf8");
  const wrappedSource = `
    ((injectedApi) => {
      const unsafeWindow = injectedApi.unsafeWindow;
      const GM_getValue = injectedApi.GM_getValue;
      const GM_setValue = injectedApi.GM_setValue;
      const GM_registerMenuCommand = injectedApi.GM_registerMenuCommand;
      ${source}
    })(injectedApi);
  `;

  vm.runInNewContext(
    wrappedSource,
    {
      console,
      window: managerHarness.targetWindow,
      injectedApi: {
        unsafeWindow: pageHarness.targetWindow,
        GM_getValue: (key, fallback) => (key === "canvas-render-scale" ? 3 : fallback),
        GM_setValue: (key, value) => storedValues.push([key, value]),
        GM_registerMenuCommand: (caption, onClick) => menuCommands.push({ caption, onClick }),
      },
    },
    { filename: "stay-wrapper.js" },
  );

  assert.equal(pageHarness.targetWindow.__shinyColorsUpscaler.mode, 3);
  assert.equal(menuCommands.length, 15);
  assert.match(menuCommands[0].caption, /Alt\+U/);
  menuCommands.find(({ caption }) => caption.includes("Canvas描画倍率 4x")).onClick();
  assert.deepEqual(storedValues, [["canvas-render-scale", 4]]);
  assert.equal(managerHarness.targetWindow.__shinyColorsUpscaler, undefined);
});

test("runtimeはezg捕捉後にRenderer監視と診断APIを一括して提供する", () => {
  const harness = createWindowHarness();
  const renderer = createRenderer();
  const filter = { resolution: 1 };
  const stage = { filters: [filter], children: [] };
  const game = { width: 1136, height: 640, renderer };
  const menuCommands = [];
  const runtime = createUpscalerRuntime(harness.targetWindow, {
    GM_getValue: (key, fallback) => (key === "canvas-render-scale" ? 2 : fallback),
    GM_setValue: () => {},
    GM_registerMenuCommand: (caption, onClick) => menuCommands.push({ caption, onClick }),
  });

  runtime.start();
  runtime.start();
  harness.targetWindow.ezg = { game, sceneManager: { stage } };
  harness.targetWindow.ezg = null;
  harness.runTimeouts(0);

  assert.equal(menuCommands.length, 15);
  assert.equal(harness.countListeners("keydown"), 1);
  assert.equal(renderer.resolution, 2);
  assert.equal(renderer.rootRenderTarget.resolution, 2);
  assert.equal(renderer.plugins.interaction.resolution, 2);
  assert.equal(filter.resolution, 2);
  assert.equal(harness.resizeObservers.length, 1);
  assert.equal(harness.resizeObservers[0].observed, renderer.view);
  assert.equal(harness.targetWindow.__shinyColorsUpscaler.mode, 2);
  assert.equal(harness.targetWindow.__shinyColorsUpscaler.scale, 2);
  assert.equal(harness.targetWindow.__shinyColorsUpscaler.filterMode, 2);
  assert.equal(harness.targetWindow.__shinyColorsUpscaler.filterScale, 2);
  assert.deepEqual(harness.targetWindow.__shinyColorsUpscaler.info(), {
    mode: 2,
    scale: 2,
    filterMode: 2,
    filterScale: 2,
    rendererResolution: 2,
    logical: [1136, 640],
    backingStore: [2272, 1280],
    cssSize: [1136, 640],
    devicePixelRatio: 1,
    source: "ezg",
    // ゲーム側がwindow.ezgをnull化した後でも、捕捉済み参照で"ezg"経路を維持できている。
    unsafeWindowGranted: false,
    ezgVisible: false,
    pixiVisible: false,
    pixiNamespaceCount: 0,
    pixiHookInstalled: false,
    domCanvasBackingStore: null,
    domCanvasCssSize: null,
  });

  renderer.resolution = 1;
  renderer.rootRenderTarget.resolution = 1;
  renderer.plugins.interaction.resolution = 1;
  renderer.view.width = 1136;
  renderer.view.height = 640;
  harness.resizeObservers[0].callback();
  assert.equal(renderer.resolution, 2);

  renderer.resolution = 1;
  renderer.rootRenderTarget.resolution = 1;
  renderer.plugins.interaction.resolution = 1;
  renderer.view.dispatch("webglcontextrestored");
  assert.equal(renderer.resolution, 2);

  const replacement = createRenderer();
  game.renderer = replacement;
  harness.runIntervals(1000);
  assert.equal(replacement.resolution, 2);
  assert.equal(harness.resizeObservers.length, 2);
  assert.equal(harness.resizeObservers[0].disconnected, true);
  assert.equal(harness.resizeObservers[1].observed, replacement.view);
});

test("runtimeはAlt+Uと画面変化を同じ倍率適用処理へ集約する", () => {
  const harness = createWindowHarness();
  const renderer = createRenderer();
  const filter = { resolution: 1 };
  const game = {
    width: 1136,
    height: 640,
    renderer,
    _sceneManager: { stage: { filters: [filter], children: [] } },
  };
  const storedValues = [];
  harness.targetWindow.ezg = { game };
  const runtime = createUpscalerRuntime(harness.targetWindow, {
    GM_getValue: (key, fallback) => (key === "canvas-render-scale" ? 2 : fallback),
    GM_setValue: (key, value) => storedValues.push([key, value]),
  });

  runtime.start();
  harness.targetWindow.ezg = null;
  harness.runTimeouts(0);

  let preventDefaultCount = 0;
  let stopPropagationCount = 0;
  harness.dispatch("keydown", {
    altKey: true,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    key: "Dead",
    code: "KeyU",
    preventDefault: () => { preventDefaultCount += 1; },
    stopPropagation: () => { stopPropagationCount += 1; },
  });

  assert.deepEqual(storedValues, [["canvas-render-scale", 3]]);
  assert.equal(preventDefaultCount, 1);
  assert.equal(stopPropagationCount, 1);
  assert.equal(renderer.resolution, 3);
  assert.equal(harness.targetWindow.__shinyColorsUpscaler.mode, 3);
  assert.equal(harness.targetWindow.__shinyColorsUpscaler.scale, 3);
  assert.equal(filter.resolution, 2);
  assert.equal(harness.appendedElements[0].textContent, "Canvas描画倍率: 3x");

  renderer.resolution = 1;
  renderer.rootRenderTarget.resolution = 1;
  renderer.plugins.interaction.resolution = 1;
  renderer.view.width = 1136;
  renderer.view.height = 640;
  harness.dispatch("resize");
  assert.equal(renderer.resolution, 1);
  harness.runTimeouts(250);
  assert.equal(renderer.resolution, 3);

  const resizeCalls = renderer.resizeCalls;
  harness.dispatch("orientationchange");
  harness.runTimeouts(400);
  assert.equal(renderer.resizeCalls, resizeCalls + 1);
});

test("nextModeはauto・1・1.5・2・3・4を巡回する", () => {
  assert.equal(nextMode("auto"), 1);
  assert.equal(nextMode(1), 1.5);
  assert.equal(nextMode(1.5), 2);
  assert.equal(nextMode(2), 3);
  assert.equal(nextMode(3), 4);
  assert.equal(nextMode(4), "auto");
  assert.equal(nextMode(2.5), 3);
});

test("isUpscalerHotkeyは修飾なしのAlt+Uだけを受け付ける", () => {
  const event = {
    altKey: true,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    key: "u",
    code: "KeyU",
  };
  assert.equal(isUpscalerHotkey(event), true);
  assert.equal(isUpscalerHotkey({ ...event, key: "U" }), true);
  assert.equal(isUpscalerHotkey({ ...event, key: "Dead" }), true);
  assert.equal(isUpscalerHotkey({ ...event, repeat: true }), false);
  assert.equal(isUpscalerHotkey({ ...event, ctrlKey: true }), false);
  assert.equal(isUpscalerHotkey({ ...event, key: "x", code: "KeyX" }), false);
});

test("installEzgHookはnull化済みプロパティでも再代入を捕捉する", () => {
  const targetWindow = {};
  // ゲーム側が代入してからnull化した後の状態を再現する。
  targetWindow.ezg = { game: {} };
  targetWindow.ezg = null;

  const captured = [];
  assert.equal(installEzgHook(targetWindow, (value) => captured.push(value)), true);
  assert.equal(captured.length, 0);

  // null化の再代入では通知せず、監視を続ける。
  targetWindow.ezg = null;
  assert.equal(captured.length, 0);

  const ezg = { game: { width: 1136, height: 640 } };
  targetWindow.ezg = ezg;

  assert.deepEqual(captured, [ezg]);
  assert.equal(targetWindow.ezg, ezg);
  assert.equal(Object.getOwnPropertyDescriptor(targetWindow, "ezg").writable, true);
});

test("installEzgHookは再定義できないezgプロパティでは諦める", () => {
  const targetWindow = {};
  Object.defineProperty(targetWindow, "ezg", { configurable: false, writable: true, value: null });

  assert.equal(installEzgHook(targetWindow, () => {}), false);
});

test("findPixiNamespacesはPIXIを優先し、別名も探し、getterは読まない", () => {
  class Renderer {}
  const pixi = { Renderer };
  const aliased = { CanvasRenderer: Renderer };
  let getterCalls = 0;
  const targetWindow = { PIXI: pixi, aliased, unrelated: { draw: () => {} } };
  Object.defineProperty(targetWindow, "lazy", {
    configurable: true,
    enumerable: true,
    get() {
      getterCalls += 1;
      return { Renderer };
    },
  });
  Object.defineProperty(targetWindow, "explodes", {
    configurable: true,
    enumerable: true,
    get() {
      throw new Error("boom");
    },
  });

  assert.deepEqual(findPixiNamespaces(targetWindow), [pixi, aliased]);
  assert.equal(getterCalls, 0);
});

test("collectRenderPrototypesは継承したrenderと重複実装を除外する", () => {
  class Base {
    render() {}
  }
  class Derived extends Base {}
  const sharedRender = function () {};
  const First = function () {};
  First.prototype.render = sharedRender;
  const Second = function () {};
  Second.prototype.render = sharedRender;

  assert.deepEqual(collectRenderPrototypes([{ Renderer: Base, WebGLRenderer: Derived }]), [
    Base.prototype,
  ]);
  assert.deepEqual(collectRenderPrototypes([{ Renderer: First, CanvasRenderer: Second }]), [
    First.prototype,
  ]);
  assert.deepEqual(collectRenderPrototypes([{ Renderer: 1, SystemRenderer: undefined }]), []);
});

test("installPixiRendererHookはRendererとシーンを捕捉し、RenderTexture描画は無視する", () => {
  const originalCalls = [];
  class Renderer {
    render(displayObject, renderTexture) {
      originalCalls.push([displayObject, renderTexture]);
    }
  }
  const targetWindow = { PIXI: { Renderer } };
  const captures = [];

  assert.equal(
    installPixiRendererHook(targetWindow, (renderer, stage) => captures.push([renderer, stage])),
    true,
  );
  // 二重に包まない。
  assert.equal(installPixiRendererHook(targetWindow, () => captures.push(["second"])), true);

  const renderer = createRenderer();
  const stage = { filters: [], children: [] };
  const offscreen = createRenderer();
  offscreen.view.isConnected = false;

  Renderer.prototype.render.call(renderer, stage);
  Renderer.prototype.render.call(renderer, stage, { baseTexture: {} });
  Renderer.prototype.render.call(offscreen, stage);

  assert.equal(captures.length, 1);
  assert.deepEqual(captures[0], [renderer, stage]);
  // 元のrenderは常に呼ばれる。
  assert.equal(originalCalls.length, 3);
});

test("installPixiRendererHookは捕捉処理が例外を投げても描画を止めない", () => {
  let rendered = 0;
  class Renderer {
    render() {
      rendered += 1;
    }
  }
  const targetWindow = { PIXI: { Renderer } };
  installPixiRendererHook(targetWindow, () => {
    throw new Error("boom");
  });

  Renderer.prototype.render.call(createRenderer(), { filters: [], children: [] });
  assert.equal(rendered, 1);
});

test("createFallbackGameはscreenまたはresolutionから論理サイズを組み立てる", () => {
  const renderer = createRenderer();
  renderer.screen = { width: 1136, height: 640 };
  assert.deepEqual(createFallbackGame(renderer), { width: 1136, height: 640, renderer });

  const scaled = createRenderer();
  scaled.resolution = 2;
  scaled.view.width = 2272;
  scaled.view.height = 1280;
  assert.deepEqual(createFallbackGame(scaled), { width: 1136, height: 640, renderer: scaled });

  assert.equal(createFallbackGame(null), null);
});

test("resolveGameとresolveStageはRendererを持つ候補と代替シーンを使う", () => {
  const renderer = createRenderer();
  const fallbackGame = { width: 1136, height: 640, renderer };
  const bareGame = { width: 1136, height: 640 };
  const fallbackStage = { filters: [], children: [] };

  assert.equal(resolveGame({ ezg: { game: bareGame } }, null, fallbackGame), fallbackGame);
  assert.equal(resolveGame({}, null, null), null);
  assert.equal(resolveStage({}, null, null, fallbackStage), fallbackStage);
});

test("formatDiagnosticsは取得経路と描画サイズを含む要約を返す", () => {
  const info = {
    mode: "auto",
    scale: 2,
    filterMode: "sync",
    filterScale: 2,
    rendererResolution: 2,
    logical: [1136, 640],
    backingStore: [2272, 1280],
    cssSize: [390, 220],
    devicePixelRatio: 3,
    source: "pixi",
    unsafeWindowGranted: true,
    ezgVisible: true,
    pixiVisible: true,
    pixiNamespaceCount: 1,
    pixiHookInstalled: true,
    domCanvasBackingStore: [2272, 1280],
    domCanvasCssSize: [390, 220],
  };

  const text = formatDiagnostics(info);
  assert.match(text, /倍率: 自動 → 2x/);
  assert.match(text, /Filter: 連動 → 2x/);
  assert.match(text, /描画: 2272×1280/);
  assert.match(text, /DPR: 3/);
  assert.match(text, /取得経路: pixi/);
  assert.match(text, /unsafeWindow: あり/);
  assert.match(text, /ページ変数: ezg=見える PIXI=見える 候補=1/);
  assert.match(text, /PIXIフック: 設置済み/);
  assert.match(text, /DOM Canvas: 2272×1280 \/ CSS 390×220/);

  const missing = formatDiagnostics({ ...info, backingStore: null, source: "none" });
  assert.match(missing, /描画: 取得できず/);
  assert.match(missing, /取得経路: 未取得/);
});

test("formatDiagnosticsは隔離コンテキストの兆候を区別できる", () => {
  // ページ変数が見えないのにDOM上のCanvasは見える＝隔離コンテキストで実行されている状態。
  const isolated = formatDiagnostics({
    mode: 4,
    scale: null,
    filterMode: 2,
    filterScale: null,
    rendererResolution: null,
    logical: null,
    backingStore: null,
    cssSize: null,
    devicePixelRatio: 2,
    source: "none",
    unsafeWindowGranted: true,
    ezgVisible: false,
    pixiVisible: false,
    pixiNamespaceCount: 0,
    pixiHookInstalled: false,
    domCanvasBackingStore: [1136, 640],
    domCanvasCssSize: [1194, 673],
  });

  assert.match(isolated, /取得経路: 未取得/);
  assert.match(isolated, /ページ変数: ezg=見えない PIXI=見えない 候補=0/);
  assert.match(isolated, /PIXIフック: 未設置/);
  assert.match(isolated, /DOM Canvas: 1136×640 \/ CSS 1194×673/);
});

test("findDomCanvasは最大面積のCanvasを返す", () => {
  const createCanvas = (width, height, cssWidth, cssHeight) => ({
    width,
    height,
    getBoundingClientRect: () => ({ width: cssWidth, height: cssHeight }),
  });
  const targetWindow = {
    document: {
      querySelectorAll: () => [createCanvas(16, 16, 8, 8), createCanvas(1136, 640, 1194, 673)],
    },
  };

  assert.deepEqual(findDomCanvas(targetWindow), {
    backingStore: [1136, 640],
    cssSize: [1194, 673],
  });
  assert.equal(findDomCanvas({ document: { querySelectorAll: () => [] } }), null);
  assert.equal(findDomCanvas({}), null);
});

test("registerActionMenuは再適用と診断表示を登録する", () => {
  const commands = [];
  const toasts = [];
  const forceValues = [];
  const info = {
    mode: 2,
    scale: 2,
    filterMode: "sync",
    filterScale: 2,
    rendererResolution: 2,
    logical: [1136, 640],
    backingStore: [2272, 1280],
    cssSize: [390, 220],
    devicePixelRatio: 3,
    source: "ezg",
    unsafeWindowGranted: true,
    ezgVisible: true,
    pixiVisible: true,
    pixiNamespaceCount: 1,
    pixiHookInstalled: true,
    domCanvasBackingStore: [2272, 1280],
    domCanvasCssSize: [390, 220],
  };

  registerActionMenu(
    {
      apply: (force) => {
        forceValues.push(force);
        return forceValues.length === 1 ? { scale: 3 } : null;
      },
      info: () => info,
    },
    (message) => toasts.push(message),
    (caption, onClick) => commands.push({ caption, onClick }),
  );

  assert.equal(commands.length, 2);
  commands[0].onClick();
  assert.deepEqual(forceValues, [true]);
  assert.match(toasts[0], /再適用しました: 3x/);

  commands[1].onClick();
  assert.match(toasts[1], /取得経路: ezg/);

  commands[0].onClick();
  assert.match(toasts[2], /Rendererを取得できませんでした/);
});

test("ezgを取得できない環境でもPIXI経由で倍率を適用する", () => {
  const harness = createWindowHarness();
  const renderer = createRenderer();
  renderer.screen = { width: 1136, height: 640 };
  const filter = { resolution: 1 };
  const stage = { filters: [filter], children: [] };
  let rendered = 0;
  class Renderer {
    render() {
      rendered += 1;
    }
  }
  harness.targetWindow.PIXI = { Renderer };
  // Stayのようにゲーム本体より後で実行され、ezgが既にnull化済みの状態。
  harness.targetWindow.ezg = null;

  const runtime = createUpscalerRuntime(harness.targetWindow, {
    GM_getValue: (key, fallback) => (key === "canvas-render-scale" ? 2 : fallback),
    GM_setValue: () => {},
    GM_registerMenuCommand: () => {},
  });
  runtime.start();
  assert.equal(runtime.info().source, "none");

  Renderer.prototype.render.call(renderer, stage);
  harness.runTimeouts(0);

  assert.equal(rendered, 1);
  assert.equal(renderer.resolution, 2);
  assert.equal(renderer.view.width, 2272);
  assert.equal(renderer.view.height, 1280);
  assert.equal(filter.resolution, 2);
  assert.equal(runtime.info().source, "pixi");
  assert.deepEqual(runtime.info().logical, [1136, 640]);
});
