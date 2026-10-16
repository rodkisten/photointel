# API HTTP

O contrato executável é o OpenAPI da aplicação e a cópia gerada em
`packages/contracts/openapi.json`. As rotas de produto ficam sob `/v1`; tipos
do frontend são derivados desse contrato. Consulte `/docs` somente após passar
pelo acesso privado configurado. Este documento descreve as convenções, não
substitui o schema de cada endpoint.

## Autenticação

Em desenvolvimento a identidade local é aceita apenas na instalação privada
de loopback. Em produção `AUTH_MODE=cloudflare`: a API verifica assinatura do
JWT com JWKS do team domain, `iss`, `aud`, validade e email allowlist. Tokens
ausentes/inválidos são rejeitados. `Cf-Access-Authenticated-User-Email` sozinho
não autentica uma chamada. O navegador usa cookies/credentials e HTTPS; tokens
R2, Modal, sessões iCloud e chaves Cloudflare não são enviados ao frontend.

Dispositivos bridge recebem credenciais próprias, com hash/pepper no banco,
revogação e capacidades declaradas. Aprovar uma operação não permite escrever
num dispositivo sem mapeamento verificado e capacidade real.

## Convenções

- Listagens retornam `{"items": [...], "next_cursor": null}`; o cursor é opaco.
- IDs são UUID; datas usam ISO 8601 UTC.
- Capacidades usam `{"state": "...", "reason": "..."}`. Integrações desativadas
  ou não verificadas devolvem o motivo, sem resultados inventados.
- Filtros e limites são validados; não se aceita chave de objeto arbitrária
  para expor qualquer arquivo do bucket.
- Respostas de jobs indicam estado persistido. Aceitar um job não prova conclusão.
- Downloads autorizados expiram rapidamente. Não registre a URL assinada em
  logs nem a preserve no cache offline da PWA.

## Áreas do contrato

| Área | Operações |
|---|---|
| Catálogo | Paginação, filtros, detalhe, recursos e proveniência |
| Busca | Texto, tags, filtros compostos e vetor compatível quando disponível |
| Tags | Vocabulário/alias, aceitar/rejeitar sugestões, ajustes manuais |
| Álbuns e duplicatas | Organização do catálogo e revisão sem deleção remota |
| Jobs | Lote, progresso, erro, pausa/retry/cancelamento conforme schema |
| Ingestão | Execução limitada, status, resumo e capacidades iCloud |
| Modelos/configuração | Revisões exatas, disponibilidade e parâmetros públicos |
| Bridge Apple | Enrollment, snapshots, mapeamento, aprovação, claim e confirmação |
| Diagnóstico | Liveness/readiness e saúde das dependências |

## Rotas principais

| Método e caminho | Uso |
|---|---|
| `GET /v1/assets?limit=60&sort=captured_desc` | Galeria com cursor, biblioteca/álbum/tipo opcionais |
| `GET /v1/assets/{id}` | Detalhe, metadados, tags e recursos autorizados |
| `GET /v1/assets/{id}/media/thumbnail_medium` | Proxy autenticado do derivado, `private, no-store` |
| `POST /v1/search` | AST de filtros e texto; resposta inclui explicação |
| `POST /v1/search/similar` | Similaridade por asset e embedding compatível |
| `PATCH /v1/assets/{id}/tags` | Adicionar/aceitar/rejeitar tags com proveniência |
| `GET/POST /v1/tags` | Vocabulário canônico e aliases em rotas próprias |
| `GET/POST /v1/albums` | Álbuns; inclusão/remoção afeta somente associação |
| `GET /v1/duplicates` | Grupos detectados; nenhuma exclusão de foto |
| `GET /v1/jobs`, `GET /v1/jobs/events` | Estado e stream de eventos persistidos |
| `POST /v1/jobs/reindex` | Agenda tipos de job e limite explícitos |
| `POST /v1/jobs/{id}/retry`, `/cancel` | Retry/cancelamento por estado persistido |
| `GET /v1/ingestion/status`, `/health`, `/runs` | Configuração observada, capacidades e histórico |
| `POST /v1/ingestion/start` | Inicia lote limitado; expansão requer confirmação |
| `GET/PATCH /v1/settings` | Parâmetros públicos; nunca retorna segredos |
| `GET /v1/system/capabilities`, `/diagnostics` | Capacidades reais e diagnóstico sem tokens |
| `GET /v1/system/export` | Exportação de metadados, sem embedding volumoso |

Exemplo de filtro composto, sem executar inferência:

```json
{
  "filter": {
    "op": "and",
    "children": [
      {"op": "tag", "value": "landscape", "origin": "joytag", "confidence": 0.6},
      {"op": "number", "key": "width", "comparison": "gte", "value": 1600}
    ]
  },
  "sort": "captured_desc",
  "limit": 60
}
```

O schema limita árvore, profundidade, strings e página. Use `next_cursor` sem
alterá-lo para a próxima página com os mesmos filtros. Não envie SQL ou nome
de coluna livre no filtro.

Exemplo local de inspeção, sem credenciais pessoais:

```bash
curl --fail http://localhost:8000/health/live
curl --fail http://localhost:8000/openapi.json -o /tmp/photointel-openapi.json
```

Liveness confirma o processo. Readiness e `make doctor` verificam dependências
e configuração; nenhum healthcheck confirma escrita PhotoKit, autenticação
iCloud funcional ou inferência GPU sem exercício real da integração.
