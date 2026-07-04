/* push-board.js — BoardDoc(JSON)を新しいMiroボードとして一括作成
   使い方: MIRO_TOKEN=... node tools/push-board.js <doc.json> "<ボード名>"
   用途: 過去セッションを改良版レイアウトで作り直す／replay-layout.jsの結果を実機確認 */
const fs = require('fs');
const path = require('path');
const miro = require(path.join(__dirname, '..', 'lib', 'miro.js'));

const [, , inFile, name] = process.argv;
if (!inFile) { console.error('usage: node push-board.js <doc.json> "<board name>"'); process.exit(1); }
const snap = JSON.parse(fs.readFileSync(inFile, 'utf8'));
const doc = snap.doc || snap;

(async () => {
  const board = await miro.createBoard(name || 'Voice-Miro 再生成');
  console.log('board:', board.viewLink || board.id);

  // ノード一括作成（挿入順）
  const nodes = doc.nodes.filter(n => n.pos);
  const ids = await miro.createNodes(board.id, nodes.map(n => ({ kind: n.kind, color: n.color, text: n.text, x: n.pos.x, y: n.pos.y, w: n.w })));
  nodes.forEach((n, i) => { n.miroId = ids[i]; });
  console.log(`nodes: ${nodes.length}`);

  // クラスタ見出し
  let labels = 0;
  for (const c of doc.clusters) {
    if (!c.label || c.label === 'テーマ' || !c.labelPos) continue;
    await miro.createNodes(board.id, [{ kind: 'heading', text: c.label, x: c.labelPos.x, y: c.labelPos.y }]);
    labels++;
  }
  // コネクタ（描画対象のみ）
  let conns = 0;
  for (const e of doc.edges.filter(e => !e.noRender)) {
    const a = nodes.find(n => n.id === e.from), b = nodes.find(n => n.id === e.to);
    if (a && b && a.miroId && b.miroId) { await miro.createConnector(board.id, a.miroId, b.miroId); conns++; }
  }
  console.log(`labels: ${labels} / connectors: ${conns}`);
  console.log('完了。ボードを開いて確認:', board.viewLink || board.id);
})().catch(e => { console.error('失敗:', e.message); process.exit(1); });
