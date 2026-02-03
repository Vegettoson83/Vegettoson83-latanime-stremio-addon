# Latanime Stremio Addon

This is a Stremio addon that provides streams from latanime.org.

## Deployment

This addon is designed to be deployed as a single Docker container, suitable for platforms like Render that expose a single port.

1.  Clone this repository.
2.  Build the Docker image:
    ```
    docker build -t latanime-addon .
    ```
3.  Run the container, exposing the addon's port:
    ```
    docker run -p 10000:10000 latanime-addon
    ```

## Local Development

For local development, you can run the service directly:
```
npm start
```
