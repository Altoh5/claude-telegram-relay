FROM oven/bun:1.3-slim

WORKDIR /app

# Install dependencies first (cache layer)
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

# Copy source
COPY . .

# Run VPS gateway (webhook + Anthropic API)
CMD ["bun", "run", "src/vps-gateway.ts"]
