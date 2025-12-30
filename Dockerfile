FROM node:24-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Create necessary directories
RUN mkdir -p logs data

# Expose any ports if needed (currently none)
# EXPOSE 3000

# Run the application
CMD ["npm", "start"]

