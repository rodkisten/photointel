# Apple Sync

> **Nota de revisão arquitetural (04/11/2026):** O fluxo de Apple Sync está no backend e no Bridge opcional. O servidor não possui PhotoKit e um job `apple_sync` aguardando dispositivo não comprova escrita de keywords no iCloud. Confira [a referência de código e fluxos](../../docs/architecture/FRONTENDS_AND_BRIDGE.md).

Protocolo e reconciliação: `photointel.services.apple_sync` e
`photointel.services.identity`. O worker retém operações para o dispositivo e
nunca tenta executar PhotoKit no servidor. Mapeamentos ambíguos não autorizam
escrita. Execute a ponte Pyto manualmente; o backend continua independentemente.
