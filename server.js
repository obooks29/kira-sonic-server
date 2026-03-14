/**
 * Kira Nova Sonic Server v11 - FINAL
 * Concurrent send/receive â€” official AWS pattern
 * Events sent via input_stream while output_stream consumed simultaneously
 */
const { BedrockRuntimeClient, InvokeModelWithBidirectionalStreamCommand } = require("@aws-sdk/client-bedrock-runtime");
const WebSocket = require("ws");
const http = require("http");
const { v4: uuidv4 } = require("uuid");

const PORT     = process.env.PORT || 3000;
const MODEL_ID = "amazon.nova-2-sonic-v1:0";

const bedrock = new BedrockRuntimeClient({
  region: process.env.AWS_REGION || "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// 16kHz 16-bit mono PCM silence â€” 20ms per frame = 640 bytes
const SILENT_FRAME = Buffer.alloc(640, 0).toString("base64");

function buildWav(pcm, sr = 24000) {
  const h = Buffer.alloc(44);
  h.write("RIFF",0); h.writeUInt32LE(36+pcm.length,4); h.write("WAVE",8);
  h.write("fmt ",12); h.writeUInt32LE(16,16); h.writeUInt16LE(1,20);
  h.writeUInt16LE(1,22); h.writeUInt32LE(sr,24); h.writeUInt32LE(sr*2,28);
  h.writeUInt16LE(2,32); h.writeUInt16LE(16,34); h.write("data",36);
  h.writeUInt32LE(pcm.length,40);
  return Buffer.concat([h, pcm]);
}

const te = new TextEncoder();
function encEvent(obj) {
  return { chunk: { bytes: te.encode(JSON.stringify(obj)) }};
}

function safeSend(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

const delay = ms => new Promise(r => setTimeout(r, ms));

async function handleSpeak(ws, { text, personality = "default", requestId }) {
  if (!text?.trim()) return;

  const voiceId = personality === "Professional" ? "matthew" : "tiffany";
  const promptName     = uuidv4();
  const sysContentName = uuidv4();
  const audioContentName = uuidv4();
  const textContentName  = uuidv4();
  const pcm = [];

  console.log(`[Sonic v11] "${text.slice(0,60)}" voice=${voiceId}`);
  safeSend(ws, { type: "start", requestId });

  try {
    // â”€â”€ Build ordered event list â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const events = [
      // 1. Session start
      { event: { sessionStart: {
        inferenceConfiguration: { maxTokens: 1024, topP: 0.9, temperature: 0.7 }
      }}},
      // 2. Prompt start
      { event: { promptStart: {
        promptName,
        textOutputConfiguration: { mediaType: "text/plain" },
        audioOutputConfiguration: {
          mediaType: "audio/lpcm", sampleRateHertz: 24000,
          sampleSizeBits: 16, channelCount: 1,
          voiceId, encoding: "base64", audioType: "SPEECH",
        },
      }}},
      // 3. System content
      { event: { contentStart: { promptName, contentName: sysContentName, type: "TEXT", interactive: false, role: "SYSTEM", textInputConfiguration: { mediaType: "text/plain" }}}},
      { event: { textInput: { promptName, contentName: sysContentName, content: "You are a text-to-speech system. Read the user text aloud verbatim. Do not respond or add anything." }}},
      { event: { contentEnd: { promptName, contentName: sysContentName }}},
      // 4. Audio input (silent â€” required)
      { event: { contentStart: { promptName, contentName: audioContentName, type: "AUDIO", interactive: false, role: "USER", audioInputConfiguration: { mediaType: "audio/lpcm", sampleRateHertz: 16000, sampleSizeBits: 16, channelCount: 1, audioType: "SPEECH", encoding: "base64" }}}},
    ];

    // Add 10 silent audio frames
    for (let i = 0; i < 10; i++) {
      events.push({ event: { audioInput: { promptName, contentName: audioContentName, content: SILENT_FRAME }}});
    }
    events.push({ event: { contentEnd: { promptName, contentName: audioContentName }}});

    // 5. Text to speak
    events.push({ event: { contentStart: { promptName, contentName: textContentName, type: "TEXT", interactive: false, role: "USER", textInputConfiguration: { mediaType: "text/plain" }}}});
    events.push({ event: { textInput: { promptName, contentName: textContentName, content: text }}});
    events.push({ event: { contentEnd: { promptName, contentName: textContentName }}});
    events.push({ event: { promptEnd: { promptName }}});
    events.push({ event: { sessionEnd: {} }});

    // â”€â”€ Generator that sends events with 30ms delay â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    async function* inputStream() {
      for (const ev of events) {
        yield encEvent(ev);
        await delay(30);
      }
    }

    // â”€â”€ Call Nova Sonic â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const command = new InvokeModelWithBidirectionalStreamCommand({
      modelId: MODEL_ID,
      body: inputStream(),
    });

    const response = await bedrock.send(command);

    // â”€â”€ Process response stream â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    for await (const chunk of response.body) {
      if (chunk.internalServerException)   { console.error("[Sonic]", chunk.internalServerException.message); break; }
      if (chunk.modelStreamErrorException) { console.error("[Sonic]", chunk.modelStreamErrorException.message); break; }
      if (!chunk.chunk?.bytes) continue;

      let parsed;
      try { parsed = JSON.parse(Buffer.from(chunk.chunk.bytes).toString("utf-8")); }
      catch { console.log("[Sonic] Binary chunk:", chunk.chunk.bytes.length, "bytes"); continue; }

      const ev = parsed.event || {};
      const keys = Object.keys(ev);
      if (keys.length) console.log("[Sonic] Event:", keys[0]);

      if (ev.audioOutput?.content) {
        pcm.push(Buffer.from(ev.audioOutput.content, "base64"));
        console.log(`[Sonic] âœ… PCM chunk ${pcm.length}: ${ev.audioOutput.content.length} b64 chars`);
      }
      if (ev.textOutput?.content) {
        console.log("[Sonic] Text:", ev.textOutput.content.slice(0,60));
      }
      if (ev.completionOutput) {
        console.log("[Sonic] Completion:", JSON.stringify(ev.completionOutput).slice(0,80));
      }
    }

    if (pcm.length === 0) {
      console.log("[Sonic] No PCM audio received from Nova");
      safeSend(ws, { type: "error", message: "No audio generated", requestId });
      return;
    }

    const wav = buildWav(Buffer.concat(pcm));
    console.log(`[Sonic] âœ… SUCCESS: ${(wav.length/1024).toFixed(1)}KB WAV from ${pcm.length} PCM chunks`);
    safeSend(ws, { type: "wav_audio", audio: wav.toString("base64"), sampleRate: 24000, requestId });
    safeSend(ws, { type: "done", requestId, chunks: pcm.length });

  } catch (err) {
    console.error("[Sonic] Fatal:", err.message);
    safeSend(ws, { type: "error", message: err.message, requestId });
  }
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "ok", version: "v11", model: MODEL_ID }));
});

const wss = new WebSocket.Server({ server });
wss.on("connection", ws => {
  console.log("[Server] Client connected");
  ws.on("message", async raw => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type === "speak") await handleSpeak(ws, m);
    if (m.type === "ping")  safeSend(ws, { type: "pong" });
  });
  ws.on("close", () => console.log("[Server] Disconnected"));
  ws.on("error", e => console.error("[Server] Error:", e.message));
});

server.listen(PORT, () => console.log(`Kira Nova Sonic v11 on port ${PORT}`));
