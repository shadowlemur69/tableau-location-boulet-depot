FROM node:22-slim
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY public ./public

# Volume Railway/Render pour persister la base SQLite
VOLUME ["/data"]
ENV DB_PATH=/data/data.db
ENV PORT=5000
ENV NODE_ENV=production
EXPOSE 5000

CMD ["node", "server.js"]
