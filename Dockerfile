# ─── BorealisMark Protocol API ─────────────────────────────────────────────────
# Build: compile TypeScript, then slim down for production

FROM node:22-slim

WORKDIR /app

# Install build dependencies for better-sqlite3 (native module)
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Copy package files and install all deps (need devDeps for tsc)
COPY package.json package-lock.json* ./
RUN npm ci --production=false

# Copy source and compile
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

# Remove dev dependencies
RUN npm prune --production

# Copy static files (dashboard, etc.)
COPY public/ ./public/

# Create persistent data directory
RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV PORT=3001
ENV DB_PATH=/app/data/borealismark.db

EXPOSE 3001

CMD ["node", "dist/server.js"]
