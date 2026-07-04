FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production \
    YOURSERVICE_GATEWAY_HOST=0.0.0.0 \
    YOURSERVICE_GATEWAY_PORT=8788 \
    YOURSERVICE_DATA_PATH=/data/gateway-state.json

COPY package.json ./
COPY src ./src

RUN mkdir -p /data && chown -R node:node /app /data

USER node

EXPOSE 8788

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || process.env.YOURSERVICE_GATEWAY_PORT || 8788) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "src/server.mjs"]
