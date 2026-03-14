/**
 * Kira Nova Sonic Proxy Server v9
 * Based on exact AWS official Node.js sample with 30ms delays between events
 * Audio input sent BEFORE system prompt (official order)
 */
const { BedrockRuntimeClient, InvokeModelWithBidirectionalStreamCommand } = require("@aws-sdk/client-bedrock-runtime");
const WebSocket = require("ws");
const http = require("http");
const { v4: uuidv4 } = require("uuid");

const PORT     = process.env.PORT || 3000;
const MODEL_ID = "amazon.nova-2-sonic-v1:0";

const VOICE_MAP = {
  "Warm & Friendly": "tiffany", "Professional": "matthew",
  "Playful": "tiffany", "Calm & Gentle": "tiffany",
  "Bold & Confident": "matthew", "Youthful": "tiffany", "default": "tiffany",
};

const bedrock = new BedrockRuntimeClient({
  region: process.env.AWS_REGION || "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// 32ms of silent PCM at 16kHz 16-bit mono = 1024 bytes
const SILENT = Buffer.alloc(1024, 0).toString("base64");

const delay = (ms) => new Promise(r => setTimeout(r, ms));

function buildWav(pcm, sr = 24000) {
  const h = Buffer.alloc(44);
  h.write("RIFF",0); h.writeUInt32LE(36+pcm.length,4); h.write("WAVE",8);
  h.write("fmt ",12); h.writeUInt32LE(16,16); h.writeUInt16LE(1,20);
  h.writeUInt16LE(1,22); h.writeUInt32LE(sr,24); h.writeUInt32LE(sr*2,28);
  h.writeUInt16LE(2,32); h.writeUInt16LE(16,34); h.write("data",36);
  h.writeUInt32LE(pcm.length,40);
  return Buffer.concat([h, pcm]);
}

function safeSend(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

async function handleSpeak(ws, { text, personality = "default", requestId }) {
  if (!text?.trim()) return;
  const voiceId = VOICE_MAP[personality] || "tiffany";
  const pn = uuidv4();
  const sysId   = uuidv4();
  const audioId = uuidv4();
  const textId  = uuidv4();
  const pcm = [];

  console.log(`[Sonic v9] "${text.slice(0,60)}" voice=${voiceId}`);
  safeSend(ws, { type: "start", requestId });

  try {
    // Build all events upfront with delays between them
    // Official AWS pattern: 30ms delay between each event
    async function* stream() {
      const events = [
        // 1. Session start
        { event: { sessionStart: { inferenceConfiguration: { maxTokens: 1024, topP: 0.9, temperature: 0.7 }}}},
        // 2. Prompt start
        { event: { promptStart: { promptName: pn,
          textOutputConfiguration: { mediaType: "text/plain" },
          audioOutputConfiguration: { mediaType: "audio/lpcm", sampleRateHertz: 24000,
            sampleSizeBits: 16, channelCount: 1, voiceId, encoding: "base64", audioType: "SPEECH" },
        }}},
        // 3. System content start
        { event: { contentStart: { promptName: pn, contentName: sysId,
          type: "TEXT", interactive: false, role: "SYSTEM",
          textInputConfiguration: { mediaType: "text/plain" },
        }}},
        // 4. System text
        { event: { textInput: { promptName: pn, contentName: sysId,
          content: "You are a TTS system. Speak the user text verbatim as audio. Do not respond or add anything extra.",
        }}},
        // 5. System content end
        { event: { contentEnd: { promptName: pn, contentName: sysId }}},
        // 6. Audio content start (required â€” silent input)
        { event: { contentStart: { promptName: pn, contentName: audioId,
          type: "AUDIO", interactive: false, role: "USER",
          audioInputConfiguration: { mediaType: "audio/lpcm", sampleRateHertz: 16000,
            sampleSizeBits: 16, channelCount: 1, audioType: "SPEECH", encoding: "base64" },
        }}},
      ];

      for (const ev of events) {
        const json = JSON.stringify(ev);
        console.log(`Sending: ${json.substring(0, 60)}...`);
        yield { chunk: { bytes: Buffer.from(json) }};
        await delay(30); // Official AWS delay between events
      }

      // Send silent audio frames
      for (let i = 0; i < 5; i++) {
        yield { chunk: { bytes: Buffer.from(JSON.stringify({ event: { audioInput: { promptName: pn, contentName: audioId, content: SILENT }}})) }};
        await delay(30);
      }

      // Close audio
      yield { chunk: { bytes: Buffer.from(JSON.stringify({ event: { contentEnd: { promptName: pn, contentName: audioId }}})) }};
      await delay(30);

      // Text to speak
      yield { chunk: { bytes: Buffer.from(JSON.stringify({ event: { contentStart: { promptName: pn, contentName: textId, type: "TEXT", interactive: false, role: "USER", textInputConfiguration: { mediaType: "text/plain" }}}})) }};
      await delay(30);
      yield { chunk: { bytes: Buffer.from(JSON.stringify({ event: { textInput: { promptName: pn, contentName: textId, content: text }}})) }};
      await delay(30);
      yield { chunk: { bytes: Buffer.from(JSON.stringify({ event: { contentEnd: { promptName: pn, contentName: textId }}})) }};
      await delay(30);

      // End session
      yield { chunk: { bytes: Buffer.from(JSON.stringify({ event: { promptEnd: { promptName: pn }}})) }};
      await delay(30);
      yield { chunk: { bytes: Buffer.from(JSON.stringify({ event: { sessionEnd: {} }})) }};
    }

    const response = await bedrock.send(
      new InvokeModelWithBidirectionalStreamCommand({ modelId: MODEL_ID, body: stream() })
    );

    for await (const chunk of response.body) {
      if (chunk.internalServerException)   { console.error("[Sonic]", chunk.internalServerException.message); break; }
      if (chunk.modelStreamErrorException) { console.error("[Sonic]", chunk.modelStreamErrorException.message); break; }
      if (!chunk.chunk?.bytes) continue;
      try {
        const parsed = JSON.parse(Buffer.from(chunk.chunk.bytes).toString("utf-8"));
        const ev = parsed.event || {};
        const keys = Object.keys(ev);
        if (keys.length) console.log("[Sonic] Event:", keys[0]);
        if (ev.audioOutput?.content) {
          pcm.push(Buffer.from(ev.audioOutput.content, "base64"));
          console.log(`[Sonic] PCM chunk ${pcm.length}: ${ev.audioOutput.content.length} chars`);
        }
      } catch { console.log("[Sonic] Binary chunk:", chunk.chunk.bytes.length, "bytes"); }
    }

    if (pcm.length === 0) {
      safeSend(ws, { type: "error", message: "No audio generated", requestId });
      return;
    }

    const wav = buildWav(Buffer.concat(pcm));
    console.log(`[Sonic] SUCCESS ${(wav.length/1024).toFixed(1)}KB WAV from ${pcm.length} chunks`);
    safeSend(ws, { type: "wav_audio", audio: wav.toString("base64"), sampleRate: 24000, requestId });
    safeSend(ws, { type: "done", requestId, chunks: pcm.length });

  } catch (err) {
    console.error("[Sonic] Fatal:", err.message);
    safeSend(ws, { type: "error", message: err.message, requestId });
  }
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "ok", version: "v9", model: MODEL_ID }));
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

server.listen(PORT, () => {
  console.log(`Kira Nova Sonic v9 on port ${PORT}`);
});
