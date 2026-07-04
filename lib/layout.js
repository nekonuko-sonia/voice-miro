/* layout.js v3 — 島（クラスタ）レイアウト
   ---------------------------------------------------------------------------
   参考: ぬこさんのMiroボード。設計思想:
   - クラスタ = 空間的にまとまった「島」。話の軸ごとに塊になる（構造の島／増え方の島…）
   - 島内は縦一直線ではなく【2列のコンパクトなマソンリー】＝塊感が出て縦幅が圧縮される
   - 島同士は左右2レーンのカスケードで空間的に分離（軸の違いが一目で分かる）
   - 注記(text)は親付箋の直下に小さく添え、その列の底を押し下げる
   - 決定的ジッタ（IDハッシュ）で「整列しすぎない」有機的な見た目
   - 付箋サイズは文字数・重要度で可変。原色系。矢印は張らない（pipeline側でエッセンスのみ）
   Miroのpositionは中心座標（origin=center）。すべて決定的。既存ノードは動かさない。 */

const CARD_GAP_X = 26;               // 島内・列間の隙間
const ROW_GAP = 30;                  // 島内・同列の付箋どうしの縦隙間
const NOTE_GAP = 10;                 // 付箋と注記の隙間
const NOTE_H = 50;                   // 注記の見込み高（フォント19に合わせ拡大）
const ISLAND_COLS = 2;               // 島内の列数（テーマ島は1）
const COL_UNIT = 190 + CARD_GAP_X;   // 島内1列ぶんの幅
const ISLAND_PITCH = 2 * COL_UNIT + 110; // 島どうしの横ピッチ（島は横に並ぶ）
const MAX_ROW_W = 3 * ISLAND_PITCH;  // この幅を超えたら次の行へ折り返し
const ROW_MARGIN = 360;              // 折り返し時の行間（十分に空けて島の後追い成長との衝突を防ぐ）
const LABEL_DX = -30, LABEL_DY = -84;// 島見出しは島の左上

function estH(node) {
  if (node.kind === 'sticky') return Math.round((node.w || 180) * 1.145);
  if (node.kind === 'heading') return 60;
  return NOTE_H;
}

function jitter(id, range) {
  let x = 7;
  for (const ch of String(id)) x = ((x * 31 + ch.charCodeAt(0)) >>> 0) % 100000;
  return (x % (2 * range + 1)) - range;
}

/** 付箋幅: 文字数と重要度で可変（視認性の工夫） */
function sizeOf(node) {
  if (node.kind !== 'sticky') return node.kind === 'heading' ? 320 : 200;
  const len = Array.from(String(node.text || '')).length;
  if (node.color === 'red') return 240;                  // テーマは最大
  if (node.color === 'pink') return len >= 12 ? 220 : 190; // 強調は大きめ
  if (len >= 16) return 210;
  if (len <= 6) return 140;
  return 170;
}

function initLayoutState(doc) {
  if (!doc.layoutState || doc.layoutState.slot === undefined) {
    doc.layoutState = { slot: 0, rowBaseY: 0, rowStartX: 0 };
  }
  return doc.layoutState;
}

/** 全ノードの最下端（折り返し行の基準） */
function maxBottom(doc) {
  let y = -1e9;
  for (const n of doc.nodes) if (n.pos) y = Math.max(y, n.pos.y + estH(n) / 2);
  return y === -1e9 ? 0 : y;
}

/** 島（クラスタ）を盤面に配置: 横に並べる。各島は独立カラムを持ち下方向に成長する
    （後から古い島にノードが追加されても、下は必ず空きなので衝突しない）。
    横がMAX_ROW_Wを超えたら次の行へ折り返し（行間は大きめに取る）。 */
function placeCluster(doc, cluster) {
  const st = initLayoutState(doc);
  let x = st.slot * ISLAND_PITCH;
  if (x + ISLAND_PITCH > MAX_ROW_W && st.slot > 0) {   // 折り返し
    st.rowBaseY = maxBottom(doc) + ROW_MARGIN;
    st.slot = 0;
    x = 0;
  }
  cluster.anchor = { x: x + jitter(cluster.id, 24), y: st.rowBaseY };
  cluster.cols = [];                 // [bottomY, ...] 島内各列の現在の底（絶対y）
  st.slot++;
  return cluster.anchor;
}

/** 島内で最も浅い列のindexを返す（マソンリー） */
function shallowestCol(cluster, ncols) {
  let best = 0, bestB = Infinity;
  for (let i = 0; i < ncols; i++) {
    const b = cluster.cols[i] === undefined ? cluster.anchor.y : cluster.cols[i];
    if (b < bestB) { bestB = b; best = i; }
  }
  return best;
}

function colX(cluster, i) {
  // 列幅は島の代表付箋幅ぶん（190想定）＋隙間
  return cluster.anchor.x + i * (190 + CARD_GAP_X) + jitter('c' + i, 10);
}

function placeNode(doc, node) {
  node.w = node.w || sizeOf(node);
  const hh = estH(node);

  // ── 注記(text+parent): 親付箋の真下に添える。親の列の底を押し下げる ──
  if (node.kind === 'text' && node.parent) {
    const parent = doc.nodes.find(n => n.id === node.parent);
    if (parent && parent.pos) {
      const sib = doc.nodes.filter(n => n.kind === 'text' && n.parent === node.parent && n.pos).length;
      const y = parent.pos.y + estH(parent) / 2 + NOTE_GAP + NOTE_H / 2 + sib * (NOTE_H + 4);
      node.pos = { x: parent.pos.x, y };
      const cl = doc.clusters.find(c => c.id === (parent.cluster || node.cluster));
      if (cl && cl.cols && parent.colIdx !== undefined) cl.cols[parent.colIdx] = Math.max(cl.cols[parent.colIdx] || 0, y + NOTE_H / 2);
      return node.pos;
    }
  }

  const cluster = doc.clusters.find(c => c.id === node.cluster);
  if (!cluster) { node.pos = { x: 0, y: 0 }; return node.pos; }
  if (!cluster.anchor) placeCluster(doc, cluster);
  if (!cluster.cols) cluster.cols = [];

  // 島内2列マソンリー（redテーマ付箋だけは横断幅を取るので1列目固定）
  const ncols = node.color === 'red' ? 1 : ISLAND_COLS;
  const ci = ncols === 1 ? 0 : shallowestCol(cluster, ncols);
  const prevBottom = cluster.cols[ci];
  const x = colX(cluster, ci) + jitter(node.id, 14);
  const y = (prevBottom === undefined ? cluster.anchor.y + hh / 2 : prevBottom + ROW_GAP + hh / 2);
  node.pos = { x, y };
  node.colIdx = ci;
  cluster.cols[ci] = y + hh / 2;
  return node.pos;
}

/** 島見出しの座標: 島の左上 */
function labelPos(cluster) {
  if (!cluster.anchor) return { x: 0, y: 0 };
  return { x: cluster.anchor.x + LABEL_DX, y: cluster.anchor.y + LABEL_DY };
}

function nodeDistance(a, b) {
  if (!a.pos || !b.pos) return Infinity;
  return Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y);
}

module.exports = { placeCluster, placeNode, labelPos, initLayoutState, sizeOf, estH, nodeDistance };
