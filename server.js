/**
 * Kira — Nova Sonic Proxy Server v5
 * Based on AWS official "nova-sonic-speaks-first" pattern
 * Text-only input, audio output — no silent audio frames needed
 */

const { BedrockRuntimeClient, InvokeModelWithBidirectionalStreamCommand } = require('@aws-sdk/client-bedrock-runtime');
const WebSocket = require('ws');
const http      = require('http');
const { v4: uuidv4 } = require('uuid');

const PORT       = process.env.PORT || 3000;
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const MODEL_ID   = 'amazon.nova-2-sonic-v1:0';

const VOICE_MAP = {
  'Warm & Friendly':  'tiffany',
  'Professional':     'matthew',
  'Playful':          'tiffany',
  'Calm & Gentle':    'tiffany',
  'Bold & Confident': 'matthew',
  'Youthful':         'tiffany',
  'default':          'tiffany',
};

const bedrock = new BedrockRuntimeClient({
  region: AWS_REGION,
  credentials: {
    accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// ── WAV builder ───────────────────────────────────────────────────────────────
function buildWav(pcm, sr = 24000) {
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF',0); hdr.writeUInt32LE(36+pcm.length,4); hdr.write('WAVE',8);
  hdr.write('fmt ',12); hdr.writeUInt32LE(16,16); hdr.writeUInt16LE(1,20);
  hdr.writeUInt16LE(1,22); hdr.writeUInt32LE(sr,24); hdr.writeUInt32LE(sr*2,28);
  hdr.writeUInt16LE(2,32); hdr.writeUInt16LE(16,34); hdr.write('data',36);
  hdr.writeUInt32LE(pcm.length,40);
  return Buffer.concat([hdr, pcm]);
}

function safeSend(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

// ── Handle speak ──────────────────────────────────────────────────────────────
async function handleSpeak(clientWs, { text, personality = 'default', requestId }) {
  if (!text?.trim()) return;

  const voiceId    = VOICE_MAP[personality] || 'tiffany';
  const promptName = uuidv4();
  const contentName = uuidv4();
  const pcmChunks  = [];

  console.log(`[Sonic] "${text.slice(0,60)}" | voice=${voiceId}`);
  safeSend(clientWs, { type: 'start', requestId });

  try {
    // ── Build event stream ────────────────────────────────────────────────────
    // Based on AWS nova-sonic-speaks-first official pattern
    const events = [
      // 1. Session config
      { event: { sessionStart: {
        inferenceConfiguration: { maxTokens: 1024, topP: 0.95, temperature: 0.9 }
      }}},

      // 2. Prompt config with audio output
      { event: { promptStart: {
        promptName,
        textOutputConfiguration:  { mediaType: 'text/plain' },
        audioOutputConfiguration: {
          mediaType:       'audio/lpcm',
          sampleRateHertz: 24000,
          sampleSizeBits:  16,
          channelCount:    1,
          voiceId,
          encoding:        'base64',
          audioType:       'SPEECH',
        },
      }}},

      // 3. System message
      { event: { contentStart: {
        promptName,
        contentName: uuidv4(),
        type: 'TEXT', interactive: false, role: 'SYSTEM',
        textInputConfiguration: { mediaType: 'text/plain' },
      }}},
      { event: { textInput: {
        promptName,
        contentName: uuidv4(),
        content: 'You are Bunnie, a helpful AI companion for deaf and mute users. Speak clearly and naturally. Respond directly with what needs to be said — do not add extra commentary.',
      }}},
      { event: { contentEnd: { promptName, contentName: uuidv4() }}},

      // 4. User text message — what to speak
      { event: { contentStart: {
        promptName,
        contentName,
        type: 'TEXT', interactive: true, role: 'USER',
        textInputConfiguration: { mediaType: 'text/plain' },
      }}},
      { event: { textInput: { promptName, contentName, content: text }}},
      { event: { contentEnd: { promptName, contentName }}},

      // 5. End
      { event: { promptEnd: { promptName }}},
      { event: { sessionEnd: {} }},
    ];

    // Each event must be { chunk: { bytes: Buffer } }
    async function* eventStream() {
      for (const ev of events) {
        yield { chunk: { bytes: Buffer.from(JSON.stringify(ev)) }};
      }
    }

    const response = await bedrock.send(
      new InvokeModelWithBidirectionalStreamCommand({ modelId: MODEL_ID, body: eventStream() })
    );

    // ── Collect response ──────────────────────────────────────────────────────
    for await (const chunk of response.body) {
      // Log raw chunk type for debugging
      if (chunk.internalServerException) {
        console.error('[Sonic] InternalServerException:', chunk.internalServerException.message);
        break;
      }
      if (chunk.modelStreamErrorException) {
        console.error('[Sonic] ModelStreamError:', chunk.modelStreamErrorException.message);
        break;
      }
      if (chunk.chunk?.bytes) {
        try {
          const ev = JSON.parse(Buffer.from(chunk.chunk.bytes).toString('utf-8'));
          const keys = Object.keys(ev.event || ev || {});
          console.log('[Sonic] Event keys:', keys);

          const audio = ev?.event?.audioOutput ?? ev?.audioOutput;
          if (audio?.content) {
            pcmChunks.push(Buffer.from(audio.content, 'base64'));
            console.log(`[Sonic] PCM chunk: ${audio.content.length} chars`);
          }
          const txt = ev?.event?.textOutput ?? ev?.textOutput;
          if (txt?.content) console.log('[Sonic] Text:', txt.content.slice(0,50));

        } catch (e) {
          console.log('[Sonic] Non-JSON chunk, length:', chunk.chunk.bytes.length);
        }
      }
    }

    if (pcmChunks.length === 0) {
      console.log('[Sonic] No PCM chunks received');
      safeSend(clientWs, { type: 'error', message: 'No audio generated', requestId });
      return;
    }

    const wav = buildWav(Buffer.concat(pcmChunks));
    console.log(`[Sonic] ✅ WAV: ${(wav.length/1024).toFixed(1)}KB from ${pcmChunks.length} chunks`);
    safeSend(clientWs, { type: 'wav_audio', audio: wav.toString('base64'), sampleRate: 24000, requestId });
    safeSend(clientWs, { type: 'done', requestId, chunks: pcmChunks.length });

  } catch (err) {
    console.error('[Sonic] Fatal:', err.message);
    safeSend(clientWs, { type: 'error', message: err.message, requestId });
  }
}

// ── HTTP + WebSocket on same port ─────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', service: 'kira-sonic', model: MODEL_ID }));
});

const wss = new WebSocket.Server({ server });
wss.on('connection', (ws) => {
  console.log('[Server] Client connected');
  ws.on('message', async (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'speak') await handleSpeak(ws, msg);
    if (msg.type === 'ping')  safeSend(ws, { type: 'pong' });
  });
  ws.on('close', () => console.log('[Server] Disconnected'));
  ws.on('error', e => console.error('[Server] Error:', e.message));
});

server.listen(PORT, () => {
  console.log(`🐰 Kira Nova Sonic v5 on port ${PORT}`);
  console.log(`🏥 ${process.env.RENDER_EXTERNAL_URL || 'http://localhost:'+PORT}`);
});
