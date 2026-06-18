FROM node:18-alpine
WORKDIR /usr/src/app
COPY login-service/package*.json ./
RUN npm install --only=production
COPY login-service/ .
EXPOSE 4001
CMD ["node", "index.js"]
