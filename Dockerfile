# Use the official Playwright image
FROM mcr.microsoft.com/playwright:v1.45.0-noble

WORKDIR /app
COPY . .
RUN npm install
RUN npx playwright install chromium

EXPOSE 10000
CMD ["npm", "start"]
