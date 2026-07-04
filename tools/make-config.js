/* make-config.js — 現在の環境変数から config.local.json を生成（ソニアが1回だけ実行）
   使い方: node tools/make-config.js
   これで作った config.local.json をフォルダごと他の2人に渡せば、彼らは何も設定せず起動できる。 */
const fs = require('fs');
const path = require('path');

// 既定は「配布用＝Miroのみ・STTキーは含めない」→ 受け取った人は無料のWeb Speechになる。
// STTキーも焼き込みたい場合（自分専用configを作る等）は --with-stt を付ける。
const withStt = process.argv.includes('--with-stt');
const KEYS = withStt ? ['MIRO_TOKEN', 'SONIOX_API_KEY', 'DEEPGRAM_API_KEY', 'MODEL'] : ['MIRO_TOKEN', 'MODEL'];
const out = {};
for (const k of KEYS) {
  const v = (process.env[k] || '').trim();
  if (v) out[k] = v;
}
if (!out.MODEL) out.MODEL = 'sonnet';

const dest = path.join(__dirname, '..', 'config.local.json');
fs.writeFileSync(dest, JSON.stringify(out, null, 2) + '\n');

const mask = s => (s && s.length > 8 ? s.slice(0, 4) + '…' + s.slice(-2) + ` (len=${s.length})` : s ? '(set)' : '(なし)');
console.log('config.local.json を書き出しました:', dest);
for (const k of KEYS) console.log(`  ${k}: ${mask(out[k])}`);
if (!out.MIRO_TOKEN) console.log('\n⚠ MIRO_TOKEN が環境変数に見つかりません。先に setx MIRO_TOKEN "…" で設定してから再実行してください。');
if (!withStt) console.log('\n音声認識キーは含めていません（受け取った人は無料のWeb Speechになります）。\n※あなた自身は環境変数のSonioxがそのまま使われます。二人にもSonioxを使わせたい場合は --with-stt を付けて再生成。');
console.log('\nこの config.local.json を含めてフォルダごと他の2人に渡せば、彼らはダブルクリックだけで使えます。');
