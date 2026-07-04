# 🎤 Voice-Miro — 喋るだけでMiroボードが育つアプリ

mtg・セミナー中に起動しておくと、話した内容がリアルタイムで**実際のMiroボード**に色付き付箋・クラスタとして自動生成されていきます。

```
あなたの声 → 音声認識 → Claude(Maxサブスク) → Miroボードにライブ反映
```

- 🟥 赤 = 今日のテーマ　🟩 緑 = アイデア・手法　🟨 黄 = 内容・事実　🌸 ピンク = 重要ポイント
- 話の軸ごとに「島」としてまとまり、エグゼの板書のように整理される
- 編集・共有・PNG出力は全部Miro上でいつも通りにできます

## いちばん簡単な使い方

**「Voice-Miro を起動」をダブルクリック** → ブラウザが自動で開く → テンプレを選んで「セッション開始」→ 喋る。

- Windows: `Voice-Miro を起動.bat`
- Mac: `Voice-Miro を起動.command`（初回だけ右クリック→「開く」で許可）
- 停止: 起動時に出る黒いウィンドウを閉じる

> ねこ・ぬこは**これだけ**です（キー設定など不要）。ソニアが事前に設定を同梱しています。

## 前提（初回に一度だけ）
- **Chrome**（または Edge）で開くこと … 音声認識(Web Speech)はChrome/Edgeに標準搭載・**インストール不要**。Firefox/Safariは不可
- **Node.js**（LTS）… Claude Code が動いていれば入っています（確認: `node --version`）
- **Claude Code（claudeコマンド）にログイン済み**（各自のClaude Maxで）
  - ⚠ これは**ブラウザでclaude.aiを開いておくこと**ではありません。**ターミナル**（Windows=コマンドプロンプト / Mac=Terminal）で <code>claude auth login</code> を一度だけ実行し、開いた画面でサインインします。以降はCLIがログインを保持するので、毎回ブラウザを開く必要はありません。
  - 確認: ターミナルで <code>claude auth status</code> → <code>"loggedIn": true</code> と出ればOK
  - ねこぬこの「AI下書きワーカー」を動かしたことがあれば、たぶん既にログイン済みです

> ログインできていないと、アプリ画面の上部に**黄色い案内バナー**（`claude auth login`を実行してF5）が出ます。指示どおりにすればOK。
> 音声認識は無料のWeb Speech（Chrome標準）で動きます。より高精度にしたい場合はSonioxの課金が必要です（ソニアに相談）。

## テンプレ
| テンプレ | 用途 |
|---|---|
| セミナー板書 | 講義・セミナー。主張→根拠→具体例で板書化 |
| 議事録 | mtg。決定事項/TODO/論点に自動仕分け |
| ブレスト | アイデア出し。全部拾って有望案をピンク昇格 |
| コンサル面談 | 1on1。現状/課題/打ち手の3ボックス |

## オンラインmtg（Zoom等）の相手の声も拾いたい
→ `docs/LOOPBACK.md`（仮想オーディオデバイスの設定・無料）

## 困ったら
- 画面上部のピルが🔴のものが原因（claude / Miro / STT）
- claude🔴 → Claude Code を入れてログイン
- Miro🔴 → ソニアに連絡（トークン設定はソニア側）
- 詳しくは `docs/HANDOFF.md`

## 関連ドキュメント
- **配布する人（ソニア）向け**: `配布手順_ソニア用.md`
- Miroトークン取得: `docs/SETUP_MIRO.md` ／ 音声認識キー: `docs/SETUP_STT.md`
- 設計・開発引き継ぎ: `docs/HANDOFF.md`

## 上級者向け（個人ローカル運用）
`config.local.json` または環境変数で設定。主なキー: `MIRO_TOKEN` / `SONIOX_API_KEY` / `DEEPGRAM_API_KEY` / `MODEL`(既定sonnet) / `MOCK`(1でclaude缶詰) / `MIRO_MODE`(live|dry) / `PORT`(7788) / `NO_OPEN`(1でブラウザ自動起動オフ)。環境変数が config より優先。
