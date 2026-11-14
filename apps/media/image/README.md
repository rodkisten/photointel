# Image renderer

TypeScript/Node.js Cloud Run Job candidate using sharp/libvips and private R2.
Supports WebP, AVIF, JPEG, PNG, EXIF rotation, fit-inside resize, 25 MiB input
limit and 40-megapixel decoding limit.

```sh
cd services/media/image
npm install
npm test
```

Environment: `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`, `MEDIA_INPUT_KEY` (under `originals/`),
`MEDIA_OUTPUT_KEY` (under `derived/`), `MEDIA_FORMAT`,
`MEDIA_WIDTH`, `MEDIA_HEIGHT`.

This is an independent, offline batch renderer; it is not yet dispatched by
the gateway. No production deployment or billing changes are performed.
