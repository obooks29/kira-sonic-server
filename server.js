/**
 * Kira Nova Sonic Server v12 - Full Pipeline
 * Receives real PCM audio from phone microphone
 * Streams to Nova Sonic bidirectional
 * Returns WAV audio for playback
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

const te = new TextEncoder();
function encEvent(obj) { return { chunk: { bytes: te.encode(JSON.stringify(obj)) }}; }
function safeSend(ws, data) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data)); }
const delay = ms => new Promise(r => setTimeout(r, ms));

function buildWav(pcm, sr = 24000) {
  const h = Buffer.alloc(44);
  h.write("RIFF",0); h.writeUInt32LE(36+pcm.length,4); h.write("WAVE",8);
  h.write("fmt ",12); h.writeUInt32LE(16,16); h.writeUInt16LE(1,20);
  h.writeUInt16LE(1,22); h.writeUInt32LE(sr,24); h.writeUInt32LE(sr*2,28);
  h.writeUInt16LE(2,32); h.writeUInt16LE(16,34); h.write("data",36);
  h.writeUInt32LE(pcm.length,40);
  return Buffer.concat([h, pcm]);
}

async function handleSpeak(ws, { text, personality = "default", requestId, audioFrames }) {
  if (!text?.trim()) return;

  const voiceId        = personality === "Professional" ? "matthew" : "tiffany";
  const promptName     = uuidv4();
  const sysId          = uuidv4();
  const audioId        = uuidv4();
  const textId         = uuidv4();
  const pcmOutput      = [];

  console.log(`[Sonic v12] "${text.slice(0,60)}" | frames=${audioFrames?.length || 0} | voice=${voiceId}`);
  safeSend(ws, { type: "start", requestId });

  try {
    // Use real audio frames if provided, otherwise use silence
    const frames = audioFrames?.length > 0
      ? audioFrames  // real microphone PCM frames from phone
      : Array(10).fill(Buffer.alloc(640, 0).toString("base64")); // silence fallback

    async function* inputStream() {
      // Session start
      yield encEvent({ event: { sessionStart: {
        inferenceConfiguration: { maxTokens: 1024, topP: 0.9, temperature: 0.7 }
      }}});
      await delay(30);

      // Prompt start
      yield encEvent({ event: { promptStart: {
        promptName,
        textOutputConfiguration: { mediaType: "text/plain" },
        audioOutputConfiguration: {
          mediaType: "audio/lpcm", sampleRateHertz: 24000,
          sampleSizeBits: 16, channelCount: 1,
          voiceId, encoding: "base64", audioType: "SPEECH",
        },
      }}});
      await delay(30);

      // System prompt
      yield encEvent({ event: { contentStart: { promptName, contentName: sysId, type: "TEXT", interactive: false, role: "SYSTEM", textInputConfiguration: { mediaType: "text/plain" }}}});
      await delay(30);
      yield encEvent({ event: { textInput: { promptName, contentName: sysId, content: "You are Bunnie, a warm AI voice for deaf and mute users. Speak the provided text naturally and clearly." }}});
      await delay(30);
      yield encEvent({ event: { contentEnd: { promptName, contentName: sysId }}});
      await delay(30);

      // Audio input stream (real mic or silence)
      yield encEvent({ event: { contentStart: { promptName, contentName: audioId, type: "AUDIO", interactive: true, role: "USER", audioInputConfiguration: { mediaType: "audio/lpcm", sampleRateHertz: 16000, sampleSizeBits: 16, channelCount: 1, audioType: "SPEECH", encoding: "base64" }}}});
      await delay(30);
      for (const frame of frames) {
        yield encEvent({ event: { audioInput: { promptName, contentName: audioId, content: frame }}});
        await delay(20);
      }
      yield encEvent({ event: { contentEnd: { promptName, contentName: audioId }}});
      await delay(30);

      // Text to speak
      yield encEvent({ event: { contentStart: { promptName, contentName: textId, type: "TEXT", interactive: true, role: "USER", textInputConfiguration: { mediaType: "text/plain" }}}});
      await delay(30);
      yield encEvent({ event: { textInput: { promptName, contentName: textId, content: text }}});
      await delay(30);
      yield encEvent({ event: { contentEnd: { promptName, contentName: textId }}});
      await delay(30);

      // End
      yield encEvent({ event: { promptEnd: { promptName }}});
      await delay(30);
      yield encEvent({ event: { sessionEnd: {} }});
    }

    const response = await bedrock.send(
      new InvokeModelWithBidirectionalStreamCommand({ modelId: MODEL_ID, body: inputStream() })
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
          pcmOutput.push(Buffer.from(ev.audioOutput.content, "base64"));
          console.log(`[Sonic] âœ… PCM chunk ${pcmOutput.length}`);
        }
        if (ev.textOutput?.content) console.log("[Sonic] Text:", ev.textOutput.content.slice(0,60));
      } catch { console.log("[Sonic] Binary chunk:", chunk.chunk.bytes.length); }
    }

    if (pcmOutput.length === 0) {
      safeSend(ws, { type: "error", message: "No audio generated", requestId });
      return;
    }

    const wav = buildWav(Buffer.concat(pcmOutput));
    console.log(`[Sonic] âœ… SUCCESS ${(wav.length/1024).toFixed(1)}KB WAV`);
    safeSend(ws, { type: "wav_audio", audio: wav.toString("base64"), sampleRate: 24000, requestId });
    safeSend(ws, { type: "done", requestId, chunks: pcmOutput.length });

  } catch (err) {
    console.error("[Sonic] Fatal:", err.message);
    safeSend(ws, { type: "error", message: err.message, requestId });
  }
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "ok", version: "v12", model: MODEL_ID }));
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

server.listen(PORT, () => console.log(`Kira Nova Sonic v12 on port ${PORT}`));
