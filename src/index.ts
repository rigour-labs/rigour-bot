import express from 'express';
import { createServer } from 'http';
import { config } from './config.js';
import { setupWebhooks } from './handlers/webhooks.js';
import { setupSmeeProxy } from './utils/smee.js';
import { getRigourRuntimeReadiness } from './services/rigour.js';

const app = express();

// Parse JSON payloads
app.use(express.json());

// Health check endpoint
app.get('/health', async (_req, res) => {
  const runtime = await getRigourRuntimeReadiness();
  res.json({
    status: 'ok',
    service: 'rigour-bot',
    version: '0.1.0',
    rigour: {
      exec_mode: config.rigourExecMode,
      deep_mode: config.rigourDeepMode,
      cli_ready: runtime.cli_ready,
      mcp_ready: runtime.mcp_ready,
    },
  });
});

// Readiness check (for k8s/container orchestration)
app.get('/ready', async (_req, res) => {
  const runtime = await getRigourRuntimeReadiness();
  const ready = config.rigourExecMode === 'mcp_only' ? runtime.mcp_ready : runtime.cli_ready || runtime.mcp_ready;

  res.status(ready ? 200 : 503).json({
    ready,
    exec_mode: config.rigourExecMode,
    cli_ready: runtime.cli_ready,
    mcp_ready: runtime.mcp_ready,
  });
});

// Setup GitHub webhook handlers
setupWebhooks(app);

const server = createServer(app);

// Graceful shutdown handling
let isShuttingDown = false;

function gracefulShutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\n${signal} received. Starting graceful shutdown...`);

  // Stop accepting new connections
  server.close((err) => {
    if (err) {
      console.error('Error during shutdown:', err);
      process.exit(1);
    }
    console.log('✅ Server closed gracefully');
    process.exit(0);
  });

  // Force shutdown after 30 seconds
  setTimeout(() => {
    console.error('⚠️  Forced shutdown after timeout');
    process.exit(1);
  }, 30000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

async function start() {
  // Setup Smee proxy for local development
  if (config.webhookProxyUrl) {
    await setupSmeeProxy(config.webhookProxyUrl, `http://localhost:${config.port}/webhooks`);
    console.log(`🔄 Webhook proxy connected: ${config.webhookProxyUrl}`);
  }

  server.listen(config.port, () => {
    console.log(`🤖 Rigour Bot v0.1.0 running on port ${config.port}`);
    console.log(`📍 Webhooks: http://localhost:${config.port}/webhooks`);
    console.log(`❤️  Health: http://localhost:${config.port}/health`);
    console.log(`🌍 Environment: ${config.nodeEnv}`);
    console.log(`🧠 Rigour exec mode: ${config.rigourExecMode}`);
  });
}

start().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
