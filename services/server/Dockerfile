FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY services/server/package.json services/server/package.json
COPY apps/mobile/package.json apps/mobile/package.json
RUN npm ci --workspace @bureau/server --workspace @bureau/contracts --include-workspace-root
COPY packages/ packages/
COPY services/server/ services/server/
COPY database/modern/ database/modern/
USER node
EXPOSE 3000
CMD ["npm", "run", "api"]
