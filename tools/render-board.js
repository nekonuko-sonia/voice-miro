/* render-board.js — BoardDocをMiro風HTMLに描画（自己検証用の「目」）
   使い方: node tools/render-board.js <sessions/xxx/session.json> <out.html>
   ヘッドレスChromeでスクショを撮ればレイアウトの見た目を機械的に確認できる。
   注意: コネクタ描画は直線近似（Miroの実ルーティングとは異なる）。付箋の
   位置・サイズ・色・重なりの検証が目的。 */
const fs = require('fs');

const [, , inFile, outFile] = process.argv;
if (!inFile || !outFile) { console.error('usage: node render-board.js <session.json> <out.html>'); process.exit(1); }
const snap = JSON.parse(fs.readFileSync(inFile, 'utf8'));
const doc = snap.doc || snap;

const FILL = { red: '#f0837b', green: '#93d275', yellow: '#fdee56', pink: '#f38ad0' }; // 原色系（Miro red/green/yellow/pink近似）
const estH = n => n.kind === 'sticky' ? Math.round((n.w || 199) * 1.145) : (n.kind === 'heading' ? 60 : 44);

// 見出し位置: labelPos > クラスタ内最上ノードの真上 > anchor
function resolveLabelPos(c) {
  if (c.labelPos) return c.labelPos;
  const own = doc.nodes.filter(n => n.cluster === c.id && n.pos);
  if (own.length) { const top = own.reduce((a, b) => (a.pos.y <= b.pos.y ? a : b)); return { x: top.pos.x, y: top.pos.y - estH(top) / 2 - 70 }; }
  return c.anchor ? { x: c.anchor.x + 60, y: c.anchor.y - 120 } : null;
}

// バウンディングボックス
let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
const all = [...doc.nodes];
for (const c of doc.clusters) { const lp = c.label && c.label !== 'テーマ' && resolveLabelPos(c); if (lp) all.push({ pos: lp, w: 320, kind: 'heading', text: c.label }); }
for (const n of all) {
  if (!n.pos) continue;
  const w = n.w || 200, h = estH(n);
  minX = Math.min(minX, n.pos.x - w / 2); maxX = Math.max(maxX, n.pos.x + w / 2);
  minY = Math.min(minY, n.pos.y - h / 2); maxY = Math.max(maxY, n.pos.y + h / 2);
}
const PAD = 80, W = maxX - minX + PAD * 2, H = maxY - minY + PAD * 2;
const tx = x => x - minX + PAD, ty = y => y - minY + PAD;

const parts = [];
parts.push(`<div style="position:relative;width:${W}px;height:${H}px;background:#f2f3f5;font-family:'Yu Gothic UI',sans-serif;">`);
// エッジ（直線・矢尻）
parts.push(`<svg width="${W}" height="${H}" style="position:absolute;inset:0">`);
parts.push(`<defs><marker id="a" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#555"/></marker></defs>`);
for (const e of doc.edges) {
  const a = doc.nodes.find(n => n.id === e.from), b = doc.nodes.find(n => n.id === e.to);
  if (!a || !b || !a.pos || !b.pos) continue;
  const skipped = e.noRender ? ' stroke-dasharray="6 4" opacity="0.25"' : '';
  parts.push(`<line x1="${tx(a.pos.x)}" y1="${ty(a.pos.y) + estH(a) / 2}" x2="${tx(b.pos.x)}" y2="${ty(b.pos.y) - estH(b) / 2}" stroke="#555" stroke-width="2" marker-end="url(#a)"${skipped}/>`);
}
parts.push('</svg>');
// クラスタ見出し
for (const c of doc.clusters) {
  if (!c.label || c.label === 'テーマ') continue;
  const lp = resolveLabelPos(c);
  if (!lp) continue;
  parts.push(`<div style="position:absolute;left:${tx(lp.x) - 160}px;top:${ty(lp.y) - 20}px;width:320px;text-align:center;font-weight:700;font-size:26px;color:#1a1a1a;">${esc(c.label)}</div>`);
}
// ノード
for (const n of doc.nodes) {
  if (!n.pos) continue;
  const w = n.w || 200, h = estH(n);
  const l = tx(n.pos.x) - w / 2, t = ty(n.pos.y) - h / 2;
  if (n.kind === 'sticky') {
    const len = Array.from(n.text || '').length;
    const perLine = 8, lines = Math.max(1, Math.ceil(len / perLine));
    const fs2 = Math.max(16, Math.min(30, Math.round(w / Math.min(len, perLine) * 1.5)));
    parts.push(`<div style="position:absolute;left:${l}px;top:${t}px;width:${w}px;height:${h}px;background:${FILL[n.color] || FILL.yellow};box-shadow:2px 3px 6px rgba(0,0,0,.2);display:flex;align-items:center;justify-content:center;text-align:center;padding:8px;box-sizing:border-box;font-size:${fs2}px;line-height:1.25;">${esc(n.text)}</div>`);
  } else if (n.kind === 'heading') {
    parts.push(`<div style="position:absolute;left:${l}px;top:${t}px;width:${w}px;font-weight:700;font-size:24px;text-align:center;">${esc(n.text)}</div>`);
  } else {
    parts.push(`<div style="position:absolute;left:${l}px;top:${t}px;width:${w}px;font-size:19px;color:#333;text-align:center;">${esc(n.text)}</div>`);
  }
}
parts.push('</div>');
function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

// 1枚のスクショに収まるようスケールを焼き込む（headless Chromeのdsf指定は効かない）
const scale = Math.min(1, 1400 / W, 1800 / H);
const sw = Math.ceil(W * scale), sh = Math.ceil(H * scale);
fs.writeFileSync(outFile, `<!doctype html><meta charset="utf-8"><body style="margin:0;width:${sw}px;height:${sh}px;overflow:hidden"><div style="transform:scale(${scale});transform-origin:0 0">${parts.join('\n')}</div></body>`);
console.log(`rendered: ${outFile} scale=${scale.toFixed(2)} → window-size=${sw},${sh}`);
