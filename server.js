/**
 * Kira — Nova Sonic Proxy Server
 * 
 * Bridges React Native app ↔ Amazon Nova 2 Sonic
 * 
 * Flow:
 * 1. React Native connects via plain WebSocket to THIS server
 * 2. App sends: { type: 'speak', text: '...', voice: 'ruth', personality: '...' }
 * 3. Server opens bidirectional stream to Nova Sonic via AWS SDK
 * 4. Server sends text → Nova Sonic generates PCM audio
 * 5. Server collects audio chunks → sends base64 audio back to app
 * 6. App plays the audio
 */

const { BedrockRuntimeClient, InvokeModelWithBidirectionalStreamCommand } = require('@aws-sdk/client-bedrock-runtime');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

// ── Config ────────────────────────────────────────────────────────────────────
const PORT        = process.env.PORT || 3000;
const AWS_REGION  = process.env.AWS_REGION  || 'us-east-1';
const AWS_KEY     = process.env.AWS_ACCESS_KEY_ID;
const AWS_SECRET  = process.env.AWS_SECRET_ACCESS_KEY;
const MODEL_ID    = 'amazon.nova-sonic-v1:0';

// Personality → Nova Sonic voice ID mapping
const VOICE_MAP = {
  'Warm & Friendly':  'ruth',
  'Professional':     'matthew',
  'Playful':          'joanna',
  'Calm & Gentle':    'salli',
  'Bold & Confident': 'stephen',
  'Youthful':         'kendra',
  'default':          'ruth',
};

// ── AWS Bedrock client ────────────────────────────────────────────────────────
const bedrock = new BedrockRuntimeClient({
  region: AWS_REGION,
  credentials: {
    accessKeyId:     AWS_KEY,
    secretAccessKey: AWS_SECRET,
  },
});

// ── WebSocket server ──────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ port: PORT });
console.log(`🐰 Kira Nova Sonic server running on port ${PORT}`);

wss.on('connection', (clientWs) => {
  console.log('[Server] React Native client connected');

  clientWs.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === 'speak') {
      await handleSpeak(clientWs, msg);
    } else if (msg.type === 'ping') {
      clientWs.send(JSON.stringify({ type: 'pong' }));
    }
  });

  clientWs.on('close', () => console.log('[Server] Client disconnected'));
  clientWs.on('error', (e) => console.error('[Server] Client error:', e.message));
});

// ── Handle speak request ──────────────────────────────────────────────────────
async function handleSpeak(clientWs, { text, personality = 'default', requestId }) {
  if (!text?.trim()) return;

  const voiceId    = VOICE_MAP[personality] || VOICE_MAP.default;
  const promptName = uuidv4();
  const audioChunks = [];

  console.log(`[Sonic] Speaking: "${text.slice(0, 50)}..." voice=${voiceId}`);

  // Notify client that synthesis is starting
  safeSend(clientWs, { type: 'start', requestId });

  try {
    // ── Build the event stream to send to Nova Sonic ──────────────────────────
    async function* generateEventStream() {

      // 1. sessionStart
      yield encoder({
        event: {
          sessionStart: {
            inferenceConfiguration: {
              maxTokens: 1024,
              topP: 0.9,
              temperature: 0.7,
            },
          },
        },
      });

      // 2. promptStart — define audio output format
      yield encoder({
        event: {
          promptStart: {
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
          },
        },
      });

      // 3. System prompt contentStart
      const systemContentName = uuidv4();
      yield encoder({
        event: {
          contentStart: {
            promptName,
            contentName: systemContentName,
            type:        'TEXT',
            interactive: false,
            role:        'SYSTEM',
            textInputConfiguration: { mediaType: 'text/plain' },
          },
        },
      });

      // 4. System prompt text
      yield encoder({
        event: {
          textInput: {
            promptName,
            contentName: systemContentName,
            content: `You are Bunnie, a warm AI companion for Kira, an app for deaf and mute users. 
Speak naturally and clearly. Keep responses concise and helpful.`,
          },
        },
      });

      // 5. System contentEnd
      yield encoder({
        event: {
          contentEnd: { promptName, contentName: systemContentName },
        },
      });

      // 6. User text contentStart
      const userContentName = uuidv4();
      yield encoder({
        event: {
          contentStart: {
            promptName,
            contentName: userContentName,
            type:        'TEXT',
            interactive: false,
            role:        'USER',
            textInputConfiguration: { mediaType: 'text/plain' },
          },
        },
      });

      // 7. The actual text to speak
      yield encoder({
        event: {
          textInput: {
            promptName,
            contentName: userContentName,
            content: text,
          },
        },
      });

      // 8. User contentEnd
      yield encoder({
        event: {
          contentEnd: { promptName, contentName: userContentName },
        },
      });

      // 9. promptEnd
      yield encoder({
        event: { promptEnd: { promptName } },
      });

      // 10. sessionEnd
      yield encoder({
        event: { sessionEnd: {} },
      });
    }

    // ── Invoke Nova Sonic ─────────────────────────────────────────────────────
    const command = new InvokeModelWithBidirectionalStreamCommand({
      modelId: MODEL_ID,
      body:    generateEventStream(),
    });

    const response = await bedrock.send(command);

    // ── Process response stream ───────────────────────────────────────────────
    for await (const chunk of response.body) {
      if (chunk.chunk?.bytes) {
        try {
          const event = JSON.parse(Buffer.from(chunk.chunk.bytes).toString('utf-8'));

          // Audio output event — send chunk to client
          if (event.event?.audioOutput?.content) {
            const audioB64 = event.event.audioOutput.content;
            audioChunks.push(audioB64);

            // Stream chunks to client as they arrive
            safeSend(clientWs, {
              type:      'audio_chunk',
              audio:     audioB64,
              requestId,
              sampleRate: 24000,
            });
          }

          // Text output — send transcript back too
          if (event.event?.textOutput?.content) {
            safeSend(clientWs, {
              type:      'text',
              content:   event.event.textOutput.content,
              requestId,
            });
          }

        } catch (parseErr) {
          // Non-JSON chunk — skip
        }
      }
    }

    // Signal completion
    safeSend(clientWs, {
      type:       'done',
      requestId,
      chunks:     audioChunks.length,
    });

    console.log(`[Sonic] Done — ${audioChunks.length} audio chunks sent`);

  } catch (err) {
    console.error('[Sonic] Error:', err.message);
    safeSend(clientWs, {
      type:    'error',
      message: err.message,
      requestId,
    });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function encoder(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf-8');
}

function safeSend(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// Health check via HTTP on same port won't work with ws — use a separate port
const http = require('http');
http.createServer((req, res) => {
  res.writeHead(200);
  res.end(JSON.stringify({ status: 'ok', service: 'kira-sonic', model: MODEL_ID }));
}).listen(PORT + 1, () => {
  console.log(`🏥 Health check at http://localhost:${PORT + 1}`);
});