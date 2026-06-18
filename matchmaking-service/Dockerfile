FROM node:18-alpine
WORKDIR /usr/src/app
COPY matchmaking-service/package*.json ./
RUN npm install --only=production
COPY matchmaking-service/ .
COPY proto/ ../proto/
EXPOSE 50062
EXPOSE 4005
CMD ["node", "index.js"]
