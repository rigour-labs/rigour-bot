import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

export type RigourExecMode = 'cli_first' | 'cli_only' | 'mcp_only';
export type RigourDeepMode = 'off' | 'deep' | 'pro';

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function parseInteger(value: string | undefined, defaultValue: number): number {
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function parseExecMode(value: string | undefined): RigourExecMode {
  if (value === 'cli_only' || value === 'mcp_only' || value === 'cli_first') {
    return value;
  }
  return 'cli_first';
}

function parseDeepMode(value: string | undefined): RigourDeepMode {
  if (value === 'off' || value === 'deep' || value === 'pro') {
    return value;
  }
  return 'off';
}

function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(',').map((v) => v.trim()).filter(Boolean);
}

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

  // Rigour MCP endpoint
  rigourApiUrl: process.env.RIGOUR_API_URL || 'https://mcp.rigour.run/api',
  rigourConfigPath: process.env.RIGOUR_CONFIG_PATH || './rigour.yml',

  // Rigour execution strategy
  rigourExecMode: parseExecMode(process.env.RIGOUR_EXEC_MODE),
  rigourDeepEnabled: parseBoolean(process.env.RIGOUR_DEEP_ENABLED, false),
  rigourDeepMode: parseDeepMode(process.env.RIGOUR_DEEP_MODE),
  rigourProvider: process.env.RIGOUR_PROVIDER || '',
  rigourApiKey: process.env.RIGOUR_API_KEY || '',
  rigourApiBaseUrl: process.env.RIGOUR_API_BASE_URL || '',
  rigourModelName: process.env.RIGOUR_MODEL_NAME || '',
  rigourTimeoutMs: parseInteger(process.env.RIGOUR_TIMEOUT_MS, 90000),
  rigourMaxConcurrency: parseInteger(process.env.RIGOUR_MAX_CONCURRENCY, 2),
  rigourFallbackToMcp: parseBoolean(process.env.RIGOUR_FALLBACK_TO_MCP, true),
  rigourSecurityAuditEnabled: parseBoolean(process.env.RIGOUR_SECURITY_AUDIT_ENABLED, false),
  rigourMaxChangedLocForDeep: parseInteger(process.env.RIGOUR_MAX_CHANGED_LOC_FOR_DEEP, 3000),
  rigourDeepAllowedRepos: parseCsv(process.env.RIGOUR_DEEP_ALLOWED_REPOS),
  rigourDeepAllowedOrgs: parseCsv(process.env.RIGOUR_DEEP_ALLOWED_ORGS),

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
