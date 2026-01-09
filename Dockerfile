# Use an official Playwright image that comes with browsers and dependencies
FROM mcr.microsoft.com/playwright:v1.44.0-jammy

# Set the working directory in the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json to leverage Docker cache
COPY package*.json ./

# Install application dependencies
RUN npm install

# Copy the rest of the application source code
COPY . .

# Expose the port the addon runs on
EXPOSE 10000

# Command to run the application
CMD ["npm", "start"]
