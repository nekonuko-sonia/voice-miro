/* set-owner.js — update.meta.json と install.sh の __OWNER__ をGitHubユーザー名に置換
   使い方: node tools/set-owner.js <githubユーザー名> */
const fs = require('fs');
const path = require('path');
const owner = (process.argv[2] || '').trim();
if (!owner) { console.error('使い方: node tools/set-owner.js <githubユーザー名>'); process.exit(1); }

const root = path.join(__dirname, '..');
// update.meta.json
const metaPath = path.join(root, 'update.meta.json');
const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
meta.owner = owner;
fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
// install.sh
const shPath = path.join(root, 'install.sh');
let sh = fs.readFileSync(shPath, 'utf8').replace(/__OWNER__/g, owner);
fs.writeFileSync(shPath, sh);

console.log(`owner を ${owner} に設定しました（update.meta.json, install.sh）。`);
console.log(`二人に送る1行:\n  curl -fsSL https://raw.githubusercontent.com/${owner}/voice-miro/main/install.sh | MIRO_TOKEN='<ソニアのMiroトークン>' bash`);
