# Stage 1: Build React frontend
FROM node:20-alpine AS client-build
WORKDIR /app/client
COPY client/package.json client/package-lock.json* ./
RUN npm install
COPY client/ ./
RUN npm run build

# Stage 2: Run Node.js server
FROM node:20-alpine
WORKDIR /app

# Install native build tools for better-sqlite3
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json* ./
RUN npm install --production

COPY server/ ./server/
COPY --from=client-build /app/client/dist ./client/dist/

# Create data directory
RUN mkdir -p /data

# Environment variables
ENV PORT=3000
ENV TCP_PORT=3888
ENV DATA_DIR=/data

# Expose ports
EXPOSE 3000
EXPOSE 3888

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || exit 1

CMD ["node", "server/index.js"]
