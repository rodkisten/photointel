"""Cloud Run HTTP entrypoint: no scheduler/worker and no trusted proxy headers."""

import os


def main() -> None:
    port = int(os.environ.get("PORT", "8080"))
    if not 1 <= port <= 65535:
        raise SystemExit("PORT must be between 1 and 65535")
    os.execvp(
        "uvicorn",
        [
            "uvicorn",
            "photointel.main:app",
            "--host",
            "0.0.0.0",
            "--port",
            str(port),
            "--no-proxy-headers",
        ],
    )


if __name__ == "__main__":
    main()
