/* stt.js — 音声認識ファクトリ（soniox / deepgram / webspeech を同一IFで切替）
   ---------------------------------------------------------------------------
   使い方:
     const stt = createSTT('soniox', { onFinal, onInterim, onStatus });
     await stt.start(micDeviceId);  stt.stop();
   - クラウド系: サーバの /api/stt-token で一時トークンを取得（本キーはブラウザに出ない）
   - webspeech: Chrome内蔵・無料・キー不要（60秒切断はonend無条件再起動で対策）
   - 確定文(final)だけが onFinal → サーバ → LLMパイプラインへ。interimは表示のみ */
'use strict';

function createSTT(provider, cb) {
  if (provider === 'webspeech') return webSpeechSTT(cb);
  if (provider === 'soniox') return sonioxSTT(cb);
  if (provider === 'deepgram') return deepgramSTT(cb);
  throw new Error('不明なSTTプロバイダ: ' + provider);
}

/* ===== Web Speech API (Chrome) ===== */
function webSpeechSTT(cb) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null, running = false;
  return {
    async start() {
      if (!SR) throw new Error('このブラウザはWeb Speech API非対応です（Chromeを使ってください）');
      running = true;
      const boot = () => {
        if (!running) return;
        rec = new SR();
        rec.lang = 'ja-JP'; rec.continuous = true; rec.interimResults = true;
        rec.onresult = ev => {
          for (let i = ev.resultIndex; i < ev.results.length; i++) {
            const r = ev.results[i], text = r[0].transcript.trim();
            if (!text) continue;
            if (r.isFinal) cb.onFinal(text); else cb.onInterim(text);
          }
        };
        rec.onerror = e => { cb.onStatus(`webspeech: ${e.error}（自動再開）`); };
        rec.onend = () => { if (running) setTimeout(boot, 250); };  // 60秒切断・no-speech対策: 無条件再起動
        try { rec.start(); cb.onStatus('webspeech: 聴取中'); } catch (e) { setTimeout(boot, 1000); }
      };
      boot();
    },
    stop() { running = false; try { rec && rec.stop(); } catch (e) {} },
  };
}

/* ===== マイク→16kHz PCM16 共通パイプ（soniox/deepgram用） ===== */
async function openMicPcm(deviceId, onChunk) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: true, noiseSuppression: true },
  });
  const ctx = new AudioContext({ sampleRate: 16000 });
  const workletCode = `
    class PcmWorklet extends AudioWorkletProcessor {
      process(inputs) {
        const ch = inputs[0][0];
        if (ch) {
          const buf = new Int16Array(ch.length);
          for (let i = 0; i < ch.length; i++) {
            const s = Math.max(-1, Math.min(1, ch[i]));
            buf[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
          }
          this.port.postMessage(buf.buffer, [buf.buffer]);
        }
        return true;
      }
    }
    registerProcessor('pcm-worklet', PcmWorklet);`;
  const url = URL.createObjectURL(new Blob([workletCode], { type: 'text/javascript' }));
  await ctx.audioWorklet.addModule(url);
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'pcm-worklet');
  node.port.onmessage = e => onChunk(e.data);
  src.connect(node);
  return {
    close() {
      try { node.disconnect(); src.disconnect(); } catch (e) {}
      try { stream.getTracks().forEach(t => t.stop()); } catch (e) {}
      try { ctx.close(); } catch (e) {}
    },
  };
}

async function fetchToken(provider) {
  const res = await fetch('/api/stt-token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider }) });
  const j = await res.json();
  if (!res.ok || !j.token) throw new Error(j.error || provider + ' トークン取得失敗');
  return j.token;
}

/* ===== Soniox direct-stream ===== */
function sonioxSTT(cb) {
  let ws = null, mic = null, running = false;
  let finalBuf = '', flushTimer = null;
  const flush = () => { if (finalBuf.trim()) { cb.onFinal(finalBuf.trim()); finalBuf = ''; } };
  return {
    async start(deviceId) {
      running = true;
      const connect = async () => {
        if (!running) return;
        const token = await fetchToken('soniox');
        ws = new WebSocket('wss://stt-rt.soniox.com/transcribe-websocket');
        ws.onopen = () => {
          ws.send(JSON.stringify({
            api_key: token,
            model: 'stt-rt-preview',
            audio_format: 'pcm_s16le', sample_rate: 16000, num_channels: 1,
            language_hints: ['ja'],
            enable_endpoint_detection: true,
          }));
          cb.onStatus('soniox: 聴取中');
        };
        ws.onmessage = ev => {
          let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
          if (m.error_code) { cb.onStatus(`soniox error: ${m.error_message || m.error_code}`); return; }
          let interim = '', gotFinal = false, gotEnd = false;
          for (const t of (m.tokens || [])) {
            if (t.text === '<end>') { gotEnd = true; continue; }
            if (t.is_final) { finalBuf += t.text; gotFinal = true; } else interim += t.text;
          }
          if (interim) cb.onInterim(finalBuf + interim);
          if (gotEnd || finalBuf.length > 100) flush();
          else if (gotFinal) { clearTimeout(flushTimer); flushTimer = setTimeout(flush, 2500); }
        };
        ws.onclose = () => { if (running) { cb.onStatus('soniox: 再接続中…'); setTimeout(connect, 1500); } };
        ws.onerror = () => {};
        if (!mic) mic = await openMicPcm(deviceId, chunk => { if (ws && ws.readyState === 1) ws.send(chunk); });
      };
      await connect();
    },
    stop() { running = false; flush(); try { ws && ws.close(); } catch (e) {} if (mic) { mic.close(); mic = null; } },
  };
}

/* ===== Deepgram Nova-3 streaming ===== */
function deepgramSTT(cb) {
  let ws = null, mic = null, running = false;
  let finalBuf = '';
  const flush = () => { if (finalBuf.trim()) { cb.onFinal(finalBuf.trim()); finalBuf = ''; } };
  return {
    async start(deviceId) {
      running = true;
      const connect = async () => {
        if (!running) return;
        const token = await fetchToken('deepgram');
        const params = new URLSearchParams({
          model: 'nova-3', language: 'multi',
          encoding: 'linear16', sample_rate: '16000', channels: '1',
          interim_results: 'true', punctuate: 'true', smart_format: 'true',
          endpointing: '400',
        });
        ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, ['bearer', token]);
        ws.onopen = () => cb.onStatus('deepgram: 聴取中');
        ws.onmessage = ev => {
          let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
          if (m.type !== 'Results') return;
          const text = (((m.channel || {}).alternatives || [])[0] || {}).transcript || '';
          if (!text) { if (m.speech_final) flush(); return; }
          if (m.is_final) {
            finalBuf += (finalBuf ? ' ' : '') + text;
            if (m.speech_final || finalBuf.length > 100) flush();
          } else {
            cb.onInterim(finalBuf + ' ' + text);
          }
        };
        ws.onclose = () => { if (running) { cb.onStatus('deepgram: 再接続中…'); setTimeout(connect, 1500); } };
        ws.onerror = () => {};
        if (!mic) mic = await openMicPcm(deviceId, chunk => { if (ws && ws.readyState === 1) ws.send(chunk); });
      };
      await connect();
    },
    stop() { running = false; flush(); try { ws && ws.send(JSON.stringify({ type: 'CloseStream' })); ws.close(); } catch (e) {} if (mic) { mic.close(); mic = null; } },
  };
}
