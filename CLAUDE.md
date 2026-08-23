# プロジェクトメモ（CLAUDE.md）

ブラウザ版「アイドルマスター シャイニーカラーズ」(enza) のCanvas描画を高解像度化する
Tampermonkey / Stay 向けユーザースクリプト。

## 構成

| パス | 役割 |
| --- | --- |
| `shiny_colors_upscaler.js` | 本体。単一ファイルのユーザースクリプト |
| `shiny_colors_upscaler.test.js` | `node:test`のテスト。依存パッケージなし |
| `source_variants/` | 過去の試作版3種。実装判断の経緯を追うときの参考 |
| `image_1x.png` / `image 4x.png` | 効果比較用のスクリーンショット |

- テスト実行: `node --test shiny_colors_upscaler.test.js`（依存インストール不要）
- 本体は末尾で`module.exports`し、Userscript環境では`main()`を呼ぶ二重構造。
  テストから内部関数を直接importできるのはこのため。

## コーディング方針（既存コードに合わせる）

- コメント・JSDocは日本語。`// @ts-check`前提でJSDoc型注釈を維持する
- マジックナンバーはファイル上部の定数へ切り出す（例: `TOAST_DURATION_MS`）
- 無効化した機能はコメントアウトで残す慣習がある（Filter解像度のホットキー等）
- ユーザー向け文言も日本語

## 設計の要点

倍率適用にはRenderer取得が必要で、経路は2つある。

1. **ezg経路** — `installEzgHook`が`window.ezg`にsetterを仕掛け、代入の瞬間を捕捉する。
   ゲームは起動時に一度だけ代入し**直後にnull化する**ため、この一瞬を逃すと二度と来ない。
   `@run-at document-start`が必須なのはこの理由。
2. **PIXI経路** — `installPixiRendererHook`が`Renderer`系コンストラクタの`prototype.render`を
   ラップし、描画中のRendererを捕捉する。ezgを取り逃がした環境向けの保険。
   `start()`内の1秒間隔`setInterval`で、設置できるまで再試行し続ける。

`apply()`は`resolveGame` → `applyGameScale`（Renderer解像度 + backing store + Filter解像度）の順。
CSS表示サイズと論理サイズは変更しない。`renderer.resize()`がCSSを書き換えるため前後で復元している。

## 既知の落とし穴

### `run-at`の上書きで完全に動かなくなる（2026-08 解決済み）

iPhone/iPadで倍率が適用されない事象が発生。原因は**Stayの「override meta」で`run-at`を
`document-end`に上書きしていたこと**。`document-start`へ戻して解消。

診断上の見え方: `取得経路: 未取得` / `倍率: Nx → -x` / 論理・描画・CSSがすべて`取得できず`。
一方でゲーム自体は正常に描画されている（＝Rendererは存在するのに掴めていない）。

調査中に「Safari拡張の隔離コンテキスト（isolated world）で動いているのでは」という仮説を
立てたが、**これは誤り**。Stayはページ側のJSワールドに到達できている。同じ端末で2xの適用に
成功したことで否定された。以後この仮説を再提示しないこと。

## 未解決の課題

**PIXIフォールバックが`document-end`を救えていない。**

`installPixiRendererHook`は「Stayのようにゲーム本体より後で実行される環境」の保険として
コミット`425871b`で追加したもの。しかし上記事象では実際に救えていない。

有力な仮説（未検証）: `source_variants/shiny_colors_upscaler2.js`のコメントにある通り
「`window.PIXI`は2回、別々のPixiJSコピーで代入される」ため、実際に描画しているRendererが
`window.PIXI`とは別コピー由来だと、prototypeをラップしても発火しない。

再現手順は判明している（Userscript Manager側で`run-at`を`document-end`に設定する）ので、
着手する場合はここから検証できる。

## 診断機能

登録メニューの「現在の設定を再適用」「診断情報を表示」から、DevToolsのない端末でも状態を確認できる。
`formatDiagnostics`が12行を返し、`showToast`が画面左下へ3秒表示する
（`white-space:pre-line`で改行を保持）。

後半4行は原因切り分け専用に追加したもの。

| 行 | 読み方 |
| --- | --- |
| `unsafeWindow` | Userscript Managerがページのwindowを渡しているか |
| `ページ変数: ezg=... PIXI=... 候補=N` | ページのJSグローバルが見えているか。`候補`は`findPixiNamespaces`の検出数 |
| `PIXIフック` | `installPixiRendererHook`が設置できたか |
| `DOM Canvas` | `document`から直接探したCanvasの実測値。DOMは共有されるので、ページ変数だけ見えない状況の切り分けに使う |

「ページ変数が見えない のに DOM Canvasは見える」＝隔離コンテキストの疑い、という判別を想定した設計。
ただし今回の事例はこれではなかった（上記「既知の落とし穴」参照）。

## 作業ルール

- 開発ブランチは`claude/test-35hnvo`。`main`へ直接pushしない
- PRはユーザーが明示的に依頼したときだけ作成する
- 変更後は必ず`node --test shiny_colors_upscaler.test.js`を通す
- 本体を変更したら`@version`を上げる
- 仮説段階の修正を入れる前に、実機で確定できる診断を先に用意する方針で進めてきた
