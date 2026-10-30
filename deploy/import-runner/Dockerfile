FROM node:22-alpine
WORKDIR /runner
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY runner.mjs ./
USER node
CMD ["node", "runner.mjs"]
