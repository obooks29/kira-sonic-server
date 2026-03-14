/**
 * Kira — Nova Sonic Proxy Server (v4 — crossmodal text-to-speech)
 * 
 * Nova 2 Sonic requires audio input even for text-only use.
 * Solution: send silent PCM audio frames alongside the text input.
 * This is the official AWS crossmodal pattern for text-to-speech.
 */

const { BedrockRuntimeClient, InvokeModelWithBidirectionalStreamCommand } = require('@aws-sdk/client-bedrock-runtime');
const WebSocket = require('ws');
const http      = require('http');
const { v4: uuidv4 } = require('uuid');

const PORT       = process.env.PORT || 3000;
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const MODEL_ID   = 'amazon.nova-2-sonic-v1:0';

// Official voice IDs from AWS docs (all lowercase)
const VOICE_MAP = {
  'Warm & Friendly':  'tiffany',
  'Professional':     'matthew',
  'Playful':          'amy',
  'Calm & Gentle':    'tiffany',
  'Bold & Confident': 'matthew',
  'Youthful':         'amy',
  'default':          'tiffany',
};

const bedrock = new BedrockRuntimeClient({
  region: AWS_REGION,
  credentials: {
    accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// ── Silent audio frames (16-bit PCM, 24kHz, 1ch, 32ms per frame) ─────────────
// 24000 samples/sec * 0.032 sec * 2 bytes = 1536 bytes of silence per frame
const SILENT_FRAME = Buffer.alloc(1536, 0).toString('base64');

// ── WAV header ────────────────────────────────────────────────────────────────
function buildWav(pcmBuf, sr = 24000) {
  const hdr = Buffer.alloc(44);
  const dl  = pcmBuf.length;
  hdr.write('RIFF', 0);          hdr.writeUInt32LE(36 + dl, 4);
  hdr.write('WAVE', 8);          hdr.write('fmt ', 12);
  hdr.writeUInt32LE(16, 16);     hdr.writeUInt16LE(1, 20);
  hdr.writeUInt16LE(1, 22);      hdr.writeUInt32LE(sr, 24);
  hdr.writeUInt32LE(sr * 2, 28); hdr.writeUInt16LE(2, 32);
  hdr.writeUInt16LE(16, 34);     hdr.write('data', 36);
  hdr.writeUInt32LE(dl, 40);
  return Buffer.concat([hdr, pcmBuf]);
}

// ── Encode event for AWS SDK bidirectional stream ─────────────────────────────
function enc(obj) {
  return { chunk: { bytes: Buffer.from(JSON.stringify(obj), 'utf-8') } };
}

// ── Handle speak request ──────────────────────────────────────────────────────
async function handleSpeak(clientWs, { text, personality = 'default', requestId }) {
  if (!text?.trim()) return;

  const voiceId     = VOICE_MAP[personality] || VOICE_MAP.default;
  const promptName  = uuidv4();
  const sysId       = uuidv4();
  const audioId     = uuidv4();  // silent audio stream (required)
  const textId      = uuidv4();  // actual text input
  const pcmChunks   = [];

  console.log(`[Sonic] "${text.slice(0, 60)}" | voice=${voiceId}`);
  safeSend(clientWs, { type: 'start', requestId });

  try {
    async function* eventStream() {
      // 1. Session start
      yield enc({ event: { sessionStart: {
        inferenceConfiguration: { maxTokens: 1024, topP: 0.9, temperature: 0.7 }
      }}});

      // 2. Prompt start — define output format
      yield enc({ event: { promptStart: {
        promptName,
        textOutputConfiguration:  { mediaType: 'text/plain' },
        audioOutputConfiguration: {
          mediaType: 'audio/lpcm', sampleRateHertz: 24000,
          sampleSizeBits: 16, channelCount: 1,
          voiceId, encoding: 'base64', audioType: 'SPEECH',
        },
      }}});

      // 3. System prompt
      yield enc({ event: { contentStart: { promptName, contentName: sysId,
        type: 'TEXT', interactive: false, role: 'SYSTEM',
        textInputConfiguration: { mediaType: 'text/plain' }
      }}});
      yield enc({ event: { textInput: { promptName, contentName: sysId,
        content: 'You are Bunnie, a warm helpful AI companion for deaf and mute users. Speak naturally and clearly. Keep responses concise.'
      }}});
      yield enc({ event: { contentEnd: { promptName, contentName: sysId }}});

      // 4. CRITICAL: Silent audio stream — required for crossmodal text input
      yield enc({ event: { contentStart: { promptName, contentName: audioId,
        type: 'AUDIO', interactive: false, role: 'USER',
        audioInputConfiguration: {
          mediaType: 'audio/lpcm', sampleRateHertz: 24000,
          sampleSizeBits: 16, channelCount: 1, audioType: 'SPEECH',
        },
      }}});
      // Send 5 silent frames (~160ms of silence)
      for (let i = 0; i < 5; i++) {
        yield enc({ event: { audioInput: { promptName, contentName: audioId, content: SILENT_FRAME }}});
      }
      yield enc({ event: { contentEnd: { promptName, contentName: audioId }}});

      // 5. Text input (the actual text to speak)
      yield enc({ event: { contentStart: { promptName, contentName: textId,
        type: 'TEXT', interactive: true, role: 'USER',
        textInputConfiguration: { mediaType: 'text/plain' },
      }}});
      yield enc({ event: { textInput: { promptName, contentName: textId, content: text }}});
      yield enc({ event: { contentEnd: { promptName, contentName: textId }}});

      // 6. End session
      yield enc({ event: { promptEnd: { promptName }}});
      yield enc({ event: { sessionEnd: {}}});
    }

    const response = await bedrock.send(
      new InvokeModelWithBidirectionalStreamCommand({ modelId: MODEL_ID, body: eventStream() })
    );

    // ── Collect PCM audio from Nova Sonic ─────────────────────────────────────
    for await (const chunk of response.body) {
      if (!chunk.chunk?.bytes) continue;
      try {
        const ev = JSON.parse(Buffer.from(chunk.chunk.bytes).toString('utf-8'));
        // Log every event type for debugging
        const eventKeys = Object.keys(ev.event || {});
        if (eventKeys.length > 0) console.log('[Sonic] Event:', eventKeys[0]);
        
        if (ev.event?.audioOutput?.content) {
          pcmChunks.push(Buffer.from(ev.event.audioOutput.content, 'base64'));
          console.log(`[Sonic] Audio chunk received: ${ev.event.audioOutput.content.length} chars`);
        }
        if (ev.event?.textOutput) {
          console.log('[Sonic] Text output:', ev.event.textOutput.content?.slice(0, 50));
        }
        if (ev.event?.completionOutput) {
          console.log('[Sonic] Completion:', JSON.stringify(ev.event.completionOutput));
        }
      } catch (parseErr) {
        console.log('[Sonic] Raw chunk (non-JSON):', chunk.chunk.bytes.length, 'bytes');
      }
    }

    if (pcmChunks.length === 0) {
      console.log('[Sonic] No audio chunks received');
      safeSend(clientWs, { type: 'error', message: 'No audio generated', requestId });
      return;
    }

    // ── Convert PCM → WAV and send ────────────────────────────────────────────
    const wav    = buildWav(Buffer.concat(pcmChunks));
    const wavB64 = wav.toString('base64');
    console.log(`[Sonic] ✅ ${(wav.length/1024).toFixed(1)}KB WAV from ${pcmChunks.length} chunks`);

    safeSend(clientWs, { type: 'wav_audio', audio: wavB64, sampleRate: 24000, requestId });
    safeSend(clientWs, { type: 'done', requestId, chunks: pcmChunks.length });

  } catch (err) {
    console.error('[Sonic] Error:', err.message);
    safeSend(clientWs, { type: 'error', message: err.message, requestId });
  }
}

function safeSend(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

// ── HTTP + WebSocket server on same port ──────────────────────────────────────
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', service: 'kira-sonic', model: MODEL_ID }));
});

const wss = new WebSocket.Server({ server });
wss.on('connection', (clientWs) => {
  console.log('[Server] Client connected');
  clientWs.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'speak') await handleSpeak(clientWs, msg);
    if (msg.type === 'ping')  safeSend(clientWs, { type: 'pong' });
  });
  clientWs.on('close', () => console.log('[Server] Client disconnected'));
  clientWs.on('error', (e)  => console.error('[Server] Error:', e.message));
});

server.listen(PORT, () => {
  console.log(`🐰 Kira Nova Sonic server on port ${PORT}`);
  console.log(`🏥 Health check: https://kira-sonic-server.onrender.com`);
});
