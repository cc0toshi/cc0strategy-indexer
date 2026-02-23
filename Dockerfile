# Node.js runtime
FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including tsx for running TypeScript)
RUN npm ci

# Copy source and migrations
COPY . .

# Expose port
EXPOSE 3000

# Run with tsx
CMD ["npx", "tsx", "src/index.ts"]
