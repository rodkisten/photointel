FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY render.py /app/render.py
USER 65534:65534
ENTRYPOINT ["python", "/app/render.py"]
