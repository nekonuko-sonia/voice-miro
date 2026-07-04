/* pipeline.js — セッション管理・適応スケジューラ・パッチ適用・永続化
   ---------------------------------------------------------------------------
   データフロー:
     ブラウザ(STT確定文) → addTranscript() → pendingバッファ
     → tick(5秒毎): 条件成立で generate() → claude → parsePatch → applyOps
     → layout.jsが座標決定 → miro.jsが実ボードへ反映 → ops.jsonl/session.json永続化
   原則:
   - in-flight 1本（claude同時実行しない・Maxサブスク配慮）
   - 生成失敗時はテキストを持ち越し（取りこぼさない・draft-worker思想）
   - 防御的適用: 未知ID破棄・ID衝突サフィックス・ボードは絶対に壊さない
   - MOCK=1 でclaudeを呼ばず缶詰パッチ（UI/配線の開発用） */
const fs = require('fs');
const path = require('path');
const { runClaude, parsePatch, MODEL } = require('./claude');
const miro = require('./miro');
const layout = require('./layout');

const ROOT = path.join(__dirname, '..');
const SESSIONS_DIR = path.join(ROOT, 'sessions');
const MOCK = !!process.env.MOCK;
const ALLOW_DESTRUCTIVE = process.env.ALLOW_DESTRUCTIVE !== '0';

const SYSTEM_MD = fs.readFileSync(path.join(ROOT, 'prompts', 'system.md'), 'utf8');
const REFINE_MD = fs.readFileSync(path.join(ROOT, 'prompts', 'refine.md'), 'utf8');

/* ===== イベント通知（SSE用） ===== */
/** サロゲートペアを分断しない安全なslice（絵文字対策）。不対サロゲートも除去 */
function sliceCp(s, n) {
  const clean = String(s || '').replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
  return Array.from(clean).slice(0, n).join('');
}

const listeners = new Set();
function onEvent(cb) { listeners.add(cb); return () => listeners.delete(cb); }
function emit(type, data) { const ev = { type, t: Date.now(), ...data }; for (const cb of listeners) { try { cb(ev); } catch (e) {} } }

/* ===== セッション状態（同時1セッション） ===== */
let S = null; // { dir, meta, doc, template, pending, lastGenAt, lastRefineAt, inFlight, counters }

function templates() {
  const dir = path.join(ROOT, 'templates');
  return fs.readdirSync(dir).filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

function current() { return S; }

function publicState() {
  if (!S) return { active: false };
  return {
    active: true,
    meta: S.meta,
    counters: S.counters,
    inFlight: S.inFlight,
    pendingChars: S.pending.length,
    lastGenAt: S.lastGenAt,
    summary: S.doc.summary,
    outline: outlineJson(S.doc),
  };
}

/* ===== セッション開始/再開/終了 ===== */
async function startSession({ templateId, boardUrl, newBoardName, title }) {
  if (S) throw new Error('セッションが既に進行中です（先に終了してください）');
  const template = templates().find(t => t.id === templateId);
  if (!template) throw new Error(`テンプレ不明: ${templateId}`);

  let boardId, viewLink = '';
  if (boardUrl) { boardId = miro.parseBoardId(boardUrl); }
  else {
    const b = await miro.createBoard(newBoardName || `Voice-Miro ${title || new Date().toISOString().slice(0, 10)}`);
    boardId = b.id; viewLink = b.viewLink;
  }

  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  const dir = path.join(SESSIONS_DIR, `${stamp}_${sanitize(title || template.id)}`);
  fs.mkdirSync(dir, { recursive: true });

  S = {
    dir,
    meta: { title: title || '', templateId, boardId, viewLink, startedAt: Date.now(), model: MODEL, mock: MOCK, miroMode: miro.MIRO_MODE },
    doc: { version: 0, nodes: [], edges: [], clusters: [], summary: '', layoutState: null, tombstones: [] },
    template,
    pending: '',
    lastGenAt: Date.now(),
    lastRefineAt: Date.now(),
    nodesSinceRefine: 0,
    inFlight: false,
    counters: { llmCalls: 0, llmFails: 0, nodes: 0, refines: 0 },
  };
  layout.initLayoutState(S.doc);

  // seedBoard流し込み（テンプレの初期クラスタ/付箋）
  const seed = template.seedBoard || { clusters: [], nodes: [] };
  const seedOps = [
    ...seed.clusters.map(c => ({ op: 'add_cluster', cluster: c })),
    ...seed.nodes.map(n => ({ op: 'add_node', node: n })),
    ...(seed.edges || []).map(e => ({ op: 'add_edge', from: e.from, to: e.to })),
  ];
  if (seedOps.length) await applyOps(seedOps, 'seed');

  persist();
  emit('session', { event: 'started', meta: S.meta });
  return S.meta;
}

function endSession() {
  if (!S) return null;
  persist();
  const meta = S.meta;
  emit('session', { event: 'ended', meta });
  S = null;
  return meta;
}

/* ===== 文字起こし受け口 ===== */
function addTranscript(text) {
  if (!S) throw new Error('セッション未開始');
  const t = String(text || '').trim();
  if (!t) return;
  S.pending += (S.pending ? '\n' : '') + t;
  appendJsonl('transcript.jsonl', { t: Date.now(), text: t });
  emit('transcript', { text: t });
}

/* ===== 適応スケジューラ（server.jsがsetIntervalで呼ぶ） ===== */
async function tick() {
  if (!S || S.inFlight) return;
  const cad = S.template.cadence || {};
  const minChars = cad.minChars || 120;
  const minMs = cad.minIntervalMs || 25000;
  const maxMs = cad.maxIntervalMs || 75000;
  const refineMs = cad.refineMs || 240000;
  const since = Date.now() - S.lastGenAt;

  // Refinerパス（整理）: 一定時間 + 新ノードが溜まっている時
  if (Date.now() - S.lastRefineAt >= refineMs && S.nodesSinceRefine >= 6) {
    await refine();
    return;
  }
  // メインパス（逐次付箋化）
  if (S.pending && ((S.pending.length >= minChars && since >= minMs) || since >= maxMs)) {
    await generate();
  }
}

/* ===== メイン生成 ===== */
async function generate() {
  const text = S.pending;
  if (!text) return;
  S.pending = '';           // 先に確保。失敗したら戻す（持ち越し）
  S.inFlight = true;
  emit('status', { phase: 'generating' });
  const t0 = Date.now();
  try {
    const patch = MOCK ? nextMockPatch() : parsePatch(await runClaude(buildPrompt(text)));
    S.counters.llmCalls++;
    if (!patch) throw new Error('パッチ解析失敗');
    const applied = await applyOps(patch.ops || [], 'ai');
    if (patch.summary) S.doc.summary = sliceCp(patch.summary, 800);
    S.lastGenAt = Date.now();
    persist();
    emit('patch', { applied, latencyMs: Date.now() - t0, kind: 'main' });
  } catch (e) {
    S.counters.llmFails++;
    S.pending = text + (S.pending ? '\n' + S.pending : ''); // 持ち越し（この間に届いた分の前に戻す）
    emit('error', { message: `生成失敗（次周期で再試行）: ${e.message}` });
  } finally {
    S.inFlight = false;
    emit('status', { phase: 'idle' });
  }
}

/* ===== Refinerパス ===== */
async function refine() {
  S.inFlight = true;
  emit('status', { phase: 'refining' });
  const t0 = Date.now();
  try {
    const patch = MOCK ? { ops: [] } : parsePatch(await runClaude(buildRefinePrompt()));
    S.counters.llmCalls++;
    S.counters.refines++;
    if (patch) {
      const applied = await applyOps(patch.ops || [], 'ai-refine');
      if (patch.summary) S.doc.summary = sliceCp(patch.summary, 800);
      emit('patch', { applied, latencyMs: Date.now() - t0, kind: 'refine' });
    }
    S.lastRefineAt = Date.now();
    S.nodesSinceRefine = 0;
    persist();
  } catch (e) {
    S.counters.llmFails++;
    S.lastRefineAt = Date.now(); // Refinerは持ち越さない（次の周期でやり直せば良い）
    emit('error', { message: `整理パス失敗: ${e.message}` });
  } finally {
    S.inFlight = false;
    emit('status', { phase: 'idle' });
  }
}

/* ===== プロンプト構築 ===== */
function buildPrompt(newText) {
  const t = S.template;
  return [
    SYSTEM_MD,
    `# テンプレート指針（${t.name}）`, t.instructions, '',
    '# 色の意味（このテンプレでの使い分け）',
    Object.entries(t.vocab || {}).map(([k, v]) => `- ${k} = ${v}`).join('\n'), '',
    '# 現在のボード', outlineText(S.doc), '',
    '# ここまでの要約', S.doc.summary || '（まだ無し）', '',
    '# 新しい発言（文字起こし・誤認識を含む可能性あり）', newText, '',
    '# 指示',
    'スキーマに従う差分パッチJSONのみを出力。新情報が無ければ {"ops":[]} を返す。',
  ].join('\n');
}

function buildRefinePrompt() {
  const tail = readTranscriptTail(2000);
  return [
    SYSTEM_MD, REFINE_MD,
    `# テンプレート指針（${S.template.name}）`, S.template.instructions, '',
    '# 現在のボード（全体）', outlineText(S.doc), '',
    '# ここまでの要約', S.doc.summary || '（まだ無し）', '',
    '# 直近の発言（参考）', tail, '',
    '# 指示',
    'スキーマに従う差分パッチJSONのみを出力。整理不要なら {"ops":[]} を返す。',
  ].join('\n');
}

/** LLMに見せるボード表現（座標なし・コンパクト） */
function outlineText(doc) {
  const lines = [];
  for (const c of doc.clusters) {
    lines.push(`## クラスタ ${c.id}${c.label ? `「${c.label}」` : '（見出し無し）'}`);
    for (const n of doc.nodes.filter(n => n.cluster === c.id)) {
      lines.push(`- ${n.id} [${n.color || '-'}/${n.kind}]${n.parent ? ` (parent:${n.parent})` : ''} ${n.text}`);
    }
  }
  const orphans = doc.nodes.filter(n => !doc.clusters.some(c => c.id === n.cluster));
  if (orphans.length) { lines.push('## （クラスタ未所属）'); orphans.forEach(n => lines.push(`- ${n.id} [${n.color}/${n.kind}] ${n.text}`)); }
  if (doc.edges.length) lines.push('## エッジ\n' + doc.edges.map(e => `${e.from} → ${e.to}`).join(', '));
  return lines.join('\n') || '（空のボード）';
}

/** UI用のボード構造（JSON） */
function outlineJson(doc) {
  return {
    clusters: doc.clusters.map(c => ({
      id: c.id, label: c.label || '',
      nodes: doc.nodes.filter(n => n.cluster === c.id).map(n => ({ id: n.id, kind: n.kind, color: n.color, text: n.text })),
    })),
    edges: doc.edges.map(e => ({ from: e.from, to: e.to })),
  };
}

/** opの形ゆれ正規化（スキーマ強制をすり抜けたフラット形を救済する二重防御）
    例: {op:'add_node', id, type, text, parent:'c_x'} → {op:'add_node', node:{id, kind, text, cluster}} */
function normalizeOp(op) {
  if (!op || typeof op !== 'object') return op;
  if (op.op === 'add_edge' && op.edge && typeof op.edge === 'object' && !op.from) {
    return { op: 'add_edge', from: op.edge.from, to: op.edge.to };   // edge:{}ラッパー形
  }
  if (op.op === 'add_text' && op.id) {                               // 発明されがちな add_text → 注記ノード
    const parentRef = (typeof op.parent === 'string' && !op.parent.startsWith('c_')) ? op.parent : undefined;
    const clusterRef = (typeof op.parent === 'string' && op.parent.startsWith('c_')) ? op.parent : op.cluster;
    return { op: 'add_node', node: { id: op.id.replace(/^t_/, 'n_'), kind: 'text', text: op.text, cluster: clusterRef, parent: parentRef } };
  }
  if (op.op === 'add_node' && op.node && typeof op.node === 'object') {
    const n = { ...op.node };
    if (!n.kind && n.type) n.kind = n.type;                          // type→kind ゆれ
    delete n.type;
    if (!n.cluster && typeof n.parent === 'string' && n.parent.startsWith('c_')) { n.cluster = n.parent; delete n.parent; }
    return { op: 'add_node', node: n };
  }
  if (op.op === 'add_node' && !op.node && op.id) {
    const clusterRef = (op.cluster && typeof op.cluster === 'string') ? op.cluster
      : (typeof op.parent === 'string' && op.parent.startsWith('c_')) ? op.parent : undefined;
    const parentRef = (typeof op.parent === 'string' && op.parent.startsWith('n_')) ? op.parent : undefined;
    return { op: 'add_node', node: { id: op.id, kind: op.kind || op.type || 'sticky', color: op.color, text: op.text, cluster: clusterRef, parent: parentRef } };
  }
  if (op.op === 'add_cluster' && !op.cluster && op.id) {
    return { op: 'add_cluster', cluster: { id: op.id, label: op.label || '' } };
  }
  return op;
}

/* ===== パッチ適用（防御的） ===== */
async function applyOps(rawOps, source) {
  const ops = (rawOps || []).map(normalizeOp);
  const doc = S.doc;
  const applied = [];
  const toCreate = [];   // Miroへbulk作成するノード
  const tomb = new Set(doc.tombstones || []);
  const findNode = id => doc.nodes.find(n => n.id === id);
  const findCluster = id => doc.clusters.find(c => c.id === id);

  for (const op of ops) {
    try {
      if (op.op === 'add_cluster' && op.cluster && op.cluster.id) {
        if (findCluster(op.cluster.id)) continue;
        // 配置(anchor)と見出し作成はノードが入ってから（迷子見出し・空クラスタ防止）
        const c = { id: op.cluster.id, label: sliceCp(op.cluster.label, 60), anchor: null, cols: [], labelMiroId: null };
        doc.clusters.push(c);
        applied.push(op);

      } else if (op.op === 'add_node' && op.node && op.node.id) {
        const n = { ...op.node };
        if (tomb.has(n.id)) continue;
        while (findNode(n.id)) n.id = n.id + '2';                 // ID衝突はサフィックス
        if (n.parent && !findNode(n.parent)) n.parent = null;
        if (!['sticky', 'heading', 'text'].includes(n.kind)) n.kind = 'sticky';
        if (n.kind === 'text' && !n.parent) n.kind = 'sticky';     // 親なし注記は付箋に昇格（概念を消さない）
        if (!n.cluster || typeof n.cluster !== 'string') {
          const pn = n.parent && findNode(n.parent);
          const lastNode = doc.nodes[doc.nodes.length - 1];
          n.cluster = pn ? pn.cluster                              // cluster欠落は親から継承 or 直近の話題へ
            : (lastNode && lastNode.cluster) || (doc.clusters[0] && doc.clusters[0].id) || 'c_main';
        }
        if (!findCluster(n.cluster)) {                             // 未知クラスタは自動作成（黙って捨てない）
          const c = { id: n.cluster, label: '', anchor: null, slotCount: 0, labelMiroId: null };
          layout.placeCluster(doc, c); doc.clusters.push(c);
        }
        if (n.kind === 'sticky' && !miro.COLOR_MAP[n.color]) n.color = 'yellow';
        n.text = sliceCp(n.text, 120);
        layout.placeNode(doc, n);
        n.miroId = null; n.source = source;
        doc.nodes.push(n);
        toCreate.push(n);
        // 注: parentは「流れ＝真下配置」の宣言であり、矢印は自動では張らない
        //（ぬこ板書踏襲: 矢印は強調・意外な関連を示すエッセンス。LLMが明示的にadd_edgeした時のみ）
        applied.push({ ...op, node: { ...n } });

      } else if (op.op === 'update_node' && op.id) {
        const n = findNode(op.id);
        if (!n) continue;
        if (op.text !== undefined) n.text = sliceCp(op.text, 120);
        if (op.color !== undefined && miro.COLOR_MAP[op.color]) n.color = op.color;
        if (n.miroId) {
          if (n.kind === 'sticky') await miro.updateSticky(S.meta.boardId, n.miroId, { text: op.text, color: op.color });
          else await miro.updateText(S.meta.boardId, n.miroId, { text: n.text });
        }
        applied.push(op);

      } else if (op.op === 'add_edge' && op.from && op.to) {
        const a = findNode(op.from), b = findNode(op.to);
        if (!a || !b || a === b) continue;
        if (doc.edges.some(e => e.from === op.from && e.to === op.to)) continue;
        const e = { id: `e_${doc.edges.length + 1}_${op.from}`, from: op.from, to: op.to, miroId: null };
        doc.edges.push(e);
        applied.push(op);
        // コネクタはノードのmiroId確定後に張る（後段でまとめて）

      } else if (op.op === 'rename_cluster' && op.id) {
        const c = findCluster(op.id);
        if (!c) continue;
        c.label = sliceCp(op.label, 60);
        if (c.labelMiroId) await miro.updateText(S.meta.boardId, c.labelMiroId, { text: c.label });
        // 未作成なら後段の見出しパスで作られる
        applied.push(op);

      } else if (op.op === 'merge_nodes' && op.keep && op.remove) {
        if (!ALLOW_DESTRUCTIVE) continue;
        const keep = findNode(op.keep), rem = findNode(op.remove);
        if (!keep || !rem || keep === rem) continue;
        // removeへの参照をkeepへ付け替え → remove削除（墓標化）
        for (const e of doc.edges) { if (e.from === rem.id) e.from = keep.id; if (e.to === rem.id) e.to = keep.id; }
        for (const n of doc.nodes) if (n.parent === rem.id) n.parent = keep.id;
        doc.edges = doc.edges.filter((e, i, arr) => e.from !== e.to && arr.findIndex(x => x.from === e.from && x.to === e.to) === i);
        doc.nodes = doc.nodes.filter(n => n !== rem);
        tomb.add(rem.id);
        if (rem.miroId) await miro.deleteItem(S.meta.boardId, rem.miroId, rem.kind).catch(() => {});
        applied.push(op);

      } else if (op.op === 'set_summary' && op.text) {
        doc.summary = sliceCp(op.text, 800);
        applied.push(op);
      }
    } catch (e) {
      emit('error', { message: `op適用失敗(${op.op}): ${e.message}` });
    }
  }

  // ノードをMiroへ一括作成（入力順にmiroIdが返る。wで付箋サイズ可変）
  if (toCreate.length) {
    try {
      const ids = await miro.createNodes(S.meta.boardId, toCreate.map(n => ({ kind: n.kind, color: n.color, text: n.text, x: n.pos.x, y: n.pos.y, w: n.w })));
      toCreate.forEach((n, i) => { n.miroId = ids[i]; });
      S.counters.nodes += toCreate.length;
      S.nodesSinceRefine += toCreate.length;
    } catch (e) {
      emit('error', { message: `Miro作成失敗（BoardDocには記録済み・キャッチアップで復旧可能）: ${e.message}` });
    }
  }
  // 両端のmiroIdが揃ったエッジにコネクタを張る。
  // ★遠距離（=他の付箋を跨ぐ可能性が高い）矢印は描かない（エグゼ板書スタイル: 直結のみ）
  for (const e of doc.edges.filter(e => !e.miroId && !e.noRender)) {
    const a = findNode(e.from), b = findNode(e.to);
    if (!a || !b || !a.miroId || !b.miroId) continue;
    if (layout.nodeDistance(a, b) > 800) { e.noRender = true; continue; } // Markdown出力等には残す
    try { e.miroId = await miro.createConnector(S.meta.boardId, a.miroId, b.miroId); }
    catch (err) { emit('error', { message: `コネクタ作成失敗: ${err.message}` }); }
  }
  // 見出しパス: 中身が入ったクラスタ（島）の左上へ見出しを作る（迷子防止・遅延作成）
  for (const c of doc.clusters) {
    if (!c.label || c.labelMiroId || c.label === 'テーマ' || !c.anchor) continue;
    const own = doc.nodes.filter(n => n.cluster === c.id && n.pos);
    if (!own.length) continue;
    const lp = layout.labelPos(c);
    try {
      const [mid] = await miro.createNodes(S.meta.boardId, [{ kind: 'heading', text: c.label, x: lp.x, y: lp.y }]);
      c.labelMiroId = mid;
      c.labelPos = lp;
    } catch (err) { emit('error', { message: `見出し作成失敗: ${err.message}` }); }
  }

  doc.tombstones = [...tomb];
  doc.version++;
  if (applied.length) appendJsonl('ops.jsonl', { t: Date.now(), source, ops: applied, v: doc.version });
  return applied;
}

/* ===== Markdown出力 ===== */
function toMarkdown() {
  if (!S) throw new Error('セッション未開始');
  const d = S.doc;
  const lines = [`# ${S.meta.title || 'Voice-Miro セッション'}`, '', `> ${d.summary || ''}`, ''];
  for (const c of d.clusters) {
    lines.push(`## ${c.label || c.id}`);
    for (const n of d.nodes.filter(n => n.cluster === c.id)) {
      const mark = n.color === 'pink' ? '**' : '';
      lines.push(`- ${mark}${n.text}${mark}${n.color === 'red' ? ' 🎯' : ''}`);
    }
    lines.push('');
  }
  if (d.edges.length) {
    lines.push('## 関係');
    const byId = id => (d.nodes.find(n => n.id === id) || {}).text || id;
    d.edges.forEach(e => lines.push(`- ${byId(e.from)} → ${byId(e.to)}`));
  }
  return lines.join('\n');
}

/* ===== MOCKパッチ（開発用の缶詰） ===== */
let mockIdx = 0;
const MOCK_SCRIPT = [
  { ops: [{ op: 'add_cluster', cluster: { id: 'c_biz', label: 'ビジネスの型' } }, { op: 'add_node', node: { id: 'n_kasegu', kind: 'sticky', color: 'red', text: 'お金を稼ぎたい', cluster: 'c_biz' } }] },
  { ops: [{ op: 'add_node', node: { id: 'n_sns_note', kind: 'sticky', color: 'green', text: 'SNS×note', cluster: 'c_biz' } }, { op: 'add_node', node: { id: 'n_buppan', kind: 'sticky', color: 'green', text: '物販', cluster: 'c_biz' } }, { op: 'add_edge', from: 'n_kasegu', to: 'n_sns_note' }] },
  { ops: [{ op: 'add_cluster', cluster: { id: 'c_market', label: '市場' } }, { op: 'add_node', node: { id: 'n_juyou', kind: 'sticky', color: 'pink', text: '需要', cluster: 'c_market' } }, { op: 'add_node', node: { id: 'n_seikou', kind: 'sticky', color: 'yellow', text: '成功事例を調べる', cluster: 'c_market' } }, { op: 'add_node', node: { id: 'n_getu100', kind: 'text', text: '月100万', cluster: 'c_market', parent: 'n_seikou' } }], summary: '稼ぐにはビジネスの型と市場理解が必要という話。' },
  { ops: [{ op: 'add_node', node: { id: 'n_mane', kind: 'sticky', color: 'yellow', text: '真似する', cluster: 'c_market' } }, { op: 'add_edge', from: 'n_seikou', to: 'n_mane' }, { op: 'update_node', id: 'n_sns_note', color: 'pink' }] },
];
function nextMockPatch() { const p = MOCK_SCRIPT[mockIdx % MOCK_SCRIPT.length]; mockIdx++; return JSON.parse(JSON.stringify(p)); }

/* ===== 永続化 ===== */
function persist() {
  if (!S) return;
  const snap = { meta: S.meta, doc: S.doc, counters: S.counters, savedAt: Date.now() };
  try { fs.writeFileSync(path.join(S.dir, 'session.json'), JSON.stringify(snap, null, 1)); } catch (e) {}
}
function appendJsonl(file, obj) {
  try { fs.appendFileSync(path.join(S.dir, file), JSON.stringify(obj) + '\n'); } catch (e) {}
}
function readTranscriptTail(chars) {
  try {
    const s = fs.readFileSync(path.join(S.dir, 'transcript.jsonl'), 'utf8');
    return s.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l).text; } catch (e) { return ''; } }).join('\n').slice(-chars);
  } catch (e) { return ''; }
}
function sanitize(s) { return String(s).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) || 'session'; }

module.exports = { templates, startSession, endSession, addTranscript, tick, generate, refine, current, publicState, toMarkdown, onEvent, MOCK };
