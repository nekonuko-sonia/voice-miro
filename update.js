/* update.js — 起動時の自動アップデート（配布されたMac版が実行）
   ---------------------------------------------------------------------------
   GitHubの VERSION を見て、ローカルより新しければ最新tarballを取得して
   アプリ本体だけを上書き更新する。config.local.json と sessions/ は保持。
   - オフライン・失敗時は黙ってスキップ（起動は絶対に止めない）
   - Mac標準の curl / tar を使用（依存追加なし）
   - 置き場所が未設定(__OWNER__)なら何もしない（＝開発元/ソニアのPCでは無効） */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = __dirname;
const UPDATE_TARGETS = ['server.js', 'update.js', 'VERSION', 'update.meta.json', 'lib', 'public', 'prompts', 'templates', 'Voice-Miro を起動.command'];

function meta() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'update.meta.json'), 'utf8')); } catch (e) { return null; }
}
function localVersion() {
  try { return fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim(); } catch (e) { return ''; }
}

async function main() {
  const m = meta();
  if (!m || !m.owner || m.owner === '__OWNER__') return;                 // 置き場所未設定＝無効
  const raw = `https://raw.githubusercontent.com/${m.owner}/${m.repo}/${m.branch}`;
  const tarball = `https://github.com/${m.owner}/${m.repo}/archive/refs/heads/${m.branch}.tar.gz`;

  let remote = '';
  try {
    const r = await fetch(`${raw}/VERSION`, { signal: AbortSignal.timeout(8000) });
    if (r.ok) remote = (await r.text()).trim();
  } catch (e) { return; }                                                // オフライン等 → スキップ
  const local = localVersion();
  if (!remote || remote === local) return;                              // 最新 or 取得失敗

  console.log(`  🔄 アップデートがあります（${local || '初回'} → ${remote}）。更新中...`);
  const tmp = path.join(require('os').tmpdir(), 'voice-miro-update');
  try {
    execSync(`rm -rf "${tmp}" && mkdir -p "${tmp}/x"`, { stdio: 'ignore' });
    execSync(`curl -fsSL "${tarball}" | tar xz --strip-components=1 -C "${tmp}/x"`, { stdio: 'ignore', timeout: 60000 });
    // 本体だけ上書き（config.local.json / sessions は触らない）
    for (const t of UPDATE_TARGETS) {
      const src = path.join(tmp, 'x', t);
      if (!fs.existsSync(src)) continue;
      execSync(`rm -rf "${path.join(ROOT, t)}" && cp -R "${src}" "${path.join(ROOT, t)}"`, { stdio: 'ignore' });
    }
    try { execSync(`chmod +x "${path.join(ROOT, 'Voice-Miro を起動.command')}"`, { stdio: 'ignore' }); } catch (e) {}
    console.log(`  ✅ ${remote} に更新しました。`);
  } catch (e) {
    console.log('  （更新に失敗したので現在のバージョンで起動します）');
  } finally {
    try { execSync(`rm -rf "${tmp}"`, { stdio: 'ignore' }); } catch (e) {}
  }
}

main().catch(() => {});
