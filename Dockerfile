FROM node:22.16-alpine
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 ANTERA_DATA=/data/antera.db
WORKDIR /app
COPY package.json package-lock.json ./
# Installs only the optional Anthropic SDK (for the Level 2 investigator); ANTERA itself has no dependencies.
RUN npm ci --omit=dev && npm cache clean --force
COPY bin ./bin
COPY src ./src
COPY public ./public
COPY examples ./examples
RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "bin/antera.js", "serve"]
