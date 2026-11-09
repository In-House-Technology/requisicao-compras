FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
# Includes migrations, catalog declarations and the company's config after installation.
COPY . ./

EXPOSE 8080
CMD ["node", "server.js"]
