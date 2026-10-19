> **Archived.** This early GitHub App prototype was never released: the Marketplace listing, pricing, hosted service and features described below do not exist. To review pull requests with Rigour, use the GitHub Action in [rigour-labs/rigour](https://github.com/rigour-labs/rigour) (see [docs/CI.md](https://github.com/rigour-labs/rigour/blob/main/docs/CI.md)).

# Rigour Bot

[![GitHub Marketplace](https://img.shields.io/badge/Marketplace-Rigour%20Bot-blue?logo=github)](https://github.com/marketplace/rigour-bot)

GitHub App for automated code review using Rigour Bot is a GitHub App that automatically analyzes your pull requests using the **Rigour High-Fidelity Analysis Engine**. Unlike basic linters, Rigour performs deep AST analysis, architectural drift detection, and security pattern matching to ensure your code meets the highest engineering standards.

## Privacy & Performance: Sparse Sync

Unlike other bots that require full read access or clone your entire repository, Rigour Bot uses a **Sparse Sync** strategy:
- **Surgical Fetching**: Only files involved in the pull request are fetched.
- **Volatile Storage**: Files are written to a temporary, non-persistent memory workspace.
- **Zero Drift Persistence**: Your entire codebase is never cloned or stored on our servers.
- **High-Fidelity Context**: Provides the engine just enough context to perform deep AST and Security checks without the security risk of full access.
- 🛡️ **Security Drift** - Detects hardcoded secrets, SQL injection risks
- 📐 **Pattern Drift** - Catches console.logs, TODOs, deprecated APIs
- 🏗️ **Architecture Drift** - Layer violations, circular dependencies

## Quick Start (Users)

### Install from GitHub Marketplace

1. Go to [GitHub Marketplace - Rigour Bot](https://github.com/marketplace/rigour-bot)
2. Click **"Install it for free"**
3. Select repositories to enable
4. Done! Rigour will analyze your PRs automatically. **No `rigour.toml` or `rigour.yml` required** – the bot uses high-fidelity defaults out of the box.

---

## Configuration (Optional)

While Rigour Bot works without configuration, you can customize its behavior using a `rigour.yml` or `rigour.toml` file in your repository root. This is useful for:
- Overriding complexity thresholds
- Specifying custom protected paths
- Customizing AST gate rules

See the [Configuration Reference](https://docs.rigour.run/reference/configuration) for all available options.

---

## Self-Hosting Setup

### 1. Create a GitHub App

1. Go to **GitHub Settings → Developer settings → GitHub Apps → New GitHub App**

2. Fill in the details:
   | Field | Value |
   |-------|-------|
   | **App name** | Rigour Bot (or custom name) |
   | **Homepage URL** | https://rigour.run |
   | **Webhook URL** | `https://your-server.com/webhooks` |
   | **Webhook secret** | Generate with `openssl rand -hex 32` |

3. Set **Permissions**:
   - **Repository permissions:**
     - Checks: Read & write
     - Contents: Read
     - Pull requests: Read & write
     - Metadata: Read
   - **Subscribe to events:**
     - Pull request
     - Check run

4. Generate and download a **private key** (.pem file)

5. Note your **App ID** from the app settings page

### 2. Deploy the Bot

#### Option A: Railway (Recommended)

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template/rigour-bot)

1. Click deploy button
2. Add environment variables (see below)
3. Add your private key as `GITHUB_PRIVATE_KEY` (full content, not path)

#### Option B: Docker

```bash
docker build -t rigour-bot .
docker run -p 3000:3000 \
  -e GITHUB_APP_ID=123456 \
  -e GITHUB_PRIVATE_KEY="$(cat private-key.pem)" \
  -e GITHUB_WEBHOOK_SECRET=your-secret \
  rigour-bot
```

#### Option C: Manual

```bash
# Install dependencies
npm install

# Build
npm run build

# Run
npm start
```

#### Option D: Azure Container Apps

Use the deployment script to create/update a dedicated Azure Resource Group + Container App.

```bash
# Required secrets
export GITHUB_APP_ID=123456
export GITHUB_PRIVATE_KEY="$(cat private-key.pem)"
export GITHUB_WEBHOOK_SECRET=your-secret

# Required: globally unique Azure Container Registry name
export ACR_NAME=rigourbotacr12345

# Deploy
./scripts/deploy-azure.sh --app rigour-bot --rg rigour-rg --location eastus
```

After deploy, set your GitHub App webhook URL to:
`https://<container-app-fqdn>/webhooks`

### 3. Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GITHUB_APP_ID` | ✅ | Your GitHub App's ID |
| `GITHUB_PRIVATE_KEY_PATH` | ✅* | Path to .pem file |
| `GITHUB_PRIVATE_KEY` | ✅* | Full private key content (alternative to path) |
| `GITHUB_WEBHOOK_SECRET` | ✅ | Webhook secret from app settings |
| `RIGOUR_API_URL` | ❌ | Rigour MCP API (default: https://mcp.rigour.run/api) |
| `RIGOUR_EXEC_MODE` | ❌ | Analysis mode: `cli_first` (default), `cli_only`, `mcp_only` |
| `RIGOUR_DEEP_ENABLED` | ❌ | Enable deep analysis pipeline (`true`/`false`, default `false`) |
| `RIGOUR_DEEP_MODE` | ❌ | Deep tier: `off` (default), `deep`, `pro` |
| `RIGOUR_PROVIDER` | ❌ | Deep provider for BYOK mode (e.g. `anthropic`, `openai`, `groq`) |
| `RIGOUR_API_KEY` | ❌ | Optional BYOK provider key for deep execution |
| `RIGOUR_API_BASE_URL` | ❌ | Optional custom API base for provider proxy/self-host |
| `RIGOUR_MODEL_NAME` | ❌ | Optional provider model override |
| `RIGOUR_TIMEOUT_MS` | ❌ | Analysis timeout in ms (default: `90000`) |
| `RIGOUR_MAX_CONCURRENCY` | ❌ | Max concurrent analyses per instance (default: `2`) |
| `RIGOUR_FALLBACK_TO_MCP` | ❌ | On CLI error, fallback to MCP (`true` by default) |
| `RIGOUR_SECURITY_AUDIT_ENABLED` | ❌ | Enables optional security-audit enrichment hooks |
| `RIGOUR_DEEP_ALLOWED_REPOS` | ❌ | Comma-separated allowlist for deep mode repos (`org/repo`) |
| `RIGOUR_DEEP_ALLOWED_ORGS` | ❌ | Comma-separated allowlist for deep mode orgs |
| `RIGOUR_MAX_CHANGED_LOC_FOR_DEEP` | ❌ | Disable deep if PR churn exceeds threshold (default: `3000`) |
| `PORT` | ❌ | Server port (default: 3000) |
| `NODE_ENV` | ❌ | `development` or `production` |
| `WEBHOOK_PROXY_URL` | ❌ | Smee URL for local development |

*Use either `GITHUB_PRIVATE_KEY_PATH` or `GITHUB_PRIVATE_KEY`, not both.

### Security and Key Handling

- Default model is **managed key** for standard operation.
- **BYOK is optional** via `RIGOUR_API_KEY` + `RIGOUR_PROVIDER`.
- Runtime logs redact configured secrets and provider tokens.
- Health/readiness expose runtime capability status (`cli_ready`, `mcp_ready`) at `/health` and `/ready`.

---

## Publishing to GitHub Marketplace

### Requirements

1. **Public repository** - Your bot code must be public
2. **Logo** - 200x200px PNG or JPG (no transparency)
3. **README** - Clear description with screenshots
4. **Terms of Service** - Link to your ToS
5. **Privacy Policy** - Link to your privacy policy
6. **Support contact** - Email or URL

### Steps

1. Go to your GitHub App settings
2. Click **"List in Marketplace"** in the sidebar
3. Fill in the listing details:
   - **Primary category**: Code review
   - **Secondary category**: Security
   - **Supported languages**: All
4. Add pricing plans:
   - **Free**: Up to 3 private repos
   - **Pro ($9/mo)**: Unlimited repos + priority analysis
   - **Enterprise**: Custom
5. Submit for review (takes 1-3 business days)

### Marketplace Best Practices

- Add screenshots showing check runs and review comments
- Include a demo GIF of the bot in action
- List all detected drift types
- Mention integration with Rigour MCP

---

## Local Development

### Using Smee (Webhook Proxy)

1. Create a new channel at https://smee.io
2. Add the URL to your `.env`:
   ```env
   WEBHOOK_PROXY_URL=https://smee.io/your-channel-id
   ```
3. Use the Smee URL as your GitHub App's webhook URL
4. Run `npm run dev`

### Testing

```bash
# Run tests
npm test

# Lint
npm run lint
```

---

## Architecture

```
rigour-bot/
├── src/
│   ├── index.ts              # Express server + graceful shutdown
│   ├── config.ts             # Environment configuration
│   ├── handlers/
│   │   ├── webhooks.ts       # GitHub webhook routing
│   │   └── pull-request.ts   # PR analysis orchestration
│   ├── services/
│   │   ├── github.ts         # GitHub API (Checks, Reviews)
│   │   └── rigour.ts         # Rigour MCP + local analysis
│   └── utils/
│       └── smee.ts           # Smee proxy for dev
├── Dockerfile
└── package.json
```

## Supported Drift Types

| Type | Severity | Description |
|------|----------|-------------|
| `security-hardcoded-secret` | 🔴 Error | Hardcoded passwords, API keys, tokens |
| `security-sql-injection` | 🔴 Error | String concatenation in SQL queries |
| `pattern-console-log` | 🟡 Warning | Console statements in production code |
| `stale-react-lifecycle` | 🟡 Warning | Deprecated React lifecycle methods |
| `pattern-todo-comment` | 🔵 Info | TODO/FIXME/HACK comments |

## Troubleshooting

### Bot is installed but not running
If Rigour Bot is installed on your repository but you don't see any activity on your PRs:

1. **Check Railway Logs**: Ensure your bot service is running and not crashing.
2. **Verify Environment Variables**: Make sure `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, and `GITHUB_WEBHOOK_SECRET` are correctly set.
3. **Webhook Visibility**: If self-hosting, ensure your server is reachable from GitHub. Check the "Advanced" tab in your GitHub App settings for webhook delivery logs.
4. **Permissions**: Go to your GitHub App settings and ensure "Read & Write" access is granted for **Checks** and **Pull Requests**.

### "Rigour.yml not found" logs
You might see logs indicating a config file wasn't found. This is **normal** behavior. Rigour Bot will automatically fall back to its internal default quality gates if no configuration file is present.

---

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Health check (returns version) |
| `GET /ready` | Readiness probe for k8s |
| `POST /webhooks` | GitHub webhook receiver |

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing`)
3. Make your changes
4. Run tests (`npm test`)
5. Submit a pull request

## License

MIT © [Rigour Labs](https://rigour.run)

---

<p align="center">
  <a href="https://rigour.run">Website</a> •
  <a href="https://docs.rigour.run">Docs</a> •
  <a href="https://mcp.rigour.run">MCP Server</a>
</p>
