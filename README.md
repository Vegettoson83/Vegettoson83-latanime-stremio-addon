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

## Deployment and Low-Memory Environments

### Build Command
When deploying to a service like Render, you must ensure the Playwright dependencies are installed during the build process.

-   **Build Command:** Set your build command to:
    ```
    npm install && npx playwright install --with-deps
    ```

### Start Command
You will need a startup script that can run both servers.
-   **Start Command:**
    ```
    node bridge-server.js & node server.js
    ```

### Memory Considerations
The Playwright bridge server launches a full headless browser, which can be memory-intensive. The free tier on services like Render provides limited RAM (e.g., 512 MB), which can be a challenge.

To mitigate this, the bridge server has been pre-configured with the following Chromium launch arguments to reduce its memory footprint:
- `--disable-dev-shm-usage`
- `--disable-gpu`
- `--no-zygote`
- `--single-process`

While these optimizations improve the chances of running on a low-memory instance, the most reliable solution for long-term stability is to use a hosting plan with sufficient resources (e.g., 1 GB+ of RAM).
