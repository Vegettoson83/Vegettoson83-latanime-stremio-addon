# Use the official Playwright image which comes with browsers and dependencies
FROM mcr.microsoft.com/playwright:v1.45.0-noble

# Set the working directory
WORKDIR /app

# Copy application files
COPY . .

# Install Node.js dependencies
RUN npm install

# Expose the ports for the addon and the bridge server
EXPOSE 7000 3001 10000

# Set the command to start the application
CMD ["npm", "start"]
