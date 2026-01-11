# Use the official Playwright image which comes with browsers and dependencies installed
FROM mcr.microsoft.com/playwright:v1.45.0-jammy

# Set the working directory in the container
WORKDIR /app

# Copy package.json and package-lock.json to leverage Docker cache
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application files
COPY . .

# Expose the port the app runs on
EXPOSE 10000

# Command to run the application
CMD ["npm", "start"]
