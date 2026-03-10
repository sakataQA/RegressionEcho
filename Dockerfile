FROM mcr.microsoft.com/playwright:v1.50.0-jammy

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

ENV CI=1
ENV PW_HEADLESS=true
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

ENTRYPOINT ["node", "bin/cli.js"]
