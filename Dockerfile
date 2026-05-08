FROM node:18-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --production

COPY . .

EXPOSE 3000

ENV NODE_ENV=production
ENV TZ=Asia/Shanghai

CMD ["node", "app.js"]
