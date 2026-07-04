#!/bin/bash
# Voice-Miro 起動（Mac）— ダブルクリック。起動のたびに自動で最新版に更新します。閉じると停止。
cd "$(dirname "$0")"

# Node を探す（PATH → Homebrew等のよくある場所）
if ! command -v node >/dev/null 2>&1; then
  for p in /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin" "$HOME/.volta/bin"; do
    [ -x "$p/node" ] && export PATH="$p:$PATH" && break
  done
fi
if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  [!] Node.js が見つかりません。https://nodejs.org/ja から LTS 版を入れてください。"
  echo ""
  read -p "Enterで閉じる"; exit 1
fi

if command -v claude >/dev/null 2>&1; then
  claude auth status 2>/dev/null | grep -q '"loggedIn": true' || echo "  [注意] Claude 未ログインの可能性。使えない場合は Terminal で  claude auth login  を実行してください。"
else
  echo "  [注意] claude コマンドが見つかりません。Claude Code をインストール＆ログインしてください。"
fi

echo ""
echo "  最新版を確認しています..."
node --no-deprecation update.js || true

echo "  Voice-Miro を起動しています... しばらくするとブラウザが開きます。"
echo "  （このウィンドウを閉じると停止します）"
echo ""
node --no-deprecation server.js
echo ""
read -p "停止しました。Enterで閉じる"
