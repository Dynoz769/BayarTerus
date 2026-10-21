FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production \
    DB_PATH=/app/data/bayarterus.db \
    TRUST_PROXY=1

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public

# Pangkalan data SQLite disimpan di sini — sambungkan volume/disk kekal ke /app/data.
# Berjalan sebagai root kerana volume Railway/Render dipasang dengan pemilik root.
RUN mkdir -p /app/data

EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
