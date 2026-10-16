# Validação das arquiteturas dos containers

O workflow [Validate container architectures](../../.github/workflows/container-architectures.yml)
constrói e executa as imagens `api`, `web` e `minio` separadamente em
`linux/amd64` e `linux/arm64`. É uma validação explícita: só inicia manualmente
em **Actions → Validate container architectures → Run workflow**, ou ao enviar
um commit para a branch `validation/container-architectures`. Não inicia em
push para `main`, não publica imagens e não implanta serviços.

Cada combinação recebe um runner isolado, limite de 50 minutos e cache BuildKit
específico por componente/arquitetura. No máximo três combinações executam em
paralelo. O build usa os Dockerfiles reais e os locks do repositório. O MinIO
usa `GOOS`/`GOARCH` no estágio de compilação nativo, sem executar o compilador
Go em QEMU; a imagem resultante é executada para conferir o binário.

## Evidência produzida

- A inspeção local exige a arquitetura pedida e registra commit e ID da imagem.
- API: executa Python, importa `cv2`, `pillow_heif` e `psycopg`, registra o
  plugin HEIF e calcula conversão de cor e variância do Laplaciano de uma
  imagem sintética. Não conecta ao PostgreSQL nem chama iCloud/Modal.
- Web: inicia o Nginx real, verifica `/health/web` e baixa o `index.html` gerado
  pelo build Vite. A resolução local de `api` permite validar esse container
  isoladamente; nenhum proxy da API ou autenticação externa é exercitado.
- MinIO: executa `--version` da compilação fixada, sem criar bucket ou iniciar
  armazenamento persistente. Integração S3 completa pertence à suíte dedicada.

Os seis artifacts `container-{componente}-{arquitetura}` contêm metadados da
imagem e a saída dos testes executados. A existência do workflow ou de um
artifact de build não comprova sucesso: confira a conclusão de cada job e a
presença da evidência de execução.

O [run 38832588645](https://github.com/rodkisten/photointel/actions/runs/38832588645)
passou nas seis combinações. Os seis ZIPs foram baixados e seus hashes conferidos
com os artifacts do GitHub; o [relatório permanente](../evidence/container-architectures.json)
preserva plataformas, digests, versões e evidência de execução.

## Limites e implantação Oracle

ARM64 executa com QEMU user-mode sobre runner AMD64. Isso verifica resolução de
dependências e extensões nativas, mas não substitui testes num host Oracle ARM
real, capacidade da VM, desempenho, disco, rede, permissões de volumes ou a
subida do Compose completo. Binários de terceiros são verificados na arquitetura
solicitada durante o build; disponibilidade futura de imagens e wheels pode
mudar.

Os containers de PostgreSQL/pgvector e Cloudflare Tunnel são imagens externas e
não são reconstruídos por este workflow. Antes de instalar, confira no registry
se a tag/digest escolhida inclui `linux/arm64`, fixe o digest aprovado e execute
as verificações do [runbook Oracle](oracle-arm.md) no destino.

Não são instalados pesos ou dependências GPU nesse teste. O serviço Modal usa
seu ambiente GPU próprio; compatibilidade ARM dos containers de API não implica
compatibilidade de CUDA ou inferência no Oracle. Não há credenciais de produção,
consumo de GPU ou imagens privadas nos testes. O GitHub Actions pode consumir
minutos da conta; isso depende do plano e das cotas vigentes do provedor.
