FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY db.js server.js ./
COPY public ./public
RUN mkdir -p data uploads
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
