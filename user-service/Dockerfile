FROM node:18-alpine
WORKDIR /usr/src/app
COPY user-service/package*.json ./
RUN npm install --only=production
COPY user-service/ .
COPY proto/ ../proto/
EXPOSE 4002
EXPOSE 50061
CMD ["node", "index.js"]
