import express from 'express';
import { createServer } from 'http';
import { config } from './config.js';
import { setupWebhooks } from './handlers/webhooks.js';
import { setupSmeeProxy } from './utils/smee.js';

const app = express();

// Parse JSON payloads
app.use(express.json());

// Health check endpoint
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'rigour-bot' });
});

// Setup GitHub webhook handlers
setupWebhooks(app);

const server = createServer(app);

async function start() {
  // Setup Smee proxy for local development
  if (config.webhookProxyUrl) {
    await setupSmeeProxy(config.webhookProxyUrl, `http://localhost:${config.port}/webhooks`);
    console.log(`🔄 Webhook proxy connected: ${config.webhookProxyUrl}`);
  }

  server.listen(config.port, () => {
    console.log(`🤖 Rigour Bot running on port ${config.port}`);
    console.log(`📍 Webhooks: http://localhost:${config.port}/webhooks`);
    console.log(`❤️  Health: http://localhost:${config.port}/health`);
  });
}

start().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
