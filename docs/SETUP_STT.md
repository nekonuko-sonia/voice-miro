# 音声認識（STT）のセットアップ

Voice-Miroは3つの音声認識を切替可能。**キー無しでもWeb Speechで動きます**が、セミナー本番はクラウドSTT推奨です。

| プロバイダ | 品質 | 料金 | セットアップ |
|---|---|---|---|
| **Soniox**（推奨・本命） | 日本語最高クラス・低遅延 | 約$0.12/時（2時間≈40円） | 5分 |
| **Deepgram Nova-3**（対抗） | 高品質・低遅延 | 約$0.35/時（2時間≈110円） | 5分 |
| Web Speech（内蔵） | そこそこ（Chrome依存） | 無料 | 不要 |

> どちらが日本語に強いかは実際の会議音声で聴き比べて決めます（両方セットアップして切替比較が理想）。

## Soniox

1. https://console.soniox.com/ でアカウント作成（無料クレジット付き）
2. ダッシュボード → **API Keys** → **Create API Key** → コピー
3. 環境変数に設定:
   - Windows: `setx SONIOX_API_KEY "コピーしたキー"`
   - Mac: `echo 'export SONIOX_API_KEY="キー"' >> ~/.zshrc && source ~/.zshrc`

## Deepgram

1. https://console.deepgram.com/ でアカウント作成（無料$200クレジット付き）
2. **API Keys** → **Create a New API Key** → コピー
3. 環境変数に設定:
   - Windows: `setx DEEPGRAM_API_KEY "コピーしたキー"`
   - Mac: `echo 'export DEEPGRAM_API_KEY="キー"' >> ~/.zshrc && source ~/.zshrc`

## 仕組みメモ（安全性）

- 本キーはローカルサーバだけが保持。ブラウザには**有効期限つきの一時トークン**だけが渡ります
- 音声はあなたのブラウザ → STT業者に直接ストリーミングされます（このアプリのサーバは音声を保持しません）
