/* Voice-Miro server — 依存ゼロ(Node 18+)。静的配信 + API + SSE + STT一時トークン
   ---------------------------------------------------------------------------
   起動:  node server.js  （またはダブルクリック起動→ブラウザ自動オープン）
   設定:  config.local.json（同梱・ソニアが1回埋める）または環境変数。
          キー: MIRO_TOKEN / SONIOX_API_KEY / DEEPGRAM_API_KEY / MODEL / MIRO_MODE ...
   env優先。config.local.jsonは「配布フォルダに同梱して他2人はノータッチ」用の受け皿。 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// ── 設定ファイル読み込み（env未設定のキーだけ埋める。lib/* をrequireする前に実行） ──
(function loadLocalConfig() {
  for (const f of ['config.local.json', 'config.json']) {
    const p = path.join(__dirname, f);
    if (!fs.existsSync(p)) continue;
    try {
      const cfg = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); // 先頭BOM除去
      for (const [k, v] of Object.entries(cfg)) {
        if (v !== '' && v != null && !process.env[k]) process.env[k] = String(v);
      }
      console.log(`設定読込: ${f}`);
    } catch (e) { console.error(`${f} 読込失敗: ${e.message}`); }
    break;
  }
})();

const pipeline = require('./lib/pipeline');
const miro = require('./lib/miro');

/** 準備完了後、既定ブラウザで自動オープン（NO_OPEN=1で無効） */
function openBrowser(url) {
  if (process.env.NO_OPEN) return;
  try {
    const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  } catch (e) {}
}

const PORT = parseInt(process.env.PORT || '7788', 10);
const PUBLIC_DIR = path.join(__dirname, 'public');
const SONIOX_KEY = (process.env.SONIOX_API_KEY || '').trim();
const DEEPGRAM_KEY = (process.env.DEEPGRAM_API_KEY || '').trim();

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

/* ===== ヘルスチェック ===== */
let health = { claude: 'unknown', claudeState: 'unknown', miro: 'unknown', stt: [], mock: pipeline.MOCK, miroMode: miro.MIRO_MODE };

/** `claude auth status`（JSON）でログイン状態を判定（LLM呼び出し不要）。
    state: ok | logged_out | missing | timeout | unknown */
function checkClaude() {
  return new Promise(resolve => {
    let out = '', err = '';
    try {
      const bin = process.env.CLAUDE_BIN || 'claude';
      const p = spawn(`${bin} auth status`, { shell: true });   // 単一コマンド文字列（DEP0190回避）
      p.stdout.on('data', d => out += d);
      p.stderr.on('data', d => err += d);
      p.on('error', () => resolve({ state: 'missing' }));
      p.on('close', code => {
        const m = (out + err).match(/\{[\s\S]*\}/);
        if (m) { try { const j = JSON.parse(m[0]); return resolve(j && j.loggedIn ? { state: 'ok', sub: j.subscriptionType, email: j.email } : { state: 'logged_out' }); } catch (e) {} }
        if (/logged\s*out|not.*logged|please.*log|unauthor/i.test(out + err)) return resolve({ state: 'logged_out' });
        // JSONもログイン語も無い → コマンド自体が失敗（未インストール/PATH外）と判断（ロケール非依存）
        return resolve({ state: 'missing' });
      });
      setTimeout(() => { try { p.kill(); } catch (e) {} resolve({ state: 'timeout' }); }, 15000);
    } catch (e) { resolve({ state: 'missing' }); }
  });
}
async function refreshHealth() {
  const [cs, ma] = await Promise.all([checkClaude(), miro.checkAuth()]);
  health.claudeState = cs.state;
  health.claude =
    cs.state === 'ok' ? `ok (${cs.sub || 'subscription'})` :
    cs.state === 'logged_out' ? 'NG: 未ログイン → ターミナルで「claude auth login」' :
    cs.state === 'missing' ? 'NG: claude CLI未検出 → Claude Codeをインストール＆ログイン' :
    cs.state === 'timeout' ? 'NG: 確認タイムアウト（もう一度お試しを）' :
    `NG: 状態不明 ${cs.raw || ''}`;
  health.miro = ma.ok ? `ok (${ma.mode})` : `NG: ${ma.error || 'トークン未設定'}`;
  health.stt = [SONIOX_KEY && 'soniox', DEEPGRAM_KEY && 'deepgram', 'webspeech'].filter(Boolean);
  return health;
}

/* ===== STT一時トークン（本キーはブラウザに渡さない） ===== */
async function sttToken(provider) {
  if (provider === 'soniox') {
    if (!SONIOX_KEY) throw new Error('SONIOX_API_KEY 未設定');
    const res = await fetch('https://api.soniox.com/v1/auth/temporary-api-key', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${SONIOX_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ usage_type: 'transcribe_websocket', expires_in_seconds: 3600 }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Soniox一時キー発行失敗 ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
    return { provider, token: j.api_key, expiresAt: j.expires_at || null };
  }
  if (provider === 'deepgram') {
    if (!DEEPGRAM_KEY) throw new Error('DEEPGRAM_API_KEY 未設定');
    const res = await fetch('https://api.deepgram.com/v1/auth/grant', {
      method: 'POST',
      headers: { 'Authorization': `Token ${DEEPGRAM_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl_seconds: 300 }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Deepgram一時トークン発行失敗 ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
    return { provider, token: j.access_token, expiresIn: j.expires_in || 300 };
  }
  throw new Error(`不明なSTTプロバイダ: ${provider}`);
}

/* ===== HTTPユーティリティ ===== */
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); }
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = ''; req.on('data', d => { b += d; if (b.length > 5e6) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(new Error('invalid JSON body')); } });
    req.on('error', reject);
  });
}

/* ===== SSE ===== */
const sseClients = new Set();
pipeline.onEvent(ev => {
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of sseClients) { try { res.write(line); } catch (e) {} }
});

/* ===== ルーティング ===== */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  try {
    if (p === '/api/health') return json(res, 200, await refreshHealth());
    if (p === '/api/templates') return json(res, 200, pipeline.templates().map(t => ({ id: t.id, name: t.name, description: t.description })));
    if (p === '/api/state') return json(res, 200, pipeline.publicState());

    if (p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      res.write(`data: ${JSON.stringify({ type: 'hello', state: pipeline.publicState() })}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    if (req.method === 'POST' && p === '/api/session/start') {
      const b = await readBody(req);
      const meta = await pipeline.startSession(b);
      return json(res, 200, { ok: true, meta });
    }
    if (req.method === 'POST' && p === '/api/session/end') {
      return json(res, 200, { ok: true, meta: pipeline.endSession() });
    }
    if (req.method === 'POST' && p === '/api/transcript') {
      const b = await readBody(req);
      pipeline.addTranscript(b.text);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/generate-now') {
      pipeline.generate().catch(() => {});   // 「今すぐ更新」ボタン（非同期・結果はSSEで届く）
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/stt-token') {
      const b = await readBody(req);
      return json(res, 200, await sttToken(b.provider));
    }
    if (p === '/api/export/markdown') {
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': 'attachment; filename="voice-miro.md"' });
      return res.end(pipeline.toMarkdown());
    }

    // 静的配信
    let file = p === '/' ? '/index.html' : p;
    file = path.normalize(file).replace(/^([.][.][\\/])+/, '');
    const full = path.join(PUBLIC_DIR, file);
    if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
      return res.end(fs.readFileSync(full));
    }
    res.writeHead(404); res.end('not found');
  } catch (e) {
    json(res, 500, { ok: false, error: e.message });
  }
});

/* ===== スケジューラ ===== */
setInterval(() => { pipeline.tick().catch(() => {}); }, 5000);

const APP_URL = `http://localhost:${PORT}`;
server
  .listen(PORT, '127.0.0.1', async () => {
    console.log(`\n  ✅ Voice-Miro 起動: ${APP_URL}`);
    console.log('  （ブラウザが自動で開きます。停止するにはこのウィンドウを閉じてください）\n');
    openBrowser(APP_URL);
    await refreshHealth();
    console.log(`  MOCK=${pipeline.MOCK ? 'on' : 'off'} / MIRO_MODE=${miro.MIRO_MODE} / MODEL=${process.env.MODEL || 'sonnet'}`);
    console.log(`  claude: ${health.claude}`);
    console.log(`  miro:   ${health.miro}`);
    console.log(`  stt:    ${health.stt.join(', ')}`);
  })
  .on('error', e => {
    if (e.code === 'EADDRINUSE') {
      // 既に起動済み → 新規に立てず既存のブラウザを開くだけ
      console.log(`  すでに起動中です。ブラウザを開きます: ${APP_URL}`);
      openBrowser(APP_URL);
      process.exit(0);
    }
    console.error('起動失敗:', e.message);
    process.exit(1);
  });
