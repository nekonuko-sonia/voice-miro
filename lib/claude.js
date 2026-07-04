/* claude.js — Claude Code CLI (Maxサブスク) をヘッドレスで呼ぶ層
   ---------------------------------------------------------------------------
   移植元: ねこぬこ自動投稿/worker/draft-worker.js の runClaude/parseResult。
   強化点:
   - `--output-format json` のエンベロープ対応（regex頼みを卒業。ただしフォールバックは維持）
   - `--json-schema` で構造化出力を強制（パッチスキーマ準拠）
   - `--tools "" --no-session-persistence --setting-sources ""` で高速化・副作用ゼロ
   - タイムアウトkill（既定180秒）→ 呼び出し元がテキストを持ち越して次周期で再試行
   - Windowsで claude が .cmd シムだった場合の shell:true フォールバック
   ※ `--bare` は使わない（Max認証が壊れる） */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const CLAUDE_BIN = (process.env.CLAUDE_BIN || 'claude').trim();
const MODEL = (process.env.MODEL || 'sonnet').trim();
const TIMEOUT_MS = parseInt(process.env.CLAUDE_TIMEOUT_MS || '180000', 10);
const SCHEMA_PATH = path.join(__dirname, '..', 'prompts', 'patch.schema.json');

let SCHEMA_JSON = null; // --json-schema はインラインJSON文字列を要求（ファイルパス不可）
try { SCHEMA_JSON = JSON.stringify(JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'))); } catch (e) {}

function buildArgs(model) {
  const args = ['-p', '--model', model || MODEL,
    '--output-format', 'json',
    '--tools', '',
    '--no-session-persistence',
    '--setting-sources', '',
  ];
  if (SCHEMA_JSON) args.push('--json-schema', SCHEMA_JSON);
  return args;
}

function spawnClaude(args, useShell) {
  return spawn(CLAUDE_BIN, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: !!useShell });
}

/** プロンプトをstdinで渡し、stdout全文を返す。タイムアウトでkill。 */
function runClaude(prompt, model) {
  return new Promise((resolve, reject) => {
    const args = buildArgs(model);
    let p;
    try { p = spawnClaude(args, false); }
    catch (e) { p = spawnClaude(args, true); }
    let out = '', err = '', settled = false;
    const timer = setTimeout(() => {
      if (settled) return; settled = true;
      try { p.kill('SIGKILL'); } catch (e) {}
      reject(new Error(`claude timeout ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);
    const done = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); fn(v); };
    p.stdout.on('data', d => out += d.toString());
    p.stderr.on('data', d => err += d.toString());
    p.on('error', e => {
      if (e.code === 'ENOENT' && process.platform === 'win32') {
        // .cmdシム対策: shell経由で1回だけ再試行
        try {
          const p2 = spawnClaude(args, true);
          let out2 = '', err2 = '';
          p2.stdout.on('data', d => out2 += d.toString());
          p2.stderr.on('data', d => err2 += d.toString());
          p2.on('error', e2 => done(reject, e2));
          p2.on('close', c => c === 0 ? done(resolve, out2) : done(reject, new Error(`claude exit ${c}: ${err2.slice(0, 300)}`)));
          p2.stdin.write(prompt); p2.stdin.end();
          return;
        } catch (e2) { return done(reject, e2); }
      }
      done(reject, e);
    });
    p.on('close', code => code === 0 ? done(resolve, out) : done(reject, new Error(`claude exit ${code}: ${err.slice(0, 300)}`)));
    p.stdin.write(prompt); p.stdin.end();
  });
}

/** stdout → パッチobj。3段フォールバック: ①jsonエンベロープ ②regex抽出 ③null（呼び出し元が持ち越し） */
function parsePatch(stdout) {
  const s = String(stdout || '').trim();
  // ① --output-format json のエンベロープ {type:"result", result:..., structured_output?:...}
  try {
    const env = JSON.parse(s);
    if (env && typeof env === 'object') {
      if (env.is_error) return null;
      const cand = env.structured_output !== undefined ? env.structured_output : env.result;
      if (cand && typeof cand === 'object' && Array.isArray(cand.ops)) return cand;
      if (typeof cand === 'string') {
        try { const o = JSON.parse(cand); if (o && Array.isArray(o.ops)) return o; } catch (e) {}
        const m = cand.match(/\{[\s\S]*\}/);
        if (m) { try { const o = JSON.parse(m[0]); if (o && Array.isArray(o.ops)) return o; } catch (e) {} }
      }
      // エンベロープ自体がパッチだった場合
      if (Array.isArray(env.ops)) return env;
    }
  } catch (e) {}
  // ② 素のstdoutからJSONブロック抽出（draft-worker流）
  const m = s.match(/\{[\s\S]*\}/);
  if (m) { try { const o = JSON.parse(m[0]); if (o && Array.isArray(o.ops)) return o; } catch (e) {} }
  // ③ 諦める（ボードは壊さない）
  return null;
}

module.exports = { runClaude, parsePatch, MODEL, CLAUDE_BIN };
