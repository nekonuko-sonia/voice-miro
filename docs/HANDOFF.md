# Voice-Miro 開発引き継ぎ書（HANDOFF）

新しいセッション/人がこのプロジェクトに入るとき、まずこれを読む。
作成: 2026-07-04 ソニア＆Claude（計画書: ユーザー承認済み）

## これは何か

「喋った内容がリアルタイムで実Miroボードに付箋として自動生成される」ローカルアプリ。
ねこ(Mac)・ぬこ(Win)・ソニア(Win)の3環境で同品質動作が必須要件。

```
ブラウザ(マイク→STT→確定文) → POST /api/transcript → pendingバッファ
→ 5秒tick: 条件成立で claude -p (Maxサブスク・sonnet) → 差分パッチJSON
→ applyOps(防御的) → layout.js(決定的配置) → Miro REST v2 → 実ボードにライブ反映
→ sessions/ にops.jsonl/transcript.jsonl/session.json永続化
```

## 設計の核（変えるときは慎重に）

1. **描画キャンバス＝実Miroボード**。自前キャンバスは作らない（編集/共有/PNGはMiroネイティブ）。UIの「ボード構造」表示はデバッグ用ミラー
2. **座標はLLM不可侵**。LLMは意味(ノード/色/クラスタ)のみ、x,yは`lib/layout.js`（クラスタ専用レーン・下方向成長・既存不動）
3. **LLM＝claude -p サブスク**（API課金なし・draft-worker.jsパターン継承）。in-flight1本・失敗時テキスト持ち越し
4. **防御的適用**: スキーマ(`prompts/patch.schema.json`)+正規化(`normalizeOp`)+未知ID破棄の三段構え。**ボードは絶対に壊さない**

## 実測値（2026-07-04・このPC）

- `claude -p` sonnet: **15〜17秒/回**（schema付き・ツール無効）→ 30-60秒カデンツに余裕
- `claude -p` haiku: 41秒/回・出力が雑（フラット形・op発明）→ **既定はsonnet**
- CLIの`--json-schema`は**インラインJSON文字列**を渡す（ファイルパス不可）
- CLIのスキーマ強制は**ソフト**（形ゆれする）→ normalizeOpで吸収（type→kind, edge:{}, add_text発明, フラット形）
- `--bare`はMax認証が壊れるので使用禁止

## ファイル地図

| ファイル | 役割 |
|---|---|
| `server.js` | 依存ゼロhttp。静的配信+API+SSE+STT一時トークン発行 |
| `lib/claude.js` | claude -p spawn（タイムアウト・Win .cmdフォールバック・3段パース） |
| `lib/miro.js` | Miro REST v2（bulk作成・429リトライ・dryモード） |
| `lib/layout.js` | 決定的インクリメンタル配置。**既存ノードを動かすコードを書かないこと** |
| `lib/pipeline.js` | セッション/スケジューラ/normalizeOp/applyOps/Refiner/永続化 |
| `prompts/system.md` | グラレコ指示（色ルール・鉄則）。品質チューニングは主にここ |
| `prompts/refine.md` | 整理パス（マージ・昇格・見出し）追加指示 |
| `prompts/patch.schema.json` | 差分パッチスキーマ（oneOf判別式） |
| `templates/*.json` | テンプレ = instructions+vocab+seedBoard+cadence |
| `public/stt.js` | STTファクトリ（soniox/deepgram/webspeech同一IF） |
| `public/app.js` | コントロールパネル（SSE購読・ティッカー・アウトライン） |

## 進捗（2026-07-04時点）

- ✅ P0: 骨格+MOCK E2E+実claude疎通
- ✅ P1: Miro実ボード疎通・STT統合（Soniox/Deepgram一時トークン発行）
- ✅ レイアウト仕上げ（ユーザーFB3回反映・島レイアウト・注記拡大・付箋内改行）→ ユーザー合格
- ✅ **配布インフラ（ワンタッチ起動）**:
  - 起動モデル = 各自PCでローカル`claude -p`（サブスク・¥0）。「Voice-Miro を起動」ダブルクリック→ブラウザ自動オープン（server.js の openBrowser）
  - 設定同梱 = `config.local.json`（`tools/make-config.js`でenvから生成）。env優先・configフォールバック。**ソニアが1回埋めて配布→他2人はノータッチ**
  - Miro = ソニアのトークン1つに集約。`createBoard`はリンク共有(access:edit)を試みて無料プランなら簡易作成にフォールバック（**有料化で自動的にログイン不要リンク共有化**）
  - 二重起動はEADDRINUSE検知でブラウザを開くだけ
  - 手順書: `配布手順_ソニア用.md`（ソニア用）/ `README.md`（3人用）
- ✅ **自動アップデート配信**（GitHub公開リポジトリ `nekonuko-sonia/voice-miro`）:
  - 二人は初回1回だけインストーラ1行（`install.sh` を curl|bash・Miroトークンをenvで渡す）→ 以降ダブルクリック
  - 起動時に `update.js` がGitHubの `VERSION` を見て新しければtarballで本体だけ自動更新（config/sessionsは保持・失敗/オフラインでもスキップして起動）
  - Mac実行権限は `.gitattributes`(sh/command=LF) + `git add --chmod=+x` でgit記録→tarballまで生存（検証済み）
  - Miro有料化済み → `createBoard`がリンク共有(access:edit)ボードを作成（他2人ログイン不要・シークレットで開けることを確認済み）
  - **更新手順**: コード直す→`VERSION`を上げる→commit&push（pushは安全機構によりユーザーが `!` で実行）。詳細 `docs/PUBLISH.md`
  - 開発元＝このPC（Windows・git管理下）。Windowsランチャーは `update.js` を呼ばない＝自己更新しない
- ⬜ 次: ねこ/ぬこの実機Macで実際にインストーラ1行→ダブルクリック起動を実走確認。長尺台本での島折り返し確認
- ⬜ 任意: Refiner実地検証・STTヘッドツーヘッド・Node同梱exe化

## レイアウト自己検証ループ（tools/ — LLM・ユーザー不要で見た目を回せる）

```
node tools/replay-layout.js sessions/<x>/session.json out.json   # 記録済み構造を現行エンジンで再配置
node tools/render-board.js out.json out.html                     # Miro風HTMLに描画（スケール焼き込み済み）
chrome --headless --screenshot=out.png --window-size=<表示サイズ> file:///.../out.html
→ Read out.png で自分の目で確認 → layout.js/prompts調整 → 繰り返し
node tools/push-board.js out.json "ボード名"                      # 納得したら実Miroに投入（過去セッション再生成も兼ねる）
```
レイアウト設計（2026-07-04 ユーザーフィードバック3回反映済み・ユーザー承認済み）:
- **島レイアウト（layout.js v3）**: 1クラスタ=1つの「島」。島を**横に並べる**（各島は独立カラム・下方向に成長）。MAX_ROW_W超で次行へ折り返し（ROW_MARGIN大）。後から古い島にノード追加されても下は空きなので衝突しない（旧版の2レーン使い回し重なりバグを解消）
- 島内は**2列マソンリー**（縦一直線を避けコンパクトな塊に）→ 縦幅が約1/3に
- **クラスタ分割が肝**: プロンプトで「話者が2つの視点/軸を提示したら別クラスタ（別の島）に」。1島6枚超で分割検討。これで「構造の島」「増え方の島」のようにテーマ別に空間分離
- **矢印=エッセンス**（強調・意外な関連のみ。ほぼ0本/パッチ、Refinerが俯瞰で最大2本）。parentは配置のみで矢印は張らない。遠距離edge(>800px)は描画抑止
- **色は原色系のみ**（Miro yellow/green/pink/red。薄色系は使わない）・pink一点差し
- 付箋サイズ可変・島見出しは島の左上に遅延配置
- お手本ボード: ぬこさんのMiro画像（CleanShot_2026-07-04_at_04.39.512x.png）が様式の正典
- 既知の小課題: 「（今日のテーマ）」プレースホルダのupdate_nameがLLM次第で稀に漏れる（実マイクでは概ね機能）

## 既知の注意点

- **Miro無料プランは編集可能ボード3枚まで**（超えると新規作成400）。テストボードはこまめに消す。実運用は既存ボードURL指定が安全

- git bashのcurlで日本語POSTするとCP932で化ける（テスト時は`--data-binary @utf8ファイル`で）。ブラウザからは問題なし
- 文字列は`sliceCp()`で切る（サロゲート分断・不対サロゲート除去）。生`slice`で切らない
- Web Speechは約60秒で切れる仕様 → `onend`無条件再起動済み。マイクデバイス選択不可（クラウドSTTのみ可）
- Miroのbulk作成は最大20個/コール・作成順にID返却前提（P1で実機確認すること）
- セッションは同時1本（`pipeline.js`のシングルトンS）

## 安全ゲート（ソニア3ゲート評価）

- ①本番ツールを壊さない: 既存プロジェクト（ねこぬこ自動投稿等）には一切触れない。draft-worker.jsは参照のみ
- ②データを飛ばさない: 全イベントJSONL追記・上書きなし。Miro書き込みは新規作成が基本
- ③誤送信しない: 外部送信はMiro自ボード書き込みとSTT音声ストリームのみ。Discord/顧客向け送信機能なし
