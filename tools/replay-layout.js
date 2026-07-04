/* replay-layout.js — 記録済みセッションの論理構造を「現行のレイアウトエンジン」で再配置
   使い方: node tools/replay-layout.js <sessions/xxx/session.json> <out.json>
   LLM・Miroを呼ばずにレイアウト変更のA/Bを回すための開発ハーネス。
   render-board.js と組み合わせて視覚検証する。 */
const fs = require('fs');
const path = require('path');
const layout = require(path.join(__dirname, '..', 'lib', 'layout.js'));

const [, , inFile, outFile] = process.argv;
if (!inFile || !outFile) { console.error('usage: node replay-layout.js <session.json> <out.json>'); process.exit(1); }
const snap = JSON.parse(fs.readFileSync(inFile, 'utf8'));
const src = snap.doc || snap;

const doc = { nodes: [], edges: [], clusters: [], layoutState: null, tombstones: [] };
layout.initLayoutState(doc);

// クラスタは登録のみ（anchorはノード配置時に決まる）
for (const c of src.clusters) doc.clusters.push({ id: c.id, label: c.label || '', anchor: null, cols: [], labelMiroId: null });

// ノードを元の挿入順で再配置
for (const n of src.nodes) {
  const nn = { id: n.id, kind: n.kind, color: n.color, text: n.text, cluster: n.cluster, parent: n.parent };
  layout.placeNode(doc, nn);
  doc.nodes.push(nn);
}

// エッジ: 距離で描画可否を再判定
for (const e of src.edges) {
  const a = doc.nodes.find(n => n.id === e.from), b = doc.nodes.find(n => n.id === e.to);
  doc.edges.push({ from: e.from, to: e.to, noRender: !a || !b || layout.nodeDistance(a, b) > 800 });
}

// 見出し位置（pipelineの見出しパスと同じ規則: 島の左上）
for (const c of doc.clusters) {
  if (!c.label || c.label === 'テーマ' || !c.anchor) continue;
  const own = doc.nodes.filter(n => n.cluster === c.id && n.pos);
  if (!own.length) continue;
  c.labelPos = layout.labelPos(c);
}

fs.writeFileSync(outFile, JSON.stringify({ doc }, null, 1));
const ys = doc.nodes.filter(n => n.pos).map(n => n.pos.y), xs = doc.nodes.filter(n => n.pos).map(n => n.pos.x);
console.log(`replayed: nodes=${doc.nodes.length} 幅=${Math.round(Math.max(...xs) - Math.min(...xs))} 高さ=${Math.round(Math.max(...ys) - Math.min(...ys))} 描画edge=${doc.edges.filter(e => !e.noRender).length}/${doc.edges.length}`);
