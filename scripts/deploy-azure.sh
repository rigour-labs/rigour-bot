#!/usr/bin/env bash
# Rigour Bot Azure Deployment Script
#
# Deploys this repo to Azure Container Apps using ACR cloud builds.
#
# Usage:
#   ./scripts/deploy-azure.sh                # Deploy with defaults
#   ./scripts/deploy-azure.sh --help         # Show help
#   ./scripts/deploy-azure.sh --app rigour-bot-prod --rg rigour-rg --location eastus
#
# Required env vars:
#   GITHUB_APP_ID
#   GITHUB_PRIVATE_KEY      # Supports multiline PEM; script normalizes to \n form
#   GITHUB_WEBHOOK_SECRET
#
# Optional env vars:
#   RIGOUR_API_URL          # Default: https://mcp.rigour.run/api
#   ACR_NAME                # Required if --acr not passed; must be globally unique
#   IMAGE_TAG               # Default: <git-sha>-<timestamp>

set -euo pipefail

APP_NAME="rigour-bot"
RESOURCE_GROUP="rigour-rg"
LOCATION="eastus"
CONTAINER_ENV="rigour-bot-env"
LOG_WORKSPACE="rigour-bot-logs"
ACR_NAME="${ACR_NAME:-}"
IMAGE_REPO="rigour-bot"
TARGET_PORT="3000"
MIN_REPLICAS="1"
MAX_REPLICAS="2"

print() {
  printf '%s\n' "$1"
}

usage() {
  cat <<USAGE
Usage: ./scripts/deploy-azure.sh [options]

Options:
  --app <name>           Container App name (default: rigour-bot)
  --rg <name>            Resource Group (default: rigour-rg)
  --location <region>    Azure region (default: eastus)
  --env <name>           Container Apps environment (default: rigour-bot-env)
  --logs <name>          Log Analytics workspace (default: rigour-bot-logs)
  --acr <name>           ACR name (required unless ACR_NAME env var is set)
  --image-repo <name>    Image repo name in ACR (default: rigour-bot)
  --min <n>              Min replicas (default: 1)
  --max <n>              Max replicas (default: 2)
  --help                 Show this help
USAGE
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    print "ERROR: Missing required command: $1"
    exit 1
  fi
}

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    print "ERROR: Missing required env var: $name"
    exit 1
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app)
      APP_NAME="$2"; shift 2 ;;
    --rg)
      RESOURCE_GROUP="$2"; shift 2 ;;
    --location)
      LOCATION="$2"; shift 2 ;;
    --env)
      CONTAINER_ENV="$2"; shift 2 ;;
    --logs)
      LOG_WORKSPACE="$2"; shift 2 ;;
    --acr)
      ACR_NAME="$2"; shift 2 ;;
    --image-repo)
      IMAGE_REPO="$2"; shift 2 ;;
    --min)
      MIN_REPLICAS="$2"; shift 2 ;;
    --max)
      MAX_REPLICAS="$2"; shift 2 ;;
    --help|-h)
      usage; exit 0 ;;
    *)
      print "ERROR: Unknown argument: $1"
      usage
      exit 1 ;;
  esac
done

require_cmd az
require_cmd git

require_env GITHUB_APP_ID
require_env GITHUB_PRIVATE_KEY
require_env GITHUB_WEBHOOK_SECRET

if [[ -z "$ACR_NAME" ]]; then
  print "ERROR: ACR name is required. Pass --acr <name> or set ACR_NAME."
  exit 1
fi

if [[ ! "$ACR_NAME" =~ ^[a-z0-9]{5,50}$ ]]; then
  print "ERROR: ACR_NAME must be 5-50 chars, lowercase letters and numbers only."
  exit 1
fi

if ! az account show >/dev/null 2>&1; then
  print "ERROR: Azure CLI is not logged in. Run: az login"
  exit 1
fi

# Ensure Container Apps commands are available in non-interactive mode.
az extension add --name containerapp --upgrade --allow-preview true --only-show-errors >/dev/null

IMAGE_TAG="${IMAGE_TAG:-$(git rev-parse --short HEAD 2>/dev/null || echo nogit)-$(date +%Y%m%d%H%M%S)}"
RIGOUR_API_URL="${RIGOUR_API_URL:-https://mcp.rigour.run/api}"

# Normalize multiline PEM for env injection into config loader.
GITHUB_PRIVATE_KEY_NORMALIZED="${GITHUB_PRIVATE_KEY//$'\r'/}"
GITHUB_PRIVATE_KEY_NORMALIZED="${GITHUB_PRIVATE_KEY_NORMALIZED//$'\n'/\\n}"

print "[1/8] Ensuring resource group: $RESOURCE_GROUP"
az group create --name "$RESOURCE_GROUP" --location "$LOCATION" --output none

print "[2/8] Ensuring ACR: $ACR_NAME"
if ! az acr show --name "$ACR_NAME" --resource-group "$RESOURCE_GROUP" >/dev/null 2>&1; then
  az acr create \
    --name "$ACR_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --location "$LOCATION" \
    --sku Basic \
    --admin-enabled true \
    --output none
fi

print "[3/8] Building and pushing image in ACR"
az acr build \
  --registry "$ACR_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --image "${IMAGE_REPO}:${IMAGE_TAG}" \
  --file Dockerfile \
  .

ACR_LOGIN_SERVER="$(az acr show --name "$ACR_NAME" --resource-group "$RESOURCE_GROUP" --query loginServer -o tsv)"
IMAGE_URI="${ACR_LOGIN_SERVER}/${IMAGE_REPO}:${IMAGE_TAG}"
ACR_USERNAME="$(az acr credential show --name "$ACR_NAME" --resource-group "$RESOURCE_GROUP" --query username -o tsv)"
ACR_PASSWORD="$(az acr credential show --name "$ACR_NAME" --resource-group "$RESOURCE_GROUP" --query 'passwords[0].value' -o tsv)"

print "[4/8] Ensuring Log Analytics workspace: $LOG_WORKSPACE"
az monitor log-analytics workspace create \
  --resource-group "$RESOURCE_GROUP" \
  --workspace-name "$LOG_WORKSPACE" \
  --location "$LOCATION" \
  --output none

LOG_WORKSPACE_ID="$(az monitor log-analytics workspace show --resource-group "$RESOURCE_GROUP" --workspace-name "$LOG_WORKSPACE" --query customerId -o tsv)"
LOG_WORKSPACE_KEY="$(az monitor log-analytics workspace get-shared-keys --resource-group "$RESOURCE_GROUP" --workspace-name "$LOG_WORKSPACE" --query primarySharedKey -o tsv)"

print "[5/8] Ensuring Container Apps environment: $CONTAINER_ENV"
if ! az containerapp env show --name "$CONTAINER_ENV" --resource-group "$RESOURCE_GROUP" >/dev/null 2>&1; then
  az containerapp env create \
    --name "$CONTAINER_ENV" \
    --resource-group "$RESOURCE_GROUP" \
    --location "$LOCATION" \
    --logs-workspace-id "$LOG_WORKSPACE_ID" \
    --logs-workspace-key "$LOG_WORKSPACE_KEY" \
    --output none
fi

print "[6/8] Creating or updating Container App: $APP_NAME"
if az containerapp show --name "$APP_NAME" --resource-group "$RESOURCE_GROUP" >/dev/null 2>&1; then
  az containerapp secret set \
    --name "$APP_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --secrets \
      gh-app-id="$GITHUB_APP_ID" \
      gh-private-key="$GITHUB_PRIVATE_KEY_NORMALIZED" \
      gh-webhook="$GITHUB_WEBHOOK_SECRET" \
    --output none

  az containerapp update \
    --name "$APP_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --image "$IMAGE_URI" \
    --set-env-vars \
      NODE_ENV=production \
      PORT="$TARGET_PORT" \
      RIGOUR_API_URL="$RIGOUR_API_URL" \
      GITHUB_APP_ID=secretref:gh-app-id \
      GITHUB_PRIVATE_KEY=secretref:gh-private-key \
      GITHUB_WEBHOOK_SECRET=secretref:gh-webhook \
    --min-replicas "$MIN_REPLICAS" \
    --max-replicas "$MAX_REPLICAS" \
    --output none
else
  az containerapp create \
    --name "$APP_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --environment "$CONTAINER_ENV" \
    --image "$IMAGE_URI" \
    --ingress external \
    --target-port "$TARGET_PORT" \
    --registry-server "$ACR_LOGIN_SERVER" \
    --registry-username "$ACR_USERNAME" \
    --registry-password "$ACR_PASSWORD" \
    --secrets \
      gh-app-id="$GITHUB_APP_ID" \
      gh-private-key="$GITHUB_PRIVATE_KEY_NORMALIZED" \
      gh-webhook="$GITHUB_WEBHOOK_SECRET" \
    --env-vars \
      NODE_ENV=production \
      PORT="$TARGET_PORT" \
      RIGOUR_API_URL="$RIGOUR_API_URL" \
      GITHUB_APP_ID=secretref:gh-app-id \
      GITHUB_PRIVATE_KEY=secretref:gh-private-key \
      GITHUB_WEBHOOK_SECRET=secretref:gh-webhook \
    --min-replicas "$MIN_REPLICAS" \
    --max-replicas "$MAX_REPLICAS" \
    --output none
fi

print "[7/8] Fetching endpoint"
FQDN="$(az containerapp show --name "$APP_NAME" --resource-group "$RESOURCE_GROUP" --query properties.configuration.ingress.fqdn -o tsv)"

print "[8/8] Deployment complete"
print "App: $APP_NAME"
print "Image: $IMAGE_URI"
print "Webhook URL: https://${FQDN}/webhooks"
print "Health URL: https://${FQDN}/health"
