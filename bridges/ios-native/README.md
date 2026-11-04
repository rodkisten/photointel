# Adaptador Swift futuro

> **Nota de revisão arquitetural (04/11/2026):** Esta pasta não comprova um aplicativo nativo iOS compilado e instalado. O caminho de Bridge verificado no repositório é opcional e usa Pyto/PhotoKit read-only e protocolo de aprovação no backend. Confira [a referência de código e fluxos](../../docs/architecture/FRONTENDS_AND_BRIDGE.md).

O núcleo v1 não precisa de Xcode, macOS ou de um aplicativo Swift. O adaptador
executável em `bridges/pyto/bridge.py` oferece inventário PhotoKit e protocolo
seguro. Escrita Beta exige verificar SDK, sistema operacional, entitlement e
disponibilidade real das APIs em um dispositivo, além de leitura antes/depois,
permissão explícita e teste individual aprovado. Nenhum seletor de escrita
experimental está emulado neste diretório.
