/* app.js — コントロールパネル: セットアップ → 実行中(SSE購読・STT駆動) */
'use strict';
const $ = id => document.getElementById(id);
let stt = null, es = null;

/* ===== 初期化 ===== */
async function init() {
  // ヘルス表示
  const h = await (await fetch('/api/health')).json();
  $('health').innerHTML = [
    pill(`claude: ${h.claude.startsWith('ok') ? '🟢' : '🔴'}`, h.claude.startsWith('ok')),
    pill(`Miro: ${h.miro.startsWith('ok') ? '🟢' : '🔴'} ${h.miroMode === 'dry' ? '(dry)' : ''}`, h.miro.startsWith('ok')),
    pill(`STT: ${h.stt.join('/')}`, true),
    h.mock ? pill('MOCKモード', false, 'busy') : '',
  ].join('');
  showBanner(h);
  if (!h.claude.startsWith('ok')) log('⚠ ' + h.claude, 'err');
  if (!h.miro.startsWith('ok') && h.miroMode !== 'dry') log('⚠ MIRO: ' + h.miro, 'err');

  // テンプレ
  const ts = await (await fetch('/api/templates')).json();
  $('template').innerHTML = ts.map(t => `<option value="${t.id}">${t.name} — ${t.description}</option>`).join('');

  // STTプロバイダ（キーがある順に優先）
  const provs = [];
  if (h.stt.includes('soniox')) provs.push(['soniox', 'Soniox（高精度・低遅延）']);
  if (h.stt.includes('deepgram')) provs.push(['deepgram', 'Deepgram Nova-3']);
  provs.push(['webspeech', 'Web Speech（無料・Chrome内蔵）']);
  $('sttProvider').innerHTML = provs.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');

  // マイク一覧（クラウドSTT用）
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    const mics = devs.filter(d => d.kind === 'audioinput' && d.deviceId);
    $('micDevice').innerHTML = '<option value="">既定のマイク</option>' +
      mics.map(d => `<option value="${d.deviceId}">${d.label || 'マイク'}</option>`).join('');
  } catch (e) {}

  $('boardMode').onchange = () => { $('boardUrlWrap').style.display = $('boardMode').value === 'existing' ? '' : 'none'; };
  $('startBtn').onclick = startSession;
  $('genNow').onclick = () => fetch('/api/generate-now', { method: 'POST' });
  $('mdBtn').onclick = () => { location.href = '/api/export/markdown'; };
  $('endBtn').onclick = endSession;

  // 既存セッションがあれば復帰表示
  const st = await (await fetch('/api/state')).json();
  if (st.active) enterLive(st.meta);
}
function pill(text, ok, cls) { return `<span class="pill ${cls || (ok ? 'ok' : 'ng')}">${text}</span>`; }

/** claude未ログイン等の重大な問題を、ブラウザ上に大きく分かりやすく表示 */
function showBanner(h) {
  const b = $('banner');
  if (h.claudeState === 'logged_out') {
    b.className = 'banner err';
    b.innerHTML = '<b>⚠ Claude にログインしていません</b><br>' +
      'この機能はあなたのClaude Maxを使います。<b>ターミナル（Windowsはコマンドプロンプト / MacはTerminal）</b>を開いて <code>claude auth login</code> を実行し、画面の案内でログインしてください。<br>' +
      '完了したら、このページを再読み込み（F5）してください。';
    b.style.display = '';
  } else if (h.claudeState === 'missing') {
    b.className = 'banner err';
    b.innerHTML = '<b>⚠ Claude Code（claudeコマンド）が見つかりません</b><br>' +
      'Claude Code をインストールしてログインしてください。分からなければソニアに連絡を。';
    b.style.display = '';
  } else if (!h.miro.startsWith('ok') && h.miroMode !== 'dry') {
    b.className = 'banner err';
    b.innerHTML = '<b>⚠ Miroに接続できません</b><br>設定の問題です。ソニアに連絡してください（' + esc(h.miro) + '）。';
    b.style.display = '';
  } else {
    b.style.display = 'none';
  }
}

/* ===== セッション開始/終了 ===== */
async function startSession() {
  $('setupMsg').textContent = '';
  $('startBtn').disabled = true;
  try {
    const body = {
      templateId: $('template').value,
      title: $('title').value,
      boardUrl: $('boardMode').value === 'existing' ? $('boardUrl').value : '',
    };
    if ($('boardMode').value === 'existing' && !body.boardUrl) throw new Error('ボードURLを入力してください');
    const res = await fetch('/api/session/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || '開始失敗');
    enterLive(j.meta);
    await startSTT();
  } catch (e) {
    $('setupMsg').textContent = e.message;
  } finally {
    $('startBtn').disabled = false;
  }
}

function makeSTT(provider) {
  return createSTT(provider, {
    onFinal: text => {
      $('tickerFinal').textContent = text;
      $('tickerInterim').textContent = '';
      fetch('/api/transcript', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    },
    onInterim: text => { $('tickerInterim').textContent = text; },
    onStatus: s => { $('sttStatus').textContent = 'STT: ' + s; },
  });
}

async function startSTT() {
  const provider = $('sttProvider').value;
  stt = makeSTT(provider);
  try {
    await stt.start($('micDevice').value || undefined);
  } catch (e) {
    // クラウドSTT(soniox/deepgram)がキー切れ・失敗した場合は無料のWeb Speechへ自動フォールバック
    if (provider !== 'webspeech') {
      log(`${provider}が使えません（${e.message}）→ 無料のWeb Speechに切替`, 'err');
      $('sttStatus').textContent = 'STT: 🔁 Web Speechに自動切替';
      try { stt = makeSTT('webspeech'); await stt.start(); return; }
      catch (e2) { e = e2; }
    }
    log('STT起動失敗: ' + e.message, 'err');
    $('sttStatus').textContent = 'STT: 🔴 ' + e.message;
  }
}

async function endSession() {
  if (!confirm('セッションを終了しますか？')) return;
  if (stt) { stt.stop(); stt = null; }
  if (es) { es.close(); es = null; }
  await fetch('/api/session/end', { method: 'POST' });
  document.body.classList.remove('live');
  $('live').style.display = 'none';
  $('setup').style.display = '';
}

/* ===== 実行中UI ===== */
function enterLive(meta) {
  $('setup').style.display = 'none';
  $('live').style.display = '';
  document.body.classList.add('live');
  if (meta && meta.viewLink) { $('boardLink').href = meta.viewLink; $('boardLink').style.display = ''; }
  else if (meta && meta.boardId && !String(meta.boardId).startsWith('dry')) {
    $('boardLink').href = `https://miro.com/app/board/${meta.boardId}/`; $('boardLink').style.display = '';
  }
  subscribe();
  refreshState();
}

function subscribe() {
  es = new EventSource('/api/events');
  es.onmessage = ev => {
    let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.type === 'status') {
      $('phase').textContent = m.phase === 'generating' ? '🧠 生成中…' : m.phase === 'refining' ? '🧹 整理中…' : '👂 待機中';
      $('phase').className = 'pill ' + (m.phase === 'idle' ? '' : 'busy');
    }
    if (m.type === 'patch') {
      log(`${m.kind === 'refine' ? '整理' : '生成'}完了: ${m.applied.length} ops (${(m.latencyMs / 1000).toFixed(1)}s)`, 'ok');
      refreshState();
    }
    if (m.type === 'error') {
      log(m.message, 'err');
      if (/login|auth|logged|unauthor|401/i.test(m.message)) {
        const b = $('banner');
        b.className = 'banner err';
        b.innerHTML = '<b>⚠ Claude の生成に失敗しました（ログイン切れの可能性）</b><br>ターミナルで <code>claude auth login</code> を実行してから、ページを再読み込み（F5）してください。';
        b.style.display = '';
      }
    }
    if (m.type === 'transcript') { /* ticker側で表示済み */ }
  };
  es.onerror = () => { /* 自動再接続に任せる */ };
}

async function refreshState() {
  const st = await (await fetch('/api/state')).json();
  if (!st.active) return;
  $('stats').textContent = `生成${st.counters.llmCalls}回 / 付箋${st.counters.nodes}枚` + (st.counters.llmFails ? ` / 失敗${st.counters.llmFails}` : '');
  $('summary').textContent = st.summary || '（まだ無し）';
  renderOutline(st.outline);
}

function renderOutline(o) {
  if (!o) return;
  $('outline').innerHTML = o.clusters.map(c => `
    <div class="cluster">
      <div class="clabel">${esc(c.label || c.id)}</div>
      ${c.nodes.map(n => `<span class="node ${n.kind === 'heading' ? 'heading' : n.kind === 'text' ? 'textnote' : (n.color || 'yellow')}" data-id="${esc(n.id)}">${esc(n.text)}</span>`).join('')}
    </div>`).join('') || '（空のボード）';
}

function log(msg, cls) {
  const d = document.createElement('div');
  if (cls) d.className = cls;
  d.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  $('log').appendChild(d);
  $('log').scrollTop = $('log').scrollHeight;
}
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

init();
