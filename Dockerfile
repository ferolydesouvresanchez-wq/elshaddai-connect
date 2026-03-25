FROM node:20-slim

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --production

# Copy app files
COPY server/ ./server/
COPY index.html manifest.json sw.js church-logo.png ./
COPY icons/ ./icons/

# Create data directory
RUN mkdir -p /app/server/db /app/server/uploads

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

CMD ["node", "server/index.js"]
