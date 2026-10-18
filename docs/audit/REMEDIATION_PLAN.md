# Plano de remediação v1.1

Base local: `06b11148b42b0236806b0d2cb1a430e16e98ac33`, branch `main`.
Checkpoint publicado informado: `d8316d79f9e88f16ec1217074eadd708ef3e6bc8`.
Não foi encontrado PHOTO_INTELLIGENCE_AUDITORIA_2026-10-17.md no checkout;
os achados fornecidos pelo operador são reproduzidos contra o código atual.

## Ordem de execução

1. Limites autorizados, manifesto durável e downloads independentes.
2. Transações curtas, fencing, outbox, recuperação e cache íntegro.
3. Cloud Run Service/Jobs finitos, Scheduler, IAM e Secret Manager.
4. Neon/TLS/pooling, cache semântico e benchmark descartável.
5. Sessões criptografadas, backup completo e restauração.
6. Auth na origem, mídia streaming, gates e onboarding.
7. Bridge por capacidade, testes físicos documentados e release auditável.

## Invariantes

Sem novos recursos pagos, ingestão real ou GPU sem autorização específica.
Sem exclusão/edição automática Apple, sem reinicializar banco, sem substituir
schema/galeria/modelos existentes. Compose/VPS continuam disponíveis.
Toda alegação de teste indica SHA, ambiente e evidência da mesma release.

## Dependências

Schema/config → descoberta/jobs → Cloud Run; schema/pooling → cache e benchmark;
R2+leases → sessões e backup; auth+API real → PWA/gates; integração local →
validação real com contas/hardware. As equipes editam módulos separados.
