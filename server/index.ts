import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { checkNeo4jHealth, closeDriver } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_CONFIG = path.resolve(__dirname, 'mcp-config.json');

const SYSTEM_PROMPT = [
  'You are a knowledge graph assistant with access to a Neo4j database via MCP tools.',
  'When the user asks questions about data (artists, artworks, relationships, counts, etc.),',
  'ALWAYS use your neo4j MCP tools to query the database — do NOT guess or suggest queries.',
  'Use execute_cypher for custom queries, get_schema to understand the data model,',
  'and get_statistics for overview counts.',
  'Present results in a clear, readable format.',
].join(' ');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '1mb' }));

interface RequestMessage {
  role: string;
  parts?: Array<{ type: string; text?: string }>;
  content?: string;
}

function extractText(msg: RequestMessage): string {
  // AI SDK v6 sends `parts`, fallback to `content` for compat
  if (msg.parts) {
    return msg.parts
      .filter((p) => p.type === 'text' && p.text)
      .map((p) => p.text)
      .join('');
  }
  return msg.content || '';
}

function formatPrompt(messages: RequestMessage[]): string {
  // Single message — pass directly
  if (messages.length === 1) return extractText(messages[0]);

  // Multi-turn — format as conversation context
  return messages
    .map((m) => {
      const label = m.role === 'user' ? 'Human' : 'Assistant';
      return `${label}: ${extractText(m)}`;
    })
    .join('\n\n');
}

// SSE helper: write a UI Message Stream part
function writePart(res: express.Response, part: Record<string, unknown>): void {
  res.write(`data: ${JSON.stringify(part)}\n\n`);
}

// POST /api/chat — Vercel AI SDK UI Message Stream protocol
app.post('/api/chat', (req, res) => {
  const { messages } = req.body as { messages?: RequestMessage[] };

  console.log('[chat] Received request with', messages?.length, 'messages');

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: 'messages array is required' });
    return;
  }

  const prompt = formatPrompt(messages);
  console.log('[chat] Formatted prompt:', prompt.slice(0, 200));

  // Disable request timeout — claude CLI can take 10-30s to start
  req.socket.setTimeout(0);
  req.socket.setNoDelay(true);
  req.socket.setKeepAlive(true);

  // AI SDK UI Message Stream headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Vercel-AI-UI-Message-Stream', 'v1');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Spawn claude with stream-json for structured events (tool calls + text)
  const { CLAUDECODE: _, ...cleanEnv } = process.env;

  console.log('[chat] Spawning claude -p stream-json ...');
  const t0 = Date.now();
  const child = spawn('claude', [
    '-p',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--system-prompt', SYSTEM_PROMPT,
    '--mcp-config', MCP_CONFIG,
    '--allowedTools', 'mcp__neo4j__execute_cypher,mcp__neo4j__get_schema,mcp__neo4j__get_statistics',
  ], {
    env: cleanEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  child.stdin.write(prompt);
  child.stdin.end();

  // Emit stream start
  writePart(res, { type: 'start' });

  let closed = false;
  let inStep = false;
  let activeTextId: string | null = null;

  // Track tool calls by their CLI block id → our toolCallId mapping
  const toolCalls = new Map<string, string>();

  function ensureStep() {
    if (!inStep) {
      writePart(res, { type: 'start-step' });
      inStep = true;
    }
  }

  function endStep() {
    if (activeTextId) {
      writePart(res, { type: 'text-end', id: activeTextId });
      activeTextId = null;
    }
    if (inStep) {
      writePart(res, { type: 'finish-step' });
      inStep = false;
    }
  }

  // Keep-alive: send SSE comments every 2s while waiting for claude to start.
  const heartbeat = setInterval(() => {
    if (!closed) res.write(': heartbeat\n\n');
  }, 2000);

  // Parse stream-json NDJSON events from stdout
  let stdoutBuf = '';

  child.stdout.on('data', (chunk: Buffer) => {
    if (closed) return;
    stdoutBuf += chunk.toString();

    // Process complete lines
    let newlineIdx: number;
    while ((newlineIdx = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, newlineIdx).trim();
      stdoutBuf = stdoutBuf.slice(newlineIdx + 1);
      if (!line) continue;

      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        // Not JSON — skip
        continue;
      }

      processEvent(event);
    }
  });

  function processEvent(event: any) {
    if (closed) return;

    // stream_event wraps Anthropic API-style events
    if (event.type === 'stream_event') {
      const e = event.event;

      // Tool use block starts
      if (e.type === 'content_block_start' && e.content_block?.type === 'tool_use') {
        const toolCallId = crypto.randomUUID();
        toolCalls.set(e.content_block.id, toolCallId);
        ensureStep();

        const rawName: string = e.content_block.name || '';
        // Strip mcp__neo4j__ prefix for cleaner display
        const toolName = rawName.replace(/^mcp__\w+__/, '');

        writePart(res, {
          type: 'tool-input-start',
          toolCallId,
          toolName,
          dynamic: true,
        });
        return;
      }

      // Text block starts
      if (e.type === 'content_block_start' && e.content_block?.type === 'text') {
        ensureStep();
        activeTextId = crypto.randomUUID();
        writePart(res, { type: 'text-start', id: activeTextId });
        return;
      }

      // Text streaming delta
      if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta' && e.delta.text) {
        if (activeTextId) {
          writePart(res, { type: 'text-delta', id: activeTextId, delta: e.delta.text });
        }
        return;
      }

      // Message finished — end step when a turn completes
      if (e.type === 'message_delta' && e.delta?.stop_reason === 'tool_use') {
        endStep();
        return;
      }

      return;
    }

    // Complete assistant message — extract full tool inputs
    if (event.type === 'assistant' && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === 'tool_use' && toolCalls.has(block.id)) {
          const toolCallId = toolCalls.get(block.id)!;
          const rawName: string = block.name || '';
          const toolName = rawName.replace(/^mcp__\w+__/, '');

          writePart(res, {
            type: 'tool-input-available',
            toolCallId,
            toolName,
            input: block.input,
            dynamic: true,
          });
        }
      }
      return;
    }

    // Tool result from MCP
    if (event.type === 'user' && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === 'tool_result' && toolCalls.has(block.tool_use_id)) {
          const toolCallId = toolCalls.get(block.tool_use_id)!;
          // Extract text from tool result content
          let output = '';
          if (Array.isArray(block.content)) {
            output = block.content
              .filter((c: any) => c.type === 'text')
              .map((c: any) => c.text)
              .join('');
          } else if (typeof block.content === 'string') {
            output = block.content;
          }

          writePart(res, {
            type: 'tool-output-available',
            toolCallId,
            output,
            dynamic: true,
          });
        }
      }
      return;
    }

    // Final result — finish the stream
    if (event.type === 'result') {
      endStep();
      writePart(res, { type: 'finish', finishReason: 'stop' });
      res.write('data: [DONE]\n\n');
      res.end();
      closed = true;
      clearInterval(heartbeat);
      return;
    }
  }

  // Log stderr for debugging
  child.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) console.error('[chat][claude stderr]', text);
  });

  child.on('close', (code) => {
    clearInterval(heartbeat);
    console.log(`[chat] claude exited code=${code} (+${Date.now() - t0}ms)`);

    if (closed) return;
    closed = true;

    if (code !== 0 && code !== null) {
      writePart(res, { type: 'error', errorText: `claude exited with code ${code}` });
    }
    endStep();
    writePart(res, { type: 'finish', finishReason: 'stop' });
    res.write('data: [DONE]\n\n');
    res.end();
  });

  child.on('error', (err) => {
    clearInterval(heartbeat);
    console.error('[chat] spawn error:', err.message);
    if (closed) return;
    closed = true;

    writePart(res, { type: 'error', errorText: err.message });
    res.write('data: [DONE]\n\n');
    res.end();
  });

  // Kill child process if client disconnects.
  // Must use res.on('close') — req.on('close') fires when the POST body is fully read (~2ms).
  res.on('close', () => {
    clearInterval(heartbeat);
    if (!closed) {
      closed = true;
      if (!child.killed) {
        console.log(`[chat] Client disconnected (+${Date.now() - t0}ms), killing claude`);
        child.kill('SIGTERM');
      }
    }
  });
});

// GET /api/health — server health
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// GET /api/health/db — Neo4j connectivity check
app.get('/api/health/db', async (_req, res) => {
  const result = await checkNeo4jHealth();

  if (result.ok) {
    res.json({ status: 'connected', latencyMs: result.latencyMs });
  } else {
    res.status(503).json({ status: 'disconnected', error: result.error });
  }
});

const server = app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  await closeDriver();
  server.close();
});
