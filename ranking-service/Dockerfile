FROM node:18-alpine
WORKDIR /usr/src/app
COPY ranking-service/package*.json ./
RUN npm install --only=production
COPY ranking-service/ .
EXPOSE 4003
CMD ["node", "index.js"]
