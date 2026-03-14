/**
 * Kira — Nova Sonic Proxy Server v6
 * Fixed: consistent content IDs across start/input/end events
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

function buildWav(pcm, sr = 24000) {
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF',0); hdr.writeUInt32LE(36+pcm.length,4); hdr.write('WAVE',8);
  hdr.write('fmt ',12); hdr.writeUInt32LE(16,16); hdr.writeUInt16LE(1,20);
  hdr.writeUInt16LE(1,22); hdr.writeUInt32LE(sr,24); hdr.writeUInt32LE(sr*2,28);
  hdr.writeUInt16LE(2,32); hdr.writeUInt16LE(16,34); hdr.write('data',36);
  hdr.writeUInt32LE(pcm.length,40);
  return Buffer.concat([hdr, pcm]);
}

function ev(obj) {
  return { chunk: { bytes: Buffer.from(JSON.stringify(obj)) }};
}

function safeSend(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

async function handleSpeak(clientWs, { text, personality = 'default', requestId }) {
  if (!text?.trim()) return;

  const voiceId     = VOICE_MAP[personality] || 'tiffany';
  const promptName  = uuidv4();
  const sysContent  = uuidv4();  // ONE id used for start + input + end
  const userContent = uuidv4();  // ONE id used for start + input + end
  const pcmChunks   = [];

  console.log(`[Sonic] "${text.slice(0,60)}" | voice=${voiceId}`);
  safeSend(clientWs, { type: 'start', requestId });

  try {
    async function* stream() {
      // 1. Session start
      yield ev({ event: { sessionStart: {
        inferenceConfiguration: { maxTokens: 1024, topP: 0.95, temperature: 0.9 }
      }}});

      // 2. Prompt start
      yield ev({ event: { promptStart: {
        promptName,
        textOutputConfiguration:  { mediaType: 'text/plain' },
        audioOutputConfiguration: {
          mediaType: 'audio/lpcm', sampleRateHertz: 24000,
          sampleSizeBits: 16, channelCount: 1,
          voiceId, encoding: 'base64', audioType: 'SPEECH',
        },
      }}});

      // 3. System content — SAME sysContent id throughout
      yield ev({ event: { contentStart: {
        promptName, contentName: sysContent,
        type: 'TEXT', interactive: false, role: 'SYSTEM',
        textInputConfiguration: { mediaType: 'text/plain' },
      }}});
      yield ev({ event: { textInput: {
        promptName, contentName: sysContent,
        content: 'You are Bunnie, a warm AI companion for deaf and mute users. Speak the user text naturally and clearly.',
      }}});
      yield ev({ event: { contentEnd: { promptName, contentName: sysContent }}});

      // 4. User content — SAME userContent id throughout
      yield ev({ event: { contentStart: {
        promptName, contentName: userContent,
        type: 'TEXT', interactive: true, role: 'USER',
        textInputConfiguration: { mediaType: 'text/plain' },
      }}});
      yield ev({ event: { textInput: {
        promptName, contentName: userContent, content: text,
      }}});
      yield ev({ event: { contentEnd: { promptName, contentName: userContent }}});

      // 5. End
      yield ev({ event: { promptEnd: { promptName }}});
      yield ev({ event: { sessionEnd: {} }});
    }

    const response = await bedrock.send(
      new InvokeModelWithBidirectionalStreamCommand({ modelId: MODEL_ID, body: stream() })
    );

    for await (const chunk of response.body) {
      if (chunk.internalServerException) { console.error('[Sonic]', chunk.internalServerException.message); break; }
      if (chunk.modelStreamErrorException) { console.error('[Sonic]', chunk.modelStreamErrorException.message); break; }

      if (chunk.chunk?.bytes) {
        try {
          const parsed = JSON.parse(Buffer.from(chunk.chunk.bytes).toString('utf-8'));
          const eventObj = parsed.event || parsed;
          console.log('[Sonic] Event:', Object.keys(eventObj).join(','));

          const audio = eventObj.audioOutput;
          if (audio?.content) {
            pcmChunks.push(Buffer.from(audio.content, 'base64'));
            console.log(`[Sonic] PCM chunk ${pcmChunks.length}: ${audio.content.length} chars`);
          }
        } catch {
          console.log('[Sonic] Binary chunk:', chunk.chunk.bytes.length, 'bytes');
        }
      }
    }

    if (pcmChunks.length === 0) {
      safeSend(clientWs, { type: 'error', message: 'No audio generated', requestId });
      return;
    }

    const wav = buildWav(Buffer.concat(pcmChunks));
    console.log(`[Sonic] ✅ ${(wav.length/1024).toFixed(1)}KB WAV`);
    safeSend(clientWs, { type: 'wav_audio', audio: wav.toString('base64'), sampleRate: 24000, requestId });
    safeSend(clientWs, { type: 'done', requestId, chunks: pcmChunks.length });

  } catch (err) {
    console.error('[Sonic] Fatal:', err.message);
    safeSend(clientWs, { type: 'error', message: err.message, requestId });
  }
}

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
  console.log(`🐰 Kira Nova Sonic v6 on port ${PORT}`);
  console.log(`🏥 https://kira-sonic-server.onrender.com`);
});
