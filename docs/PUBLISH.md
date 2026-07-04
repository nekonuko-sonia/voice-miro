# 配信の仕組みと更新手順（開発者/ソニア向け）

Voice-Miroは**自動アップデート**方式。二人は初回だけインストールし、以降は起動のたびに最新版へ自動更新される。

## 全体像
```
このフォルダ（ソニアのPC＝開発元）  ──git push──▶  GitHub公開リポジトリ voice-miro
                                                          │
二人のMac: 起動時に update.js が GitHub の VERSION を見て、新しければ本体を自動更新
```
- 秘密（config.local.json）はリポジトリに入れない（.gitignore済み）。Miroトークンは**インストールの1行**で各自のconfigに書かれる。
- `VERSION` を変えて push した内容が「新しい版」として全員に配られる。

## 初回セットアップ（1回だけ）
1. `gh auth login`（GitHubにログイン）
2. リポジトリ作成＆初回push（このフォルダで）:
   ```
   git init && git add -A && git commit -m "init"
   gh repo create voice-miro --public --source=. --push
   ```
3. `update.meta.json` と `install.sh` の `__OWNER__` を自分のGitHubユーザー名に置換して再push:
   ```
   node tools/set-owner.js <あなたのGitHubユーザー名>
   git commit -am "set owner" && git push
   ```
4. **実行権限をgitに記録**（Macでダブルクリックできるように）:
   ```
   git update-index --chmod=+x "Voice-Miro を起動.command" install.sh
   git commit -m "chmod launchers" && git push
   ```

## 二人に送る「1行」（初回インストール）
```
curl -fsSL https://raw.githubusercontent.com/<あなたのユーザー名>/voice-miro/main/install.sh | MIRO_TOKEN='<ソニアのMiroトークン>' bash
```
二人はこれをMacのターミナルに貼ってEnter → 自動でセットアップ＆起動。以降はダブルクリック。

## 更新のかけ方（Miroの見た目を改善したとき等）
1. このフォルダでコードを直す
2. **`VERSION` の数字を1つ上げる**（例: `2026.07.04-1` → `2026.07.05-1`）
3. `git commit -am "改善内容" && git push`
これだけ。二人は次回起動時に自動で最新版になる（再配布・再インストール不要）。

## 注意
- ソニアのPCのこのフォルダは「開発元」。`update.meta.json` の owner が入っていても、ここはgit管理下なので update.js は走らせない運用（Windowsランチャーはupdate.jsを呼ばない）。編集はここで行い push する。
- ロールバックは古いコミットに戻して VERSION を上げて push。
