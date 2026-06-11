FROM node:20-alpine
WORKDIR /app
COPY orchestrator/package.json ./
RUN npm install --omit=dev
COPY config ./config
COPY orchestrator/src ./src
EXPOSE 3000
CMD ["npm", "start"]
