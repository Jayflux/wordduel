FROM node:18-alpine
WORKDIR /usr/src/app
COPY chat-service/package*.json ./
RUN npm install --only=production
COPY chat-service/ .
EXPOSE 4004
CMD ["node", "index.js"]
