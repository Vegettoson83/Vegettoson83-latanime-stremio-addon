# Latanime Stremio Addon

This is a Stremio addon that provides streams from latanime.org.

## Installation

1.  Clone this repository.
2.  Install the Node.js dependencies:
    ```sh
    npm install
    ```
3.  Install the Playwright browsers and their system dependencies:
    ```sh
    npx playwright install --with-deps
    ```

## Setup

Before running the addon, you need to create a `.env` file in the root of the project to store your API key and configure the server ports.

1.  Create a file named `.env`.
2.  Add the following content to the file, replacing the placeholder with your actual ScrapingBee API key:

    ```env
    # Stremio Addon Configuration
    # Replace with your actual ScrapingBee API key
    SCRAPINGBEE_API_KEY="YOUR_SCRAPINGBEE_API_KEY"

    # Server ports (optional, defaults to 7000 and 3001)
    PORT=7000
    BRIDGE_PORT=3001
    ```

## Running the Addon

Run the addon with the following command:
```sh
npm start
```

Both the main addon server and the bridge server will start concurrently.
