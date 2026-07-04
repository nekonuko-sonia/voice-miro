/* update.js — 起動時の自動アップデート（配布されたMac版が実行）
   ---------------------------------------------------------------------------
   最新tarballを取得し、中の VERSION がローカルより新しければ本体だけ上書き更新。
   config.local.json と sessions/ は保持。
   ※ raw.githubusercontent.com は数分CDNキャッシュされるため使わず、
     常に最新を反映する archive tarball を直接見る（アプリは小さいので毎回取得でOK）。
   - オフライン・失敗時は黙ってスキップ（起動は絶対に止めない）
   - Mac標準の curl / tar を使用（依存追加なし）
   - 置き場所が未設定(__OWNER__)なら何もしない（＝開発元/ソニアのPCでは無効） */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const ROOT = __dirname;
const UPDATE_TARGETS = ['server.js', 'update.js', 'VERSION', 'update.meta.json', 'lib', 'public', 'prompts', 'templates', 'Voice-Miro を起動.command'];

function meta() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'update.meta.json'), 'utf8').replace(/^﻿/, '')); } catch (e) { return null; }
}
function readVersion(dir) {
  try { return fs.readFileSync(path.join(dir, 'VERSION'), 'utf8').trim(); } catch (e) { return ''; }
}

function main() {
  const m = meta();
  if (!m || !m.owner || m.owner === '__OWNER__') return;                 // 置き場所未設定＝無効
  const tarball = `https://github.com/${m.owner}/${m.repo}/archive/refs/heads/${m.branch}.tar.gz`;
  const tmp = path.join(os.tmpdir(), 'voice-miro-update');

  try {
    execSync(`rm -rf "${tmp}" && mkdir -p "${tmp}/x"`, { stdio: 'ignore' });
    execSync(`curl -fsSL "${tarball}" | tar xz --strip-components=1 -C "${tmp}/x"`, { stdio: 'ignore', timeout: 60000 });

    const remote = readVersion(path.join(tmp, 'x'));
    const local = readVersion(ROOT);
    if (!remote || remote === local) { execSync(`rm -rf "${tmp}"`, { stdio: 'ignore' }); return; }  // 最新

    console.log(`  🔄 アップデート（${local || '初回'} → ${remote}）を適用中...`);
    for (const t of UPDATE_TARGETS) {
      const src = path.join(tmp, 'x', t);
      if (!fs.existsSync(src)) continue;
      execSync(`rm -rf "${path.join(ROOT, t)}" && cp -R "${src}" "${path.join(ROOT, t)}"`, { stdio: 'ignore' });
    }
    try { execSync(`chmod +x "${path.join(ROOT, 'Voice-Miro を起動.command')}"`, { stdio: 'ignore' }); } catch (e) {}
    console.log(`  ✅ ${remote} に更新しました。`);
  } catch (e) {
    // オフライン/失敗 → 現在のバージョンで起動（起動は止めない）
  } finally {
    try { execSync(`rm -rf "${tmp}"`, { stdio: 'ignore' }); } catch (e) {}
  }
}

main();
