# シャニマス Canvas 高解像度化

ブラウザ版「アイドルマスター シャイニーカラーズ」のCanvas描画を高解像度化し、Spineキャラクターに限定してシャープ化するユーザースクリプトです。

ゲーム内の論理座標、画面レイアウト、入力座標を維持したまま、PIXI.jsの描画解像度とFilter解像度を調整します。

- 現行バージョン: `2.3.2`
- 対象URL: `https://shinycolors.enza.fun/*`
- 対応マネージャー: Tampermonkey / [Stay](https://github.com/shenruisi/Stay)

## 主な機能

- Canvas描画倍率を`1x`から`4x`まで変更
- 画面サイズ、端末のピクセル密度、GPU上限から倍率を決める「自動」モード
- Canvas描画倍率とFilter解像度を個別に設定
- Spineキャラクターだけにクランプ付きUnsharp Maskを適用
- TampermonkeyとStayの登録メニューに同じ設定項目を表示
- PCでは`Alt + U`と`Alt + S`で即時切り替え
- 選択した設定を保存し、次回読み込み時に復元
- Rendererの再生成、Canvasサイズ変更、画面回転、WebGL context復帰時に再適用
- 後から追加されるSpineと複数のPIXIコピーに対応

## 設定一覧

| 設定 | 選択肢 | 初期値 | PCホットキー |
| --- | --- | --- | --- |
| Canvas描画倍率 | `自動` / `1x` / `1.5x` / `2x` / `3x` / `4x` | `2x` | `Alt + U` |
| Filter解像度 | `Canvas倍率に連動` / `1x` / `1.5x` / `2x` / `3x` / `4x` | `2x` | なし |
| Spineシャープ化 | `ON` / `OFF` | `ON` | `Alt + S` |

すべての設定はTampermonkeyまたはStayの登録メニューから変更できます。Canvas倍率とFilter解像度の現在値には`✓`が表示され、Spineシャープ化は`ON / OFF`で表示されます。

### Canvas描画倍率

`Alt + U`を押すたびに次の順番で切り替わります。

`自動 → 1x → 1.5x → 2x → 3x → 4x → 自動`

描画倍率を適用するときは、次の値を同期します。

- `renderer.resolution`
- `rootRenderTarget.resolution`
- `plugins.interaction.resolution`
- Canvasのbacking storeサイズ

CanvasのCSS表示サイズとゲームの論理サイズは変更しません。

### Filter解像度

Canvasとは別に、ゲーム内のPIXI Filterの描画解像度を設定します。`Canvas倍率に連動`を選ぶと、現在のCanvas描画倍率と同じ値を使います。

ぼかしなどのFilter処理が重い画面では、Canvasを4xのままFilterだけ1xまたは2xへ下げると、GPU負荷を抑えられます。Spineシャープ化Filterもこの解像度を使用します。

Filter解像度のホットキー切り替えは現在無効です。TampermonkeyまたはStayのメニューから変更してください。

### Spineシャープ化

Spineと判定したキャラクターに、強度`0.7`のクランプ付きUnsharp Maskを適用します。文字、通常のUI画像、背景には適用しません。

- ゲーム側の既存Filterを保持し、本スクリプトのFilterだけを着脱します。
- `spine.filters === null`のSpineは、ゲーム側の状態を保つため処理対象外です。
- `Alt + S`または登録メニューから`ON / OFF`を切り替えられます。
- シャープ化は輪郭を強調する処理で、元素材に存在しない細部を復元するものではありません。

## インストール

### Tampermonkey

1. Tampermonkeyへ`shiny_colors_upscaler.js`をインストールします。
2. `https://shinycolors.enza.fun/`を開きます。
3. Tampermonkeyアイコンから本スクリプトのメニューを開き、設定を選択します。

PCではメニューに加え、`Alt + U`と`Alt + S`を使用できます。

### Stay　iPhone / iPad

1. iOS/iPadOSの「設定」から`Safari > 拡張機能 > Stay`を開き、Stayを有効にします。
2. StayにすべてのWebサイトへのアクセスを許可します。
3. Stayへ`shiny_colors_upscaler.js`を「スクリプトURL」「直接編集」「ローカルファイル」などから追加します。
4. Stayのライブラリ（資料庫）で本スクリプトを有効にします。
5. `https://shinycolors.enza.fun/`を開き、SafariのStay拡張ポップアップを開きます。
6. マッチしたスクリプトの登録メニューから、Canvas倍率、Filter解像度、Spineシャープ化を変更します。

iPhone/iPadではキーボードショートカットを前提とせず、Stayの登録メニューを使用してください。

## 設定の反映と保存

- ホットキーの変更は即時反映され、現在状態が画面左下へ短時間表示されます。
- Tampermonkey/Stayの登録メニューから変更した場合は、設定保存後にページが再読み込みされます。
- GMストレージが利用できる場合は`GM_getValue / GM_setValue`を優先し、利用できない環境では`localStorage`を使用します。
- 旧版のCanvas倍率設定も可能な範囲で自動移行します。

## 診断

DevToolsのConsoleから次のAPIを利用できます。

```js
window.__shinyColorsUpscaler.info();
```

主に次の情報を確認できます。

- 選択中と実際のCanvas倍率
- 選択中と実際のFilter解像度
- Spineシャープ化のON/OFFと適用数
- Renderer解像度
- 論理サイズ、backing storeサイズ、CSS表示サイズ
- `devicePixelRatio`

現在の設定を強制的に再適用する場合は次を実行します。

```js
window.__shinyColorsUpscaler.apply();
```

## 注意事項

- ゲーム内のすべての画面でアップスケールが正しく処理されるとは限りません。
- 元画像やSpineテクスチャ自体の解像度は変わらないため、元素材にない細部は復元できません。
- 倍率を上げるほどGPU負荷、GPUメモリ使用量、発熱、消費電力が増えます。
- 動作が重い、表示が乱れる、画面が黒くなる場合は、Canvas倍率またはFilter解像度を`1x`か`2x`へ下げてください。
- iPhone/iPad + Stayでの動作は端末、Safari、GPU性能の影響を受けます。
- ゲーム側の更新により、動作しなくなる可能性があります。
- 本スクリプトは非公式です。株式会社バンダイナムコエンターテインメントおよび関係各社とは関係ありません。
