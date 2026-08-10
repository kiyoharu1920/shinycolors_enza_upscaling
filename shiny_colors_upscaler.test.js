"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  applyGameScale,
  applyRendererScale,
  computeAutoScale,
  getGpuScaleLimit,
  installEzgHook,
  isUpscalerHotkey,
  nextMode,
  normalizeMode,
  readMode,
  registerScaleMenu,
  resolveGame,
  resolveStage,
} = require("./shiny_colors_upscaler.js");

function createRenderer(options = {}) {
  const logicalWidth = options.logicalWidth ?? 1136;
  const logicalHeight = options.logicalHeight ?? 640;
  const view = {
    width: logicalWidth,
    height: logicalHeight,
    style: { width: "80vw", height: "auto" },
    dataset: {},
    getBoundingClientRect: () => ({
      width: options.displayWidth ?? logicalWidth,
      height: options.displayHeight ?? logicalHeight,
    }),
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

test("normalizeModeはautoと対応倍率へ正規化する", () => {
  assert.equal(normalizeMode("AUTO"), "auto");
  assert.equal(normalizeMode(2.5), 2);
  assert.equal(normalizeMode(3.5), 3);
  assert.equal(normalizeMode(3.6), 4);
  assert.equal(normalizeMode(0.1), 1);
  assert.equal(normalizeMode(10), 4);
  assert.equal(normalizeMode("invalid"), 2);
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
