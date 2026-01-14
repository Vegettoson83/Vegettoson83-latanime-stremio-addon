# Latanime Stremio Addon

This is a Stremio addon that provides streams from latanime.org.

## Deployment

This addon is designed to be deployed as a single Docker container, suitable for platforms like Render that expose a single port. The application runs two processes internally (the addon and the scraping bridge) using `pm2`.

1.  Clone this repository.
2.  Build the Docker image:
    ```
    docker build -t latanime-addon .
    ```
3.  Run the container, exposing the addon's port:
    ```
    docker run -p 10000:10000 latanime-addon
    ```

## Configuration

This addon requires a ScrapingBee API key to function.

1.  Create a `.env` file in the root of the project by copying the example file:
    ```
    cp .env.example .env
    ```
2.  Open the `.env` file and add your ScrapingBee API key:
    ```
    SB_API_KEY=YOUR_SCRAPINGBEE_API_KEY
    ```

## Local Development

For local development, you can run the services directly:
```
# Terminal 1: Start the addon
npm run start:addon

# Terminal 2: Start the bridge
npm run start:bridge
```
