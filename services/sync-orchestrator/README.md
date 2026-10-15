# Apple Sync

Protocolo e reconciliação: `photointel.services.apple_sync` e
`photointel.services.identity`. O worker retém operações para o dispositivo e
nunca tenta executar PhotoKit no servidor. Mapeamentos ambíguos não autorizam
escrita. Execute a ponte Pyto manualmente; o backend continua independentemente.
