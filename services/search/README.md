# Search

> **Nota de revisão arquitetural (04/11/2026):** A busca é implementada em `apps/api/src/photointel/services/search.py` e router do catálogo; PostgreSQL/pgvector e cache de embeddings são dependências, não um microserviço de busca implantado isoladamente. Confira [a referência de código e fluxos](../../docs/architecture/DATA_AND_INFERENCE.md).

O compilador de AST, paginação por cursor e ranking estão em
`photointel.services.search`. Consultas vetoriais ficam no PostgreSQL/pgvector;
nenhum loop Python carrega todos os embeddings.
