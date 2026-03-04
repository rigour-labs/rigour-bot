# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source
COPY tsconfig.json ./
COPY src/ ./src/

# Build
RUN npm run build

# Production stage
FROM node:20-alpine AS runner

WORKDIR /app

# Create non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 rigour

# Copy package files and install production deps only
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Install Rigour CLI for CLI-first analysis mode
RUN npm install -g @rigour-labs/cli

# Copy built files
COPY --from=builder /app/dist ./dist

# Set ownership
RUN chown -R rigour:nodejs /app

# Switch to non-root user
USER rigour

# Environment
ENV NODE_ENV=production
ENV PORT=3000
ENV RIGOUR_EXEC_MODE=cli_first
ENV RIGOUR_DEEP_ENABLED=false
ENV RIGOUR_DEEP_MODE=off

EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/ready || exit 1

CMD ["node", "dist/index.js"]
