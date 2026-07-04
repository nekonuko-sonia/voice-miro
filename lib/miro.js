/* miro.js — Miro REST API v2 クライアント（依存ゼロ・fetchのみ）
   ---------------------------------------------------------------------------
   - 認証: env MIRO_TOKEN（非期限トークン推奨。取得手順は docs/SETUP_MIRO.md）
   - MIRO_MODE=dry で実APIを呼ばずダミーIDを返す（開発/オフライン用）
   - 429は Retry-After を尊重して最大2回リトライ
   - 付箋作成はbulk(最大20/コール)で節約。コネクタは個別（bulk非対応）
   レート制限メモ: sticky作成=Level2(100cr) / 上限100,000cr/分 → 本用途は余裕 */
const MIRO_TOKEN = (process.env.MIRO_TOKEN || '').trim();
const MIRO_MODE = (process.env.MIRO_MODE || (MIRO_TOKEN ? 'live' : 'dry')).trim(); // live | dry
const BASE = 'https://api.miro.com/v2';

// アプリ内色 → Miro fillColor（ぬこ板書踏襲: 原色系のはっきりした色のみ）
const COLOR_MAP = { red: 'red', green: 'green', yellow: 'yellow', pink: 'pink' };
const STICKY_WIDTH = 199;           // Miro標準の正方形付箋
const HEADING_FONT = '24';
const TEXT_FONT = '19';   // 付箋外の注記（一回り大きく・視認性向上）

let drySeq = 0;
const dryId = () => `dry_${++drySeq}`;

async function miroFetch(method, urlPath, body, attempt = 0) {
  if (MIRO_MODE === 'dry') return { id: dryId(), data: body ? (Array.isArray(body) ? body.map(() => ({ id: dryId() })) : undefined) : undefined };
  if (!MIRO_TOKEN) throw new Error('MIRO_TOKEN 未設定（docs/SETUP_MIRO.md 参照）');
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: { 'Authorization': `Bearer ${MIRO_TOKEN}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 429 && attempt < 2) {
    const wait = (parseInt(res.headers.get('retry-after') || '2', 10)) * 1000;
    await new Promise(r => setTimeout(r, wait));
    return miroFetch(method, urlPath, body, attempt + 1);
  }
  if (res.status === 204) return {};
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Miro ${method} ${urlPath} → ${res.status}: ${JSON.stringify(j).slice(0, 300)}`);
  return j;
}

/** ボードURL or 素のID → APIパス用ID（uXjV...= の=はエンコード必須） */
function parseBoardId(urlOrId) {
  const s = String(urlOrId || '').trim();
  const m = s.match(/miro\.com\/app\/board\/([^/?#]+)/);
  const raw = m ? decodeURIComponent(m[1]) : s;
  return encodeURIComponent(raw);
}

async function createBoard(name) {
  // リンク共有（他メンバーがログイン無しで開ける）を試みる。無料プランでは403になるので順に緩める:
  //   ① チーム共有+リンク編集 → ② リンク編集のみ → ③ 素の作成（フォールバック）
  // ※①②は有料プラン必須。有料化すれば自動でリンク共有ボードになる。
  const attempts = [
    { name: name || 'Voice-Miro', policy: { sharingPolicy: { access: 'edit', teamAccess: 'edit', inviteToAccountAndBoardLinkAccess: 'editor' } } },
    { name: name || 'Voice-Miro', policy: { sharingPolicy: { access: 'edit' } } },
    { name: name || 'Voice-Miro' },
  ];
  let lastErr;
  for (let i = 0; i < attempts.length; i++) {
    try {
      const j = await miroFetch('POST', '/boards', attempts[i]);
      if (i > 0) console.log(`[miro] リンク共有設定は非対応プランのため簡易作成にフォールバック（有料化で自動有効化）`);
      return { id: j.id || dryId(), viewLink: j.viewLink || '', shared: i === 0 };
    } catch (e) { lastErr = e; if (!/403|4\.0602|permission/i.test(e.message)) throw e; }
  }
  throw lastErr;
}

function stickyPayload(n) {
  return {
    data: { content: wrapSticky(n.text), shape: 'square' },
    style: { fillColor: COLOR_MAP[n.color] || 'light_yellow' },
    position: { x: n.x, y: n.y },
    geometry: { width: n.w || STICKY_WIDTH },   // 可変サイズ（文字数・重要度: layout.sizeOf）
  };
}

/** 長い付箋テキストを付箋内で改行させる（Miroの自動縮小で1行の極小文字になるのを防ぐ）。
    句読点・区切り優先で概ね8文字ごとに<br>を挿入。 */
function wrapSticky(text, perLine = 8) {
  const chars = Array.from(String(text || ''));
  if (chars.length <= perLine) return escapeHtml(text);
  let out = '', line = 0;
  for (let i = 0; i < chars.length; i++) {
    out += escapeHtml(chars[i]);
    line++;
    const punct = /[、。，,・：:／/]/.test(chars[i]);
    const last = i === chars.length - 1;
    if (!last && ((punct && line >= perLine - 3) || line >= perLine + 2)) { out += '<br>'; line = 0; }
  }
  return out;
}
function textPayload(n) {
  const isHeading = n.kind === 'heading';
  return {
    data: { content: isHeading ? `<b>${escapeHtml(n.text)}</b>` : escapeHtml(n.text) },
    style: { fontSize: isHeading ? HEADING_FONT : TEXT_FONT, color: '#1a1a1a' },
    position: { x: n.x, y: n.y },
    geometry: { width: isHeading ? 320 : 200 },
  };
}
function escapeHtml(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

/** ノード配列を一括作成（種別混在OK・20個ずつchunk）。入力順にmiroIdを返す */
async function createNodes(boardId, nodes) {
  const results = [];
  for (let i = 0; i < nodes.length; i += 20) {
    const chunk = nodes.slice(i, i + 20);
    if (MIRO_MODE === 'dry') { chunk.forEach(() => results.push(dryId())); continue; }
    if (chunk.length === 1) {
      const n = chunk[0];
      const j = n.kind === 'sticky'
        ? await miroFetch('POST', `/boards/${boardId}/sticky_notes`, stickyPayload(n))
        : await miroFetch('POST', `/boards/${boardId}/texts`, textPayload(n));
      results.push(j.id);
    } else {
      const body = chunk.map(n => n.kind === 'sticky'
        ? { type: 'sticky_note', ...stickyPayload(n) }
        : { type: 'text', ...textPayload(n) });
      const j = await miroFetch('POST', `/boards/${boardId}/items/bulk`, body);
      const arr = (j && j.data) || [];
      if (arr.length !== chunk.length) throw new Error(`bulk結果件数不一致 ${arr.length}!=${chunk.length}`);
      arr.forEach(item => results.push(item.id));
    }
  }
  return results;
}

async function createConnector(boardId, fromMiroId, toMiroId) {
  const j = await miroFetch('POST', `/boards/${boardId}/connectors`, {
    startItem: { id: fromMiroId }, endItem: { id: toMiroId },
    shape: 'elbowed',
    style: { strokeColor: '#555555', strokeWidth: '1.5', endStrokeCap: 'stealth' },
  });
  return j.id || dryId();
}

async function updateSticky(boardId, miroId, { text, color }) {
  const body = {};
  if (text !== undefined) body.data = { content: escapeHtml(text) };
  if (color !== undefined) body.style = { fillColor: COLOR_MAP[color] || 'light_yellow' };
  await miroFetch('PATCH', `/boards/${boardId}/sticky_notes/${miroId}`, body);
}

async function updateText(boardId, miroId, { text }) {
  await miroFetch('PATCH', `/boards/${boardId}/texts/${miroId}`, { data: { content: escapeHtml(text) } });
}

async function deleteItem(boardId, miroId, kind) {
  const ep = kind === 'sticky' ? 'sticky_notes' : 'texts';
  await miroFetch('DELETE', `/boards/${boardId}/${ep}/${miroId}`);
}

async function deleteConnector(boardId, miroId) {
  await miroFetch('DELETE', `/boards/${boardId}/connectors/${miroId}`);
}

/** 起動時ヘルスチェック用: トークンが有効か（自分の情報を1回GET） */
async function checkAuth() {
  if (MIRO_MODE === 'dry') return { ok: true, mode: 'dry' };
  try {
    await miroFetch('GET', '/boards?limit=1');
    return { ok: true, mode: 'live' };
  } catch (e) { return { ok: false, mode: 'live', error: e.message }; }
}

module.exports = { parseBoardId, createBoard, createNodes, createConnector, updateSticky, updateText, deleteItem, deleteConnector, checkAuth, MIRO_MODE, COLOR_MAP };
