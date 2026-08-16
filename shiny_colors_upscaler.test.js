"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");

const {
  applyGameScale,
  applyRendererScale,
  computeAutoScale,
  createUpscalerRuntime,
  getGpuScaleLimit,
  installEzgHook,
  isFilterHotkey,
  isUpscalerHotkey,
  nextFilterMode,
  nextMode,
  normalizeFilterMode,
  normalizeMode,
  readFilterMode,
  readMode,
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
  assert.equal(normalizeFilterMode("invalid"), "sync");
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

  applyGameScale(game, stage, 4, 1);
  assert.equal(firstFilter.resolution, 4);
  assert.equal(baseTexture.resolution, 1);

  const laterFilter = { resolution: 1 };
  stage.children.push({ filters: [laterFilter], children: [] });
  const result = applyGameScale(game, stage, 4, 1);

  assert.equal(result.applied, false);
  assert.equal(renderer.resizeCalls, 1);
  assert.equal(laterFilter.resolution, 4);

  applyGameScale(game, stage, 1, 1);
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

test("readFilterModeは保存値を読み、未設定時はsyncを返す", () => {
  const values = new Map([["canvas-filter-scale", "2"]]);
  const targetWindow = { localStorage: { getItem: (key) => values.get(key) ?? null } };

  assert.equal(readFilterMode(targetWindow, (key, fallback) => (key === "canvas-filter-scale" ? 3 : fallback)), 3);
  assert.equal(readFilterMode(targetWindow, (_key, fallback) => fallback), 2);
  values.clear();
  assert.equal(readFilterMode(targetWindow, (_key, fallback) => fallback), "sync");
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

test("registerFilterMenuはAlt+Yと連動設定を登録する", () => {
  const commands = [];
  const storedValues = [];
  let reloadCount = 0;
  const targetWindow = {
    location: { reload: () => { reloadCount += 1; } },
  };

  registerFilterMenu(
    targetWindow,
    "sync",
    (key, value) => storedValues.push([key, value]),
    (caption, onClick) => commands.push({ caption, onClick }),
  );

  assert.match(commands[0].caption, /Alt\+Y/);
  assert.match(commands[1].caption, /Canvas倍率に連動 ✓/);
  commands[0].onClick();
  assert.deepEqual(storedValues, []);
  const scale2Command = commands.find(({ caption }) => caption.includes("2x"));
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
  assert.equal(pageHarness.targetWindow.__shinyColorsUpscaler.filterMode, "sync");
  assert.equal(typeof pageHarness.targetWindow.__shinyColorsUpscaler.apply, "function");
  assert.equal(typeof pageHarness.targetWindow.__shinyColorsUpscaler.info, "function");
  assert.equal(pageHarness.countListeners("resize"), 1);
  assert.equal(pageHarness.countListeners("orientationchange"), 1);
  assert.equal(pageHarness.countListeners("keydown"), 1);
  assert.equal(pageHarness.countIntervals(1000), 1);
  assert.equal(menuCommands.length, 14);
  assert.match(menuCommands[0].caption, /Alt\+U/);
  assert.match(menuCommands[7].caption, /Alt\+Y/);

  assert.equal(managerHarness.targetWindow.__shinyColorsUpscaler, undefined);
  assert.equal(managerHarness.countListeners("resize"), 0);
  assert.equal(managerHarness.countListeners("orientationchange"), 0);
  assert.equal(managerHarness.countListeners("keydown"), 0);
  assert.equal(managerHarness.countIntervals(1000), 0);
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

  assert.equal(menuCommands.length, 14);
  assert.equal(harness.countListeners("keydown"), 1);
  assert.equal(renderer.resolution, 2);
  assert.equal(renderer.rootRenderTarget.resolution, 2);
  assert.equal(renderer.plugins.interaction.resolution, 2);
  assert.equal(filter.resolution, 2);
  assert.equal(harness.resizeObservers.length, 1);
  assert.equal(harness.resizeObservers[0].observed, renderer.view);
  assert.equal(harness.targetWindow.__shinyColorsUpscaler.mode, 2);
  assert.equal(harness.targetWindow.__shinyColorsUpscaler.scale, 2);
  assert.equal(harness.targetWindow.__shinyColorsUpscaler.filterMode, "sync");
  assert.equal(harness.targetWindow.__shinyColorsUpscaler.filterScale, 2);
  assert.deepEqual(harness.targetWindow.__shinyColorsUpscaler.info(), {
    mode: 2,
    scale: 2,
    filterMode: "sync",
    filterScale: 2,
    rendererResolution: 2,
    logical: [1136, 640],
    backingStore: [2272, 1280],
    cssSize: [1136, 640],
    devicePixelRatio: 1,
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

test("runtimeはAlt+U・Alt+Yと画面変化を同じ倍率適用処理へ集約する", () => {
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
  assert.equal(filter.resolution, 3);
  assert.equal(harness.appendedElements[0].textContent, "Canvas描画倍率: 3x");

  harness.dispatch("keydown", {
    altKey: true,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    key: "Dead",
    code: "KeyY",
    preventDefault: () => { preventDefaultCount += 1; },
    stopPropagation: () => { stopPropagationCount += 1; },
  });

  assert.deepEqual(storedValues, [
    ["canvas-render-scale", 3],
    ["canvas-filter-scale", 1],
  ]);
  assert.equal(preventDefaultCount, 2);
  assert.equal(stopPropagationCount, 2);
  assert.equal(renderer.resolution, 3);
  assert.equal(filter.resolution, 1);
  assert.equal(harness.targetWindow.__shinyColorsUpscaler.filterMode, 1);
  assert.equal(harness.targetWindow.__shinyColorsUpscaler.filterScale, 1);
  assert.equal(harness.appendedElements[0].textContent, "Filter解像度: 1x");

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

test("nextFilterModeはsync・1・1.5・2・3・4を巡回する", () => {
  assert.equal(nextFilterMode("sync"), 1);
  assert.equal(nextFilterMode(1), 1.5);
  assert.equal(nextFilterMode(1.5), 2);
  assert.equal(nextFilterMode(2), 3);
  assert.equal(nextFilterMode(3), 4);
  assert.equal(nextFilterMode(4), "sync");
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

test("isFilterHotkeyは修飾なしのAlt+Yだけを受け付ける", () => {
  const event = {
    altKey: true,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    key: "y",
    code: "KeyY",
  };
  assert.equal(isFilterHotkey(event), true);
  assert.equal(isFilterHotkey({ ...event, key: "Y" }), true);
  assert.equal(isFilterHotkey({ ...event, key: "Dead" }), true);
  assert.equal(isFilterHotkey({ ...event, repeat: true }), false);
  assert.equal(isFilterHotkey({ ...event, ctrlKey: true }), false);
  assert.equal(isFilterHotkey({ ...event, key: "u", code: "KeyU" }), false);
});
