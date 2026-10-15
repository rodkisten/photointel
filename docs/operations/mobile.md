# Operação somente com iPhone

O iPhone usa a PWA pelo Safari e um terminal SSH para comandos de manutenção.
O processamento permanece no servidor/Codespaces. Pyto é uma ponte opcional
para PhotoKit, não requisito do catálogo cloud.

## Codespaces

Abra o repositório no GitHub Codespaces pelo navegador e use o devcontainer.
O post-create executa `make setup`; depois rode `make dev`, `make seed` e
`make doctor`. Mantenha encaminhamentos de portas privados. Codespaces é um
ambiente de desenvolvimento temporário, não hospedagem de produção/biblioteca.
Sessões iCloud não devem ser compartilhadas em um Codespace público.

## SSH e 2FA

Configure cliente SSH com chave, valide fingerprint por canal conhecido e
conecte ao host. Para login iCloud use o terminal interativo descrito em
[ICLOUD_SETUP.md](../../ICLOUD_SETUP.md). O código 2FA é digitado diretamente
no prompt; não pode ser transmitido por uma interface web do projeto ou logs.
Editores como `nano .env` não exigem mostrar o arquivo na conversa.

Para acompanhar fila, custo estimado, erros e sync, use a PWA. Para diagnosticar
serviços, execute os comandos de [OPERATIONS.md](../../OPERATIONS.md). Registrar
e revisar uma operação no cloud não comprova aplicação em PhotoKit. Primeiro
teste uma mídia controlada sem valor pessoal e confirme capacidades no iPhone.
