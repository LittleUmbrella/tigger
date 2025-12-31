FROM node:24-alpine

WORKDIR /app

# Install build dependencies for native modules (better-sqlite3)
RUN apk add --no-cache python3 make g++

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy build configuration
COPY tsconfig.json ./

# Copy config.json (must exist locally, or use CONFIG_JSON env var at runtime)
COPY config.json ./

# Copy source code (this will invalidate cache when source changes)
# Docker uses checksums, so any file change will invalidate this layer
COPY src/ ./src/

# Build TypeScript (will run every time source changes)
RUN npm run build

# Create necessary directories
RUN mkdir -p logs data

# Expose any ports if needed (currently none)
# EXPOSE 3000

# Run the application
CMD ["npm", "start"]

