# Use the official Playwright image which comes with browsers and dependencies installed
FROM mcr.microsoft.com/playwright:v1.45.0-jammy

# Set the working directory in the container
WORKDIR /app

# Copy package.json and package-lock.json to leverage Docker cache
COPY package*.json ./

# Install dependencies
RUN npm install
# Install Playwright browsers and dependencies
RUN npx playwright install --with-deps

# Copy the rest of the application files
COPY . .

# Expose the port the main addon service runs on for Render
EXPOSE 10000

# Command to run the single addon service
CMD ["node", "server.js"]
