# Bridge PhotoKit no iPhone

O Bridge é opcional para ingestão, galeria e inferência. O backend continua
funcionando quando o iPhone está bloqueado. O módulo executável é
`bridges/pyto/bridge.py`; ele também pode ser importado em um script Pyto.
As respostas no console são JSON e não contêm a credencial do dispositivo.

## Estado real desta implementação

O adaptador usa APIs públicas estáveis para ler autorização, identificadores
locais, data, dimensões, tipo de mídia e nome de recurso. A execução PhotoKit
exige Pyto com Rubicon e acesso autorizado às Fotos. A biblioteca do Python
é suficiente para HTTP/JSON. Nenhum pacote de nuvem precisa ser instalado no
iPhone. Não são enviados os arquivos originais.

Este ambiente de desenvolvimento Linux não valida hardware Apple. O código
reporta `unavailable` em Linux e `read_only` quando as leituras PhotoKit estão
disponíveis. Leitura e escrita de keywords Beta **não foram verificadas em
Pyto**; `keywords_read=false` e `keywords_write=false`. O adaptador isolado
`UnavailableKeywordWriter` retorna `PHOTOKIT_WRITE_UNAVAILABLE`, nunca sucesso.

As APIs relacionadas incluem `PHPhotoLibrary`, `PHAsset`, `PHAssetResource`,
`PHCloudIdentifier`, `PHAssetExtendedMetadata` e `PHAssetChangeRequest`. A presença
de uma classe no SDK mais recente não comprova disponibilidade no sistema,
no binário do Pyto ou na ponte Objective-C. `addKeyword`, `removeKeyword` e
`caption` exigem verificação específica no SDK/runtime antes de qualquer uso.
Não há chamada de seletor experimental por adivinhação neste adaptador.

Referências oficiais para validar em um dispositivo:

- https://developer.apple.com/documentation/photos/phphotolibrary
- https://developer.apple.com/documentation/photos/phasset
- https://developer.apple.com/documentation/photos/phassetresource
- https://developer.apple.com/documentation/photos/phcloudidentifier
- https://developer.apple.com/documentation/photos/phassetextendedmetadata
- https://developer.apple.com/documentation/photos/phassetchangerequest
- https://pyto.readthedocs.io/
- https://rubicon-objc.readthedocs.io/en/stable/reference/blocks.html

## Instalação usando somente o iPhone

1. No GitHub/Codespaces, copie `bridges/pyto/bridge.py` para Arquivos > Pyto.
2. Abra o script no Pyto. Use Python 3.10 ou superior e a versão com Rubicon.
3. Configure uma origem HTTPS do backend. Certificados TLS são verificados;
   URLs HTTP e redirecionamentos são recusados.
4. Execute `doctor`. Se necessário, execute `doctor --request-permission` e
   responda ao diálogo Fotos. Alternativamente, ajuste Fotos em Ajustes > Pyto.
   Acesso limitado é reportado; não representa inventário da biblioteca inteira.
5. No aplicativo web autenticado, gere um código de matrícula usando
   `POST /v1/apple-sync/enrollment`. O código é de uso único e expira em dez minutos.
6. Execute `enroll --url https://photos.exemplo.com --code CODIGO --name "Meu iPhone"`.
   Cole o código temporário em uma sessão privada do Pyto; não o publique no GitHub.
7. Execute `inventory --limit 50 --batches 1`. Repita para continuar o inventário.
8. Na interface Apple Bridge, confirme manualmente as correspondências sugeridas.

O CLI tem estes comandos:

```text
python bridge.py doctor
python bridge.py doctor --request-permission
python bridge.py capabilities
python bridge.py enroll --url https://photos.exemplo.com --code CODIGO
python bridge.py inventory --limit 50 --batches 4
python bridge.py status
python bridge.py preview
python bridge.py sync
```

`--config` é uma opção global e deve vir antes do comando:

```text
python bridge.py --config /caminho/photointel-bridge.json status
```

O arquivo local contém URL, UUID do dispositivo e checkpoint; não contém o
token. A credencial é armazenada no módulo Keychain do Pyto, com o serviço
`photo-intelligence-cloud.bridge`. Caso `get_password`/`set_password` não estejam
disponíveis, a execução falha com `KEYCHAIN_UNAVAILABLE`; não há fallback para
texto puro. Use uma distribuição Pyto compatível antes de matricular o aparelho.

Se Cloudflare Access estiver na frente de toda a origem, a matrícula e os
endpoints `/v1/bridge/*` precisam de uma política apropriada para clientes
dispositivo. Uma exceção Access restrita a esses caminhos é possível porque
esses endpoints validam o token Bridge próprio; nunca abra `/v1/apple-sync/*`
ou o restante da API. Não inclua o token Bridge em uma query string. Confirme
no Tunnel que a origem continua inacessível fora da rota Cloudflare.

## Identidade e retomada

`localIdentifier` pertence a um dispositivo e não é equiparado ao identificador
do icloudpd. `cloud_identifier` permanece ausente quando sua obtenção não foi
verificada. Nome/data/dimensões geram candidatos, jamais uma autorização de
escrita. Hash exato também não mescla automaticamente duas fotos distintas.

Cada chamada envia no máximo cem entradas. O checkpoint só avança depois de
confirmação persistida do servidor. Se o número de fotos ou a posição do último
identificador mudar, começa uma varredura idempotente para não pular itens.
O inventário não lê o conteúdo das imagens nem depende de executar para sempre.

## Segurança de keywords

Por padrão `sync` e `preview` executam em modo de leitura. Quando o adaptador
não dispõe de keywords, as operações permanecem no backend e a resposta explica
`PHOTOKIT_WRITE_UNAVAILABLE`. Nenhuma operação é adquirida por esse adaptador.

O protocolo de escrita no backend está implementado e testável sem hardware:

1. Uma fotografia específica deve ter correspondência única, confirmada.
2. Um snapshot com keywords legíveis fornece a revisão esperada.
3. `POST /v1/apple-sync/preview` apresenta existentes, adições e remoções.
4. `POST /v1/apple-sync/operations` persiste a proposta com idempotência.
   O padrão é `awaiting_approval`; aprovação explícita muda para `pending`.
5. Um adaptador com capability real de escrita adquire uma operação com lease.
6. Antes da escrita, lê novamente as keywords e compara a revisão aprovada.
7. Aplica somente o delta aprovado em uma alteração PhotoKit com escopo definido.
8. Lê novamente, valida o resultado e envia o recibo com o token do lease.
9. O servidor valida ambas as leituras, registra auditoria e mantém o estado
   `awaiting_cloud_confirmation`: leitura local não comprova propagação iCloud.

O primeiro teste deve usar `single_asset_test=true`, uma alteração real e
uma única foto escolhida explicitamente. Nenhuma segunda tentativa em outra
foto é liberada antes de concluir e confirmar o teste. Depois do teste, o
operador confirma `POST /v1/apple-sync/operations/{id}/verify-single-write`.
`APPLE_BULK_WRITE_ENABLED` permanece falso por padrão, mesmo após a validação.
Não existe implementação de remoção de fotos.

Keywords preexistentes não são assumidas como gerenciadas. A aplicação só
remove keywords que seus recibos comprovam ter adicionado e cuja remoção foi
aprovada explicitamente. Mudanças concorrentes produzem `SYNC_CONFLICT`; um
merge de três vias pode gerar uma nova prévia preservando palavras externas,
mas não reaproveita a aprovação da revisão antiga.

## Atalhos

Crie um Atalho que use a ação do Pyto para executar um script Python e importe
o módulo salvo. Exemplo de script local:

```python
from pathlib import Path
from bridge import Bridge

bridge = Bridge(Path.home() / "Documents" / "photointel-bridge.json")
print(bridge.inventory(limit=50, batches=1))
```

O nome exato da ação depende da versão do Pyto instalada. Não configure uma
promessa de execução em segundo plano: o iOS pode suspender o processo. Execute
manualmente com o aparelho desbloqueado e use lotes curtos. A fila durável no
backend retém o trabalho até o próximo contato.

## Recuperação e rotação

`DEVICE_NOT_ENROLLED` requer conferir a origem e, se necessário, revogar o
dispositivo em `POST /v1/apple-sync/devices/{id}/revoke`, gerar novo código e
repetir `enroll`. Isso rotaciona a credencial sem expor a anterior. Mantenha
`BRIDGE_TOKEN_PEPPER` protegido no servidor; trocá-lo invalida tokens existentes
e exige nova matrícula. Inventários e auditorias permanecem persistidos.

`PHOTOKIT_PERMISSION_DENIED` exige autorização Fotos; `ASSET_MAPPING_AMBIGUOUS`
exige revisão manual; `SYNC_VERIFICATION_FAILED` exige nova leitura e revisão.
O Bridge não solicita senha Apple. O login icloudpd continua exclusivo do terminal
seguro do servidor conforme `ICLOUD_SETUP.md`.
