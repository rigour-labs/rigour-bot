# Rigour Bot

GitHub App for automated code review using [Rigour](https://rigour.run) - like CodeRabbit but for drift detection.

## Features

- **Automated PR Reviews**: Analyzes pull requests for code drift patterns
- **GitHub Check Runs**: Creates check runs with detailed annotations
- **Inline Comments**: Posts review comments on specific lines
- **Multiple Drift Types**: Detects security, pattern, staleness, and architecture drift

## Setup

### 1. Create a GitHub App

1. Go to GitHub Settings → Developer settings → GitHub Apps → New GitHub App
2. Configure the app:
   - **Name**: Rigour Bot (or your preferred name)
   - **Webhook URL**: Your server URL + `/webhooks`
   - **Webhook Secret**: Generate a secure secret
   - **Permissions**:
     - Repository permissions:
       - Checks: Read & write
       - Contents: Read
       - Pull requests: Read & write
     - Subscribe to events:
       - Pull request
       - Check run
3. Generate and download a private key

### 2. Install Dependencies

```bash
npm install
```

### 3. Configure Environment

Copy `.env.example` to `.env` and fill in:

```bash
cp .env.example .env
```

```env
GITHUB_APP_ID=your-app-id
GITHUB_PRIVATE_KEY_PATH=./private-key.pem
GITHUB_WEBHOOK_SECRET=your-webhook-secret
```

### 4. Run the Bot

**Development:**
```bash
npm run dev
```

**Production:**
```bash
npm run build
npm start
```

## Local Development with Smee

For local development, use [Smee](https://smee.io) to proxy webhooks:

1. Create a new channel at https://smee.io
2. Add the URL to your `.env`:
   ```env
   WEBHOOK_PROXY_URL=https://smee.io/your-channel
   ```
3. Use the Smee URL as your GitHub App's webhook URL

## Architecture

```
rigour-bot/
├── src/
│   ├── index.ts           # Express server entry point
│   ├── config.ts          # Configuration management
│   ├── handlers/
│   │   ├── webhooks.ts    # GitHub webhook handlers
│   │   └── pull-request.ts # PR analysis handler
│   ├── services/
│   │   ├── github.ts      # GitHub API service
│   │   └── rigour.ts      # Rigour analysis service
│   └── utils/
│       └── smee.ts        # Smee proxy utility
```

## API Endpoints

- `GET /health` - Health check
- `POST /webhooks` - GitHub webhook receiver

## Supported Drift Types

| Type | Description |
|------|-------------|
| `security-drift` | Hardcoded secrets, SQL injection risks, etc. |
| `pattern-drift` | Console logs, TODO comments, code style violations |
| `staleness-drift` | Deprecated APIs, legacy patterns |
| `architecture-drift` | Layer violations, circular dependencies |

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## License

MIT
