/**
 * Kira Nova Sonic Proxy Server v8
 * Non-interactive text input, verbatim TTS
 */
const { BedrockRuntimeClient, InvokeModelWithBidirectionalStreamCommand } = require("@aws-sdk/client-bedrock-runtime");
const WebSocket = require("ws");
const http = require("http");
const { v4: uuidv4 } = require("uuid");

const PORT = process.env.PORT || 3000;
const MODEL_ID = "amazon.nova-2-sonic-v1:0";
const VOICE_MAP = {
  "Warm & Friendly": "tiffany", "Professional": "matthew",
  "Playful": "tiffany", "Calm & Gentle": "tiffany",
  "Bold & Confident": "matthew", "Youthful": "tiffany", "default": "tiffany",
};

const bedrock = new BedrockRuntimeClient({
  region: process.env.AWS_REGION || "us-east-1",
  credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY },
});

const SILENT = Buffer.alloc(1024, 0).toString("base64");

function buildWav(pcm, sr = 24000) {
  const h = Buffer.alloc(44);
  h.write("RIFF",0); h.writeUInt32LE(36+pcm.length,4); h.write("WAVE",8);
  h.write("fmt ",12); h.writeUInt32LE(16,16); h.writeUInt16LE(1,20);
  h.writeUInt16LE(1,22); h.writeUInt32LE(sr,24); h.writeUInt32LE(sr*2,28);
  h.writeUInt16LE(2,32); h.writeUInt16LE(16,34); h.write("data",36);
  h.writeUInt32LE(pcm.length,40);
  return Buffer.concat([h, pcm]);
}

function ev(obj) { return { chunk: { bytes: Buffer.from(JSON.stringify(obj)) }}; }
function safeSend(ws, data) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data)); }

async function handleSpeak(ws, { text, personality = "default", requestId }) {
  if (!text?.trim()) return;
  const voiceId = VOICE_MAP[personality] || "tiffany";
  const pn = uuidv4(), sc = uuidv4(), ac = uuidv4(), tc = uuidv4();
  const pcm = [];
  console.log(`[Sonic v8] "${text.slice(0,60)}" voice=${voiceId}`);
  safeSend(ws, { type: "start", requestId });
  try {
    async function* stream() {
      yield ev({ event: { sessionStart: { inferenceConfiguration: { maxTokens: 1024, topP: 0.9, temperature: 0.7 }}}});
      yield ev({ event: { promptStart: { promptName: pn,
        textOutputConfiguration: { mediaType: "text/plain" },
        audioOutputConfiguration: { mediaType: "audio/lpcm", sampleRateHertz: 24000, sampleSizeBits: 16, channelCount: 1, voiceId, encoding: "base64", audioType: "SPEECH" },
      }}});
      yield ev({ event: { contentStart: { promptName: pn, contentName: sc, type: "TEXT", interactive: false, role: "SYSTEM", textInputConfiguration: { mediaType: "text/plain" }}}});
      yield ev({ event: { textInput: { promptName: pn, contentName: sc, content: "You are a TTS system. Speak the user text verbatim as audio. Do not respond or add anything." }}});
      yield ev({ event: { contentEnd: { promptName: pn, contentName: sc }}});
      yield ev({ event: { contentStart: { promptName: pn, contentName: ac, type: "AUDIO", interactive: false, role: "USER", audioInputConfiguration: { mediaType: "audio/lpcm", sampleRateHertz: 16000, sampleSizeBits: 16, channelCount: 1, audioType: "SPEECH", encoding: "base64" }}}});
      for (let i = 0; i < 8; i++) yield ev({ event: { audioInput: { promptName: pn, contentName: ac, content: SILENT }}});
      yield ev({ event: { contentEnd: { promptName: pn, contentName: ac }}});
      yield ev({ event: { contentStart: { promptName: pn, contentName: tc, type: "TEXT", interactive: false, role: "USER", textInputConfiguration: { mediaType: "text/plain" }}}});
      yield ev({ event: { textInput: { promptName: pn, contentName: tc, content: text }}});
      yield ev({ event: { contentEnd: { promptName: pn, contentName: tc }}});
      yield ev({ event: { promptEnd: { promptName: pn }}});
      yield ev({ event: { sessionEnd: {} }});
    }
    const res = await bedrock.send(new InvokeModelWithBidirectionalStreamCommand({ modelId: MODEL_ID, body: stream() }));
    for await (const chunk of res.body) {
      if (chunk.internalServerException) { console.error("[Sonic]", chunk.internalServerException.message); break; }
      if (chunk.modelStreamErrorException) { console.error("[Sonic]", chunk.modelStreamErrorException.message); break; }
      if (!chunk.chunk?.bytes) continue;
      try {
        const e = JSON.parse(Buffer.from(chunk.chunk.bytes).toString("utf-8"));
        const ev2 = e.event || {};
        const k = Object.keys(ev2);
        if (k.length) console.log("[Sonic] Event:", k[0], JSON.stringify(ev2[k[0]])?.slice(0,60));
        if (ev2.audioOutput?.content) { pcm.push(Buffer.from(ev2.audioOutput.content, "base64")); console.log(`[Sonic] PCM chunk ${pcm.length}`); }
      } catch { console.log("[Sonic] Binary:", chunk.chunk.bytes.length, "bytes"); }
    }
    if (pcm.length === 0) { safeSend(ws, { type: "error", message: "No audio generated", requestId }); return; }
    const wav = buildWav(Buffer.concat(pcm));
    console.log(`[Sonic] SUCCESS ${(wav.length/1024).toFixed(1)}KB WAV`);
    safeSend(ws, { type: "wav_audio", audio: wav.toString("base64"), sampleRate: 24000, requestId });
    safeSend(ws, { type: "done", requestId, chunks: pcm.length });
  } catch (err) { console.error("[Sonic] Fatal:", err.message); safeSend(ws, { type: "error", message: err.message, requestId }); }
}

const server = http.createServer((req, res) => { res.writeHead(200, {"Content-Type":"application/json"}); res.end(JSON.stringify({ status: "ok", version: "v8", model: MODEL_ID })); });
const wss = new WebSocket.Server({ server });
wss.on("connection", ws => {
  console.log("[Server] Connected");
  ws.on("message", async raw => { let m; try { m = JSON.parse(raw.toString()); } catch { return; } if (m.type==="speak") await handleSpeak(ws,m); if (m.type==="ping") safeSend(ws,{type:"pong"}); });
  ws.on("close", () => console.log("[Server] Disconnected"));
  ws.on("error", e => console.error("[Server] Error:", e.message));
});
server.listen(PORT, () => { console.log(`Kira Nova Sonic v8 on port ${PORT}`); });
