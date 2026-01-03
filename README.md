# Latanime Stremio Addon

This is a Stremio addon that provides streams from latanime.org. It uses a dual-scraping approach:
- **ScrapingBee** is used to access the main `latanime.org` site.
- A **local Playwright bridge** is used to extract video URLs from embedded third-party players.

## Installation

1.  **Clone this repository.**

2.  **Install Node.js dependencies:**
    ```
    npm install
    ```

3.  **Install Playwright Browsers & Dependencies:**
    This is a critical step. The addon's bridge server uses Playwright to extract video streams, which requires a full browser environment.
    ```
    npx playwright install --with-deps
    ```
    This command will download the necessary browser executables and install the required system-level libraries.

## Running the Addon

This addon requires two separate processes to be running simultaneously:

1.  **Start the Bridge Server:**
    This server handles the Playwright-based extraction. Open a terminal and run:
    ```
    node bridge-server.js
    ```

2.  **Start the Main Addon Server:**
    In a separate terminal, run:
    ```
    npm start
    ```

Both servers need to be running for the addon to be fully functional.

## Deployment (e.g., on Render)

When deploying to a service like Render, you must ensure the Playwright dependencies are installed during the build process.

-   **Build Command:** Set your build command to:
    ```
    npm install && npx playwright install --with-deps
    ```
-   **Start Command:** You will need a startup script that can run both servers. A simple way is to modify your `package.json` `start` script to use a package like `npm-run-all` or simply chain the commands:
    ```
    node bridge-server.js & node server.js
    ```