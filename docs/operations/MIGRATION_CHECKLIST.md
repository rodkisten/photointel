# Checklist de migração

- [ ] Gate0: código, migrations e testes locais da mesma release.
- [ ] Backup banco e conteúdo privado, restauração verificada.
- [ ] Neon direto/pool TLS e capacidade dimensionada.
- [ ] Autorização explícita de projeto/cobrança antes de gcp-bootstrap.
- [ ] Secret Manager configurado sem chaves JSON de service account.
- [ ] Migrar por Job único, API sem DDL no startup.
- [ ] API/Jobs/Scheduler e autenticação run.app testados.
- [ ] Sessão iCloud autenticada interativamente e snapshot criptografado.
- [ ] Gates10/100/GPU/Safari/recuperação aprovados com evidência.
- [ ] 1000 imagens e capacidade/custos medidos.
- [ ] Backfill completo autorizado separadamente.

Não destruir VPS/Compose ou banco anterior durante a migração.
