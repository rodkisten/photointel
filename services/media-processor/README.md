# Processamento de mídia privada

> **Nota de revisão arquitetural (04/11/2026):** O processador executável está em `apps/api/src/photointel/services/media.py` e gera variantes/qualidade, com storage privado. Este README é um contrato/visão de módulo, não um deploy autônomo. Confira [a referência de código e fluxos](../../docs/architecture/DATA_AND_INFERENCE.md).

Implementação: `photointel.services.media`. Pillow + pillow-heif leem HEIC/HEIF,
JPEG, PNG, WebP e TIFF conforme codecs instalados. RAW sem representação derivada
não é falsamente declarado decodificável. Vídeos são entradas do catálogo.

As imagens são normalizadas pela orientação EXIF; os arquivos derivados não
contêm EXIF/GPS. GPS autorizado e campos de câmera ficam só no banco protegido.
`thumbnail_small`, `thumbnail_medium`, `preview_large` e `inference_input` usam
WebP ou fallback JPEG, preservam proporção e usam chaves UUID/revisão/variante.
SHA-256 refere-se à representação baixada; pHash fornece sugestões visuais e não
identidade. Laplaciano, histograma, contraste e resolução são métricas técnicas,
explicitamente apresentadas como heurísticas sem julgamento artístico.
