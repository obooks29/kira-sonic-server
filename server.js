/**
 * Kira Nova Sonic + Amazon Polly Server v13
 * 
 * Pipeline:
 * 1. Receive text from React Native app
 * 2. Send to Nova Sonic for processing/naturalisation
 * 3. Nova Sonic returns text output (what it would say)
 * 4. Hand that text to Amazon Polly for neural TTS
 * 5. Return MP3 audio to app
 * 6. App plays MP3 natively (no extra packages needed)
 */
const { BedrockRuntimeClient, InvokeModelWithBidirectionalStreamCommand } = require("@aws-sdk/client-bedrock-runtime");
const { PollyClient, SynthesizeSpeechCommand } = require("@aws-sdk/client-polly");
const WebSocket = require("ws");
const http = require("http");
const { v4: uuidv4 } = require("uuid");

const PORT     = process.env.PORT || 3000;
const MODEL_ID = "amazon.nova-2-sonic-v1:0";

const VOICE_MAP = {
  "Warm & Friendly":  { sonic: "tiffany", polly: "Joanna" },
  "Professional":     { sonic: "matthew", polly: "Matthew" },
  "Playful":          { sonic: "tiffany", polly: "Ivy" },
  "Calm & Gentle":    { sonic: "tiffany", polly: "Salli" },
  "Bold & Confident": { sonic: "matthew", polly: "Justin" },
  "Youthful":         { sonic: "tiffany", polly: "Kendra" },
  "default":          { sonic: "tiffany", polly: "Joanna" },
};

const credentials = {
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
};

const bedrock = new BedrockRuntimeClient({
  region: process.env.AWS_REGION || "us-east-1",
  credentials,
});

const polly = new PollyClient({
  region: process.env.AWS_REGION || "us-east-1",
  credentials,
});

const te = new TextEncoder();
function encEvent(obj) { return { chunk: { bytes: te.encode(JSON.stringify(obj)) }}; }
function safeSend(ws, data) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data)); }
const delay = ms => new Promise(r => setTimeout(r, ms));

// â”€â”€ Step 1: Process text through Nova Sonic â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function processWithNovaSonic(text, voiceId, promptName) {
  const sysId   = uuidv4();
  const audioId = uuidv4();
  const textId  = uuidv4();
  let   sonicText = null;

  console.log(`[Sonic] Processing: "${text.slice(0,60)}"`);

  const SILENT = Buffer.alloc(640, 0).toString("base64");

  async function* inputStream() {
    yield encEvent({ event: { sessionStart: { inferenceConfiguration: { maxTokens: 512, topP: 0.9, temperature: 0.7 }}}}); await delay(30);
    yield encEvent({ event: { promptStart: { promptName, textOutputConfiguration: { mediaType: "text/plain" }, audioOutputConfiguration: { mediaType: "audio/lpcm", sampleRateHertz: 24000, sampleSizeBits: 16, channelCount: 1, voiceId, encoding: "base64", audioType: "SPEECH" }}}}); await delay(30);
    yield encEvent({ event: { contentStart: { promptName, contentName: sysId, type: "TEXT", interactive: false, role: "SYSTEM", textInputConfiguration: { mediaType: "text/plain" }}}}); await delay(30);
    yield encEvent({ event: { textInput: { promptName, contentName: sysId, content: "You are Bunnie, a warm AI companion for deaf and mute users. Rephrase the user text naturally and warmly, as if speaking on their behalf. Return ONLY the rephrased text, nothing else." }}}); await delay(30);
    yield encEvent({ event: { contentEnd: { promptName, contentName: sysId }}}); await delay(30);
    yield encEvent({ event: { contentStart: { promptName, contentName: audioId, type: "AUDIO", interactive: false, role: "USER", audioInputConfiguration: { mediaType: "audio/lpcm", sampleRateHertz: 16000, sampleSizeBits: 16, channelCount: 1, audioType: "SPEECH", encoding: "base64" }}}}); await delay(30);
    for (let i = 0; i < 8; i++) { yield encEvent({ event: { audioInput: { promptName, contentName: audioId, content: SILENT }}}); await delay(20); }
    yield encEvent({ event: { contentEnd: { promptName, contentName: audioId }}}); await delay(30);
    yield encEvent({ event: { contentStart: { promptName, contentName: textId, type: "TEXT", interactive: false, role: "USER", textInputConfiguration: { mediaType: "text/plain" }}}}); await delay(30);
    yield encEvent({ event: { textInput: { promptName, contentName: textId, content: text }}}); await delay(30);
    yield encEvent({ event: { contentEnd: { promptName, contentName: textId }}}); await delay(30);
    yield encEvent({ event: { promptEnd: { promptName }}}); await delay(30);
    yield encEvent({ event: { sessionEnd: {} }});
  }

  try {
    const response = await bedrock.send(new InvokeModelWithBidirectionalStreamCommand({ modelId: MODEL_ID, body: inputStream() }));
    for await (const chunk of response.body) {
      if (!chunk.chunk?.bytes) continue;
      try {
        const ev = JSON.parse(Buffer.from(chunk.chunk.bytes).toString("utf-8")).event || {};
        if (ev.textOutput?.content) {
          sonicText = ev.textOutput.content.trim();
          console.log(`[Sonic] âœ… Text output: "${sonicText.slice(0,60)}"`);
        }
      } catch {}
    }
  } catch (err) {
    console.log("[Sonic] Error (using original text):", err.message);
  }

  // Return Nova Sonic's rephrased text, or original if Sonic didn't respond
  return sonicText || text;
}

// â”€â”€ Step 2: Speak with Amazon Polly â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function speakWithPolly(text, pollyVoice) {
  console.log(`[Polly] Speaking: "${text.slice(0,60)}" voice=${pollyVoice}`);

  const command = new SynthesizeSpeechCommand({
    Text:           text,
    OutputFormat:   "mp3",
    VoiceId:        pollyVoice,
    Engine:         "neural",
    LanguageCode:   "en-US",
    SampleRate:     "24000",
  });

  const response = await polly.send(command);

  // Collect MP3 stream into buffer
  const chunks = [];
  for await (const chunk of response.AudioStream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const mp3Buffer = Buffer.concat(chunks);
  console.log(`[Polly] âœ… ${(mp3Buffer.length/1024).toFixed(1)}KB MP3`);
  return mp3Buffer.toString("base64");
}

// â”€â”€ Main handler â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function handleSpeak(ws, { text, personality = "default", requestId }) {
  if (!text?.trim()) return;

  const voices    = VOICE_MAP[personality] || VOICE_MAP.default;
  const promptName = uuidv4();

  safeSend(ws, { type: "start", requestId });

  try {
    // Step 1 â€” Nova Sonic processes and rephrases the text
    const processedText = await processWithNovaSonic(text, voices.sonic, promptName);
    console.log(`[Pipeline] Nova Sonic â†’ Polly: "${processedText.slice(0,60)}"`);

    // Step 2 â€” Polly speaks the processed text
    const mp3Base64 = await speakWithPolly(processedText, voices.polly);

    // Send MP3 to client
    safeSend(ws, { type: "mp3_audio", audio: mp3Base64, requestId });
    safeSend(ws, { type: "done", requestId });

  } catch (err) {
    console.error("[Handler] Fatal:", err.message);
    safeSend(ws, { type: "error", message: err.message, requestId });
  }
}

// â”€â”€ Server â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "ok", version: "v13-sonic+polly", model: MODEL_ID }));
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

server.listen(PORT, () => console.log(`Kira Nova Sonic + Polly v13 on port ${PORT}`));
