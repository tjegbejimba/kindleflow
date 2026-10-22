# Exact pin so a build can't ship an older Node. 22.23.4 is the first 22.x with the 2026-10-21 security fixes.
FROM node:22.23.4-alpine3.24

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "start"]
