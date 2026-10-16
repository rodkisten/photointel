# Search

O compilador de AST, paginação por cursor e ranking estão em
`photointel.services.search`. Consultas vetoriais ficam no PostgreSQL/pgvector;
nenhum loop Python carrega todos os embeddings.
