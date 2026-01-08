# Latanime Stremio Addon

This is a Stremio addon that provides streams from latanime.org.

## Configuration

Before running the addon, you need to set up your environment variables.

1.  Create a `.env` file by copying the example file:
    ```
    cp .env.example .env
    ```
2.  Open the `.env` file and add your ScrapingBee API key:
    ```
    SB_API_KEY=YOUR_API_KEY_HERE
    ```
    You can get a free API key from [ScrapingBee](https://www.scrapingbee.com/). The addon will not work without it.

## Installation and Running

1.  Clone this repository.
2.  Install the dependencies. This will also download the necessary Playwright browser binaries.
    ```
    npm install
    ```
3.  Run the addon:
    ```
    npm start
    ```
The addon server will be running on port 10000, and the bridge server will be on port 3001.
