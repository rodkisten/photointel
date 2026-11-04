# Atualização segura do runtime de inferência v1.1

> **Nota de revisão arquitetural (04/11/2026):** O app Modal fixa versões de imagem **separadamente** do grupo Python `gpu`; alterações de Transformers/PyTorch exigem validação de contrato, revisões, dimensão 768 e custo GPU real. Consulte [a referência técnica](../architecture/DATA_AND_INFERENCE.md).

O scan adicional de dependências encontrou advisories no Transformers 4.57.6.
Esta release fixa **Transformers 5.10.2**, Hugging Face Hub 1.33.0 e mantém os
commits imutáveis dos checkpoints JoyTag/SigLIP 2. A versão 5.10.0 não foi usada:
foi retirada pelo próprio mantenedor. O adapter usa `pooler_output` dos resultados
SigLIP da série 5, preserva normalização dos vetores e valida as 768 dimensões.

`siglip2-transformers-5.10.2-v2` identifica o novo preprocessing. A migração
`0007_model_preprocessing` adiciona esse namespace ao registro de modelos;
registros anteriores recebem `legacy-v1`. O SHA do checkpoint permanece em
`revision`, enquanto o namespace distingue IDs de modelo, embeddings e cache de
queries. Resultados anteriores continuam preservados. Uma query nova não usa
vetores antigos por mera igualdade do SHA do checkpoint. A indisponibilidade
semântica mantém filtros exatos disponíveis até reindexação explícita.

## Ordem de atualização

1. Crie e verifique backup criptografado do banco e dos objetos. Preserve a imagem
   anterior e o manifesto da release; não execute importação ou inferência nova.
2. Pause os Scheduler triggers e o processamento. Aguarde execuções de Jobs
   existentes terminarem ou cancele-as com recuperação de leases. Na instalação
   VPS, pare os workers/ingestão antes da manutenção. Impeça escritas pelo API
   durante a troca.
3. Aplique o schema com o job de migração serializado ou, em desenvolvimento,
   `uv run --frozen alembic -c infra/migrations/alembic.ini upgrade head`.
4. Atualize API, workers/Jobs e Modal com a mesma release. Configure
   `QUERY_PREPROCESSING_REVISION=siglip2-transformers-5.10.2-v2`. O protocolo
   inclui esse campo e recusa um serviço Modal com preprocessing diferente.
   O serviço novo também recusa um cliente antigo que omita o namespace.
5. Execute o smoke CPU local; depois o smoke real Modal autorizado de uma única
   imagem. O teste CPU não valida CUDA, implantação nem custo do provedor.
6. Reative uma execução limitada e explicitamente autorizada de reindexação.
   Confirme os IDs de modelo/namespace dos vetores persistidos antes de expandir.
   Reative Scheduler somente após os gates necessários.

Não é uma migração rolling compatível com workers v1: o conflito de unicidade
passa de três para quatro campos e os workers antigos não devem continuar após
0007. Não se promete indisponibilidade zero durante essa manutenção.

## Rollback

O downgrade verifica colisões entre namespaces antes de qualquer DDL. Se vários
registros compartilham provider/model/checkpoint ou existem múltiplos modelos
ativos do mesmo nome, o downgrade **recusa**; não mescla nem apaga embeddings.
Voltar à aplicação antiga após novos resultados exige restauração do backup
pré-migração em destino separado e corte controlado, ou uma migração revisada
pelo operador. A reversão de imagem sozinha não resolve essa incompatibilidade.

## Verificações reproduzíveis

```bash
uv run --frozen pytest -q tests/integration/test_inference_namespace_v11.py
uv run --frozen pytest -q tests/test_gpu_service.py tests/test_inference_contract.py
uv export --frozen --no-dev --group gpu --no-emit-project > var/gpu-requirements.txt
uvx pip-audit -r var/gpu-requirements.txt --disable-pip
```

Os testes de integração usam PostgreSQL local com migrações aplicadas; nenhum
recibo sintético é prova de execução GPU. O relatório de segurança distingue
auditoria do lockfile da verificação da imagem efetivamente implantada.
