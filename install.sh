#!/bin/bash
# Voice-Miro インストーラ（Mac用・初回1回だけ）
# 使い方（ソニアが二人に送る1行。<TOKEN>はソニアのMiroトークン）:
#   curl -fsSL https://raw.githubusercontent.com/nekonuko-sonia/voice-miro/main/install.sh | MIRO_TOKEN='<TOKEN>' bash
set -e

OWNER="nekonuko-sonia"
REPO="voice-miro"
BRANCH="main"
DIR="${VOICE_MIRO_DIR:-$HOME/Voice-Miro}"

echo ""
echo "  Voice-Miro をセットアップしています..."

if ! command -v node >/dev/null 2>&1; then
  echo "  [!] Node.js が見つかりません。https://nodejs.org/ja から LTS を入れてから、もう一度この1行を実行してください。"
  exit 1
fi

mkdir -p "$DIR"
echo "  ・最新版をダウンロード中..."
curl -fsSL "https://github.com/$OWNER/$REPO/archive/refs/heads/$BRANCH.tar.gz" | tar xz --strip-components=1 -C "$DIR"

# 設定ファイル（Miroトークンのみ。音声は無料Web Speech）。既にあれば上書きしない。
if [ ! -f "$DIR/config.local.json" ]; then
  printf '{\n  "MIRO_TOKEN": "%s",\n  "MODEL": "sonnet"\n}\n' "${MIRO_TOKEN:-}" > "$DIR/config.local.json"
fi

chmod +x "$DIR/Voice-Miro を起動.command" 2>/dev/null || true

echo ""
echo "  ✅ 完了！ 次からは下記をダブルクリックで起動できます（毎回自動で最新版になります）:"
echo "     $DIR/Voice-Miro を起動.command"
echo ""
echo "  いま起動します..."
open "$DIR/Voice-Miro を起動.command" 2>/dev/null || true
