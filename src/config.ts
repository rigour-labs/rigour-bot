import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

function loadPrivateKey(): string {
  // Option 1: Private key content directly in env var (for Docker/Railway)
  if (process.env.GITHUB_PRIVATE_KEY) {
    return process.env.GITHUB_PRIVATE_KEY.replace(/\\n/g, '\n');
  }

  // Option 2: Path to .pem file
  const keyPath = process.env.GITHUB_PRIVATE_KEY_PATH;
  if (!keyPath) {
    throw new Error('Either GITHUB_PRIVATE_KEY or GITHUB_PRIVATE_KEY_PATH is required');
  }

  const absolutePath = path.resolve(keyPath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Private key file not found: ${absolutePath}`);
  }

  return fs.readFileSync(absolutePath, 'utf-8');
}

export const config = {
  // GitHub App
  appId: process.env.GITHUB_APP_ID || '',
  privateKey: process.env.GITHUB_APP_ID ? loadPrivateKey() : '',
  webhookSecret: process.env.GITHUB_WEBHOOK_SECRET || '',

  // Rigour
  rigourApiUrl: process.env.RIGOUR_API_URL || 'https://mcp.rigour.run/api',
  rigourConfigPath: process.env.RIGOUR_CONFIG_PATH || './rigour.yml',

  // Server
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',

  // Development
  webhookProxyUrl: process.env.WEBHOOK_PROXY_URL || '',
};

// Validate required config in production
if (config.nodeEnv === 'production') {
  const required = ['appId', 'privateKey', 'webhookSecret'] as const;
  for (const key of required) {
    if (!config[key]) {
      throw new Error(`Missing required config: ${key}`);
    }
  }
}
