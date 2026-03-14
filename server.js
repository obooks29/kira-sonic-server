/**
 * Kira — Nova Sonic Proxy Server
 * 
 * Converts Nova Sonic PCM audio → WAV and sends to React Native app
 * React Native plays WAV natively — no third-party audio packages needed
 */

const { BedrockRuntimeClient, InvokeModelWithBidirectionalStreamCommand } = require('@aws-sdk/client-bedrock-runtime');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const http = require('http');

const PORT       = process.env.PORT || 3000;
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const MODEL_ID   = 'amazon.nova-sonic-v1:0';

const VOICE_MAP = {
  'Warm & Friendly':  'ruth',
  'Professional':     'matthew',
  'Playful':          'joanna',
  'Calm & Gentle':    'salli',
  'Bold & Confident': 'stephen',
  'Youthful':         'kendra',
  'default':          'ruth',
};

const bedrock = new BedrockRuntimeClient({
  region: AWS_REGION,
  credentials: {
    accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// ── WAV header builder ────────────────────────────────────────────────────────
// WAV = 44-byte header + raw PCM data
function buildWavBuffer(pcmBuffer, sampleRate = 24000, channels = 1, bitsPerSample = 16) {
  const byteRate    = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign  = channels * (bitsPerSample / 8);
  const dataSize    = pcmBuffer.length;
  const headerSize  = 44;
  const wav         = Buffer.alloc(headerSize + dataSize);

  // RIFF chunk
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataSize, 4);   // file size - 8
  wav.write('WAVE', 8);

  // fmt sub-chunk
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);             // sub-chunk size
  wav.writeUInt16LE(1, 20);              // PCM format
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(byteRate, 28);
  wav.writeUInt16LE(blockAlign, 32);
  wav.writeUInt16LE(bitsPerSample, 34);

  // data sub-chunk
  wav.write('data', 36);
  wav.writeUInt32LE(dataSize, 40);

  // copy PCM data
  pcmBuffer.copy(wav, headerSize);

  return wav;
}

// ── WebSocket server ──────────────────────────────────────────────────────────
// WebSocket attached to HTTP server below

// ── Handle speak ──────────────────────────────────────────────────────────────
async function handleSpeak(clientWs, { text, personality = 'default', requestId }) {
  if (!text?.trim()) return;

  const voiceId    = VOICE_MAP[personality] || VOICE_MAP.default;
  const promptName = uuidv4();
  const pcmChunks  = [];  // collect raw PCM buffers

  console.log(`[Sonic] "${text.slice(0, 60)}" voice=${voiceId}`);
  safeSend(clientWs, { type: 'start', requestId });

  try {
    async function* eventStream() {
      // sessionStart
      yield encode({ event: {
        sessionStart: { inferenceConfiguration: { maxTokens: 1024, topP: 0.9, temperature: 0.7 } }
      }});

      // promptStart — request PCM audio output
      yield encode({ event: {
        promptStart: {
          promptName,
          textOutputConfiguration:  { mediaType: 'text/plain' },
          audioOutputConfiguration: {
            mediaType: 'audio/lpcm', sampleRateHertz: 24000,
            sampleSizeBits: 16, channelCount: 1,
            voiceId, encoding: 'base64', audioType: 'SPEECH',
          },
        },
      }});

      // System prompt
      const sysName = uuidv4();
      yield encode({ event: { contentStart: { promptName, contentName: sysName, type: 'TEXT', interactive: false, role: 'SYSTEM', textInputConfiguration: { mediaType: 'text/plain' } } }});
      yield encode({ event: { textInput: { promptName, contentName: sysName, content: 'You are Bunnie, a warm helpful AI companion for deaf and mute users. Speak clearly and naturally.' } }});
      yield encode({ event: { contentEnd: { promptName, contentName: sysName } }});

      // User text
      const userContentName = uuidv4();
      yield encode({ event: { contentStart: { promptName, contentName: userContentName, type: 'TEXT', interactive: false, role: 'USER', textInputConfiguration: { mediaType: 'text/plain' } } }});
      yield encode({ event: { textInput: { promptName, contentName: userContentName, content: text } }});
      yield encode({ event: { contentEnd: { promptName, contentName: userContentName } }});

      // End
      yield encode({ event: { promptEnd: { promptName } }});
      yield encode({ event: { sessionEnd: {} }});
    }

    const response = await bedrock.send(
      new InvokeModelWithBidirectionalStreamCommand({ modelId: MODEL_ID, body: eventStream() })
    );

    // ── Collect PCM chunks from Nova Sonic ────────────────────────────────────
    for await (const chunk of response.body) {
      if (!chunk.chunk?.bytes) continue;
      try {
        const event = JSON.parse(Buffer.from(chunk.chunk.bytes).toString('utf-8'));
        if (event.event?.audioOutput?.content) {
          // Nova returns base64 PCM — decode to buffer
          const pcmBuf = Buffer.from(event.event.audioOutput.content, 'base64');
          pcmChunks.push(pcmBuf);
        }
      } catch {}
    }

    if (pcmChunks.length === 0) {
      console.log('[Sonic] No audio received — sending error');
      safeSend(clientWs, { type: 'error', message: 'No audio generated', requestId });
      return;
    }

    // ── Convert PCM → WAV ─────────────────────────────────────────────────────
    const combinedPCM = Buffer.concat(pcmChunks);
    const wavBuffer   = buildWavBuffer(combinedPCM, 24000, 1, 16);
    const wavBase64   = wavBuffer.toString('base64');

    console.log(`[Sonic] ✅ Generated ${(wavBuffer.length / 1024).toFixed(1)}KB WAV from ${pcmChunks.length} PCM chunks`);

    // Send complete WAV to client
    safeSend(clientWs, {
      type:       'wav_audio',
      audio:      wavBase64,
      sampleRate: 24000,
      requestId,
    });

    safeSend(clientWs, { type: 'done', requestId, chunks: pcmChunks.length });

  } catch (err) {
    console.error('[Sonic] Error:', err.message);
    safeSend(clientWs, { type: 'error', message: err.message, requestId });
  }
}

// AWS SDK expects { chunk: { bytes: Buffer } } format for bidirectional stream
function encode(obj) {
  const bytes = Buffer.from(JSON.stringify(obj), 'utf-8');
  return { chunk: { bytes } };
}
function safeSend(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

// ── HTTP server — handles both health checks AND WebSocket upgrades ───────────
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', service: 'kira-sonic', model: MODEL_ID, port: PORT }));
});

// Attach WebSocket server to HTTP server (same port)
const wssAttached = new WebSocket.Server({ server });

wssAttached.on('connection', (clientWs) => {
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
