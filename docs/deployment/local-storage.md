# Armazenamento S3 local

> **Nota de revisão arquitetural (04/11/2026):** O modo local e MinIO/volumes Compose são alternativas de desenvolvimento. Em Cloud Run, `/tmp` é efêmero; fonte retida e derivados duráveis pertencem ao R2 privado e ao catálogo PostgreSQL. Veja [arquitetura e evidências](../architecture/DATA_AND_INFERENCE.md).

Produção usa R2 privado; o ambiente local e os testes de integração usam o
servidor MinIO real. Imagens publicadas em registros do fornecedor podem ficar
indisponíveis. Para tornar a instalação reproduzível, o projeto compila a fonte
oficial em `infra/docker/minio.Dockerfile` e não depende dessas imagens.

A versão selecionada é `RELEASE.2025-09-07T16-13-09Z`, commit
`07c3a429bfed433e49018cb0f78a52145d4bedeb`. O tag assinado aponta para esse
commit; a verificação do GitHub foi consultada em 15/10/2026. O build verifica
o SHA obtido antes de compilar. O `go.mod` desse commit exige Go 1.24.0. Os
módulos transitivos são validados pelo `go.sum` upstream. A fonte não foi alterada;
somente o empacotamento e os metadados de build são próprios.

MinIO é distribuído sob AGPL-3.0-or-later. A licença está no container em
`/licenses/minio-LICENSE`; a fonte correspondente está no commit upstream
citado. Respeite os termos da licença ao redistribuir a imagem ou modificar o
servidor. MinIO não é incorporado à API do aplicativo.

## Construção e início

`make dev` compila API, web e MinIO. A primeira compilação pode demorar vários
minutos e precisa de acesso HTTPS a GitHub, módulos Go e imagens base. O build
limita a compilação Go a duas tarefas paralelas e usa caches BuildKit. No CI,
as camadas da imagem são reutilizadas pelo cache autenticado do GitHub Actions;
uma mudança comum na API/web não exige recompilar a fonte MinIO inalterada. Reserve
RAM e disco para compilar; esse custo não equivale ao consumo do servidor em
execução. Uma máquina pequena pode compilar a imagem previamente em um runner
compatível e carregá-la no host. O Dockerfile suporta compilação cruzada de
Linux AMD64/ARM64, sem depender de GPU.

O container roda como UID/GID 10001. O serviço Compose `permissions` prepara os
diretórios raiz dos volumes com esse dono e modo 0700 antes do início. Isso
não altera recursivamente uma biblioteca existente. Se um volume MinIO de uma
instalação anterior contém arquivos de outro UID, faça backup e ajuste somente
o volume de desenvolvimento apropriado durante uma manutenção; não aplique
`chown` recursivo sobre bibliotecas pessoais ou o volume PostgreSQL.

As portas 9000 e 9001 escutam apenas em `127.0.0.1`. O healthcheck consulta
`/minio/health/ready` com o `wget` do Alpine. O container de inicialização usa
o cliente Boto3 já instalado na API: espera pelo servidor, cria o bucket se
necessário e remove qualquer policy pública. Não depende de uma imagem `mc`.
Não publica ACLs, não remove objetos e não executa jobs GPU.

## Diagnóstico

```bash
bash infra/scripts/compose.sh logs --tail=100 minio bucket permissions
bash infra/scripts/compose.sh ps
```

Uma falha de build não significa autenticação iCloud inválida. Verifique o
acesso aos registros, módulos Go, espaço e memória. Nunca desative validação
TLS para contornar erro de rede. No ambiente gerenciado, forneça a CA do proxy
pelo secret BuildKit `build_ca`, conforme o runbook Oracle.

Os testes reais de objeto privado dependem da execução de integração com esse
servidor. A presença do Dockerfile não comprova que a imagem foi construída
ou que o teste de armazenamento passou; confira os resultados do CI.
