# Latanime Stremio Addon

This is a Stremio addon that provides streams from latanime.org.

## Installation

1.  Clone this repository.
2.  Install the dependencies:
    ```
    npm install
    ```
3.  Run the addon:
    ```
    npm start
    ```

## Security

**Warning:** The `bridge` service provides an unsecured endpoint for web scraping. It is designed for internal communication between the `addon` and `bridge` containers within a Docker network. **Do not expose the bridge service port (default: 3001) to the public internet.** Exposing this service can create a significant security vulnerability.
