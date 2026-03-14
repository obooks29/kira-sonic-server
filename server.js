/**
 * Kira Nova Sonic Proxy Server v10
 * Uses ConverseStreamCommand â€” simpler API, confirmed working for textâ†’audio
 */
const { BedrockRuntimeClient, ConverseStreamCommand } = require("@aws-sdk/client-bedrock-runtime");
const WebSocket = require("ws");
const http = require("http");

const PORT     = process.env.PORT || 3000;
const MODEL_ID = "amazon.nova-2-sonic-v1:0";

const VOICE_MAP = {
  "Warm & Friendly": "matthew", "Professional": "matthew",
  "Playful": "matthew", "Calm & Gentle": "matthew",
  "Bold & Confident": "matthew", "Youthful": "matthew", "default": "matthew",
};

const bedrock = new BedrockRuntimeClient({
  region: process.env.AWS_REGION || "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

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
  const voiceId = VOICE_MAP[personality] || "matthew";
  const pcm = [];

  console.log(`[Sonic v10] "${text.slice(0,60)}" voice=${voiceId}`);
  safeSend(ws, { type: "start", requestId });

  try {
    const command = new ConverseStreamCommand({
      modelId: MODEL_ID,
      system: [{ text: "You are Bunnie, a warm AI companion for deaf and mute users. Speak naturally and clearly." }],
      messages: [{ role: "user", content: [{ text }] }],
      inferenceConfig: { maxTokens: 1024, temperature: 0.7, topP: 0.9 },
      additionalModelRequestFields: {
        audioOutputConfiguration: {
          mediaType: "audio/lpcm",
          sampleRateHertz: 24000,
          sampleSizeBits: 16,
          channelCount: 1,
          voiceId,
          encoding: "base64",
          audioType: "SPEECH",
        },
      },
    });

    const response = await bedrock.send(command);

    for await (const event of response.stream) {
      const keys = Object.keys(event);
      if (keys.length) console.log("[Sonic] Event:", keys[0]);

      // Audio output
      if (event.audioOutput?.content) {
        pcm.push(Buffer.from(event.audioOutput.content, "base64"));
        console.log(`[Sonic] PCM chunk ${pcm.length}`);
      }
      // Content block delta (may contain audio)
      if (event.contentBlockDelta?.delta?.audio) {
        pcm.push(Buffer.from(event.contentBlockDelta.delta.audio, "base64"));
        console.log(`[Sonic] Audio delta chunk ${pcm.length}`);
      }
      if (event.contentBlockDelta?.delta?.text) {
        console.log("[Sonic] Text:", event.contentBlockDelta.delta.text.slice(0,50));
      }
      if (event.metadata) {
        console.log("[Sonic] Usage:", JSON.stringify(event.metadata.usage));
      }
    }

    if (pcm.length === 0) {
      console.log("[Sonic] No audio received");
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
  res.end(JSON.stringify({ status: "ok", version: "v10", model: MODEL_ID }));
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
  console.log(`Kira Nova Sonic v10 on port ${PORT}`);
});
