FROM node:20-slim

# Install build tools for native modules (better-sqlite3)
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies (root package.json)
COPY package*.json ./
RUN npm ci --production

# Copy app files (server/node_modules excluded via .dockerignore)
COPY server/ ./server/
COPY index.html manifest.json sw.js church-logo.png ./
COPY icons/ ./icons/

# Create data directory
RUN mkdir -p /app/server/db /app/server/uploads

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "const http=require('http');http.get('http://localhost:3001/api/health',r=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

CMD ["node", "server/index.js"]
