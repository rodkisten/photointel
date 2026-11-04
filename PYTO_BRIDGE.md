# Bridge PhotoKit no iPhone

> **Nota de revisão arquitetural (04/11/2026):** O Pyto Bridge é um componente opcional com inventário PhotoKit dependente das permissões do dispositivo. O protocolo de operações aprovado no servidor **não** comprova que exista escritor nativo de keywords funcional no runtime iOS atual. Veja [implementação e fluxogramas](docs/architecture/FRONTENDS_AND_BRIDGE.md).

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
5. Se a origem usa Cloudflare Access, configure o Service Token restrito aos
   caminhos Bridge conforme a seção abaixo. Execute
   `access --url https://photos.exemplo.com`; Client ID e Client Secret são pedidos
   com entrada oculta e gravados somente no Keychain.
6. No aplicativo web autenticado, gere um código de matrícula usando
   `POST /v1/apple-sync/enrollment`. O código é de uso único e expira em dez minutos.
7. Execute `enroll --url https://photos.exemplo.com --code CODIGO --name "Meu iPhone"`.
   Cole o código temporário em uma sessão privada do Pyto; não o publique no GitHub.
8. Execute `inventory --limit 50 --batches 1`. Repita para continuar o inventário.
9. Na interface Apple Bridge, confirme manualmente as correspondências sugeridas.

O CLI tem estes comandos:

```text
python bridge.py doctor
python bridge.py doctor --request-permission
python bridge.py capabilities
python bridge.py access --url https://photos.exemplo.com
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
token. `SecurityKeychain` usa `ctypes` e as APIs C públicas de
`Security.framework`: `SecItemCopyMatching`, `SecItemUpdate` e `SecItemAdd`.
O serviço é `photo-intelligence-cloud.bridge` e a conta é a origem HTTPS.
O atributo `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` permite leitura com o
iPhone desbloqueado e impede migração da credencial para outro aparelho.
Trocar ou restaurar o iPhone exige nova matrícula.

`doctor` faz uma consulta sem gravar credenciais. `credential_storage=query_available`
confirma somente que essa consulta foi aceita pelo runtime; não representa um
cadastro bem-sucedido. `enroll` repete a consulta antes de consumir o código,
grava a credencial recebida e a lê novamente antes de salvar o UUID local.
Se a gravação falhar depois do consumo do código, revogue o dispositivo na web
e gere um código novo. Nenhuma credencial aparece na saída JSON.

Se a biblioteca nativa estiver inacessível ou o sandbox negar acesso, o comando
retorna `KEYCHAIN_UNAVAILABLE` com um `OSStatus` quando disponível. Um Keychain
bloqueado retorna `KEYCHAIN_LOCKED`; desbloqueie o iPhone e execute Pyto em
primeiro plano. Uma leitura incompatível ou gravação não confirmada retorna
`KEYCHAIN_INVALID_DATA` ou `KEYCHAIN_VERIFICATION_FAILED`.
Não existe fallback para arquivo, `NSUserDefaults` ou o módulo `userkeys` do
Pyto. O módulo `keychain` com `get_password`/`set_password` pertence a outros
ambientes Python iOS e não é pressuposto por esta implementação.

**Validação pendente em hardware:** os testes portáveis exercitam status de
falha, rotação, concorrência, limites e confirmação da persistência com um
adaptador exclusivo de testes. Eles não executam Security.framework. Antes de
usar em uma biblioteca pessoal, execute `doctor`, uma matrícula, `status`,
feche/reabra o Pyto e repita `status` no iPhone. Confirme também a recusa de
acesso com o aparelho bloqueado; não declare a integração operacional antes
desse teste real.

Referências públicas do armazenamento:

- https://developer.apple.com/documentation/security/secitemcopymatching(_:_:)
- https://developer.apple.com/documentation/security/secitemadd(_:_:)
- https://developer.apple.com/documentation/security/secitemupdate(_:_:)
- https://developer.apple.com/documentation/security/ksecattraccessiblewhenunlockedthisdeviceonly
- https://developer.apple.com/documentation/corefoundation/cfdictionarycreatemutable(_:_:_:_:)
- https://github.com/ColdGrub1384/Pyto/blob/main/docs/Objective-C.rst
- https://github.com/ColdGrub1384/Pyto/blob/main/Lib/userkeys.py

## Cloudflare Access para o dispositivo

Mantenha Access em toda a origem. O Pyto não compartilha a sessão Safari;
configure uma aplicação Access específica para `photos.exemplo.com/v1/bridge/*`,
com política **Service Auth** que aceite somente o Service Token desse dispositivo.
Mantenha os demais caminhos protegidos pela aplicação de identidade humana,
incluindo `/v1/apple-sync/*`. A correspondência mais específica deve selecionar
a aplicação Bridge; confira a política resultante no painel Zero Trust.
Não use uma regra `Bypass` para o Bridge. O Tunnel continua sendo a única rota
até a origem. Consulte [CLOUDFLARE_SETUP.md](CLOUDFLARE_SETUP.md).

Crie um Service Token com prazo de validade e permissões restritas a essa
aplicação. Execute no console privado do Pyto:

```text
python bridge.py access --url https://photos.exemplo.com
```

O comando solicita Client ID e Client Secret com `getpass`. Se o console não
conseguir ocultar a entrada, interrompe com `ACCESS_INPUT_UNAVAILABLE`; nenhum
argumento CLI aceita segredos. Não cole os valores no arquivo de configuração,
no Atalho, em variáveis exportadas por logs ou em uma URL. Um item Keychain
`cloudflare-access:<SHA-256 da origem>` mantém o par, com a mesma proteção local
do token Bridge. Repetir `access` rotaciona o par e verifica a gravação por leitura.
O comando não altera o cadastro do dispositivo e pode ser executado antes de `enroll`.

Cada requisição usa `CF-Access-Client-Id` e `CF-Access-Client-Secret` para a camada
Cloudflare, inclusive durante a matrícula. Após a matrícula, usa também o Bearer
Bridge próprio: o servidor continua validando o dispositivo em todos os endpoints.
Service Auth não concede acesso à API humana e não substitui o token Bridge.
O cliente só envia requisições para `/v1/bridge/*` na origem HTTPS configurada.
Redirecionamentos são recusados antes de qualquer reenvio das credenciais.
Um redirecionamento ao login Access retorna `CLOUDFLARE_ACCESS_REQUIRED`; confira
expiração, escopo e política, depois repita `access` se precisar rotacionar.

Para revogar um aparelho, revogue tanto o Service Token no Cloudflare quanto o
dispositivo na API. Depois de migrar a origem, execute `access` e `enroll` para a
nova URL; os itens Keychain são separados por origem. O Service Token é opcional
para uma origem HTTPS local que não utiliza Access; sua ausência não ativa um
fallback de autenticação no servidor. Cloudflare Service Auth e Keychain nativo
exigem teste real na conta e no iPhone. Os testes portáveis verificam somente
composição dos cabeçalhos, escopo, recusa de redirecionamentos e armazenamento
com adaptadores exclusivos de testes.

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

## Auditoria v1.1: disponibilidade real de keywords

Em 18/10/2026 foram consultados os documentos oficiais e seus metadados DocC.
`PHAssetExtendedMetadata`, `PHAsset.extendedMetadata`, a propriedade `keywords`,
`caption` e `PHAssetChangeRequest.addKeyword(_:)`/`removeKeyword(_:)` indicam
**introducedAt 27.0** em iOS/iPadOS/macOS nas páginas consultadas. Isso descreve
um SDK/OS específico; não comprova que o runtime do Pyto instalado no aparelho
contenha essas APIs. Não foi executado teste nativo de leitura/escrita.

Referências consultadas:

- https://developer.apple.com/documentation/photos/phassetextendedmetadata
- https://developer.apple.com/documentation/photos/phasset/extendedmetadata
- https://developer.apple.com/documentation/photos/phassetextendedmetadata/keywords
- https://developer.apple.com/documentation/photos/phassetextendedmetadata/caption
- https://developer.apple.com/documentation/photos/phassetchangerequest/addkeyword(_:)
- https://developer.apple.com/documentation/photos/phassetchangerequest/removekeyword(_:)
- https://developer.apple.com/documentation/photos/phcloudidentifier

`doctor` inclui `keyword_api_probe`: usa as APIs C públicas do runtime Objective-C
para observar a classe `PHAssetExtendedMetadata` e os selectors documentados
`extendedMetadata`, `addKeyword:` e `removeKeyword:`. Não instancia mudança,
não escreve keywords e não usa KVC privado. Ausência de classe/selector é
reportada. Presença de todos continua com `native_write_verified=false`:
a permissão, leitura, adaptação Rubicon e confirmação precisam de teste real.
`capabilities` continua declarando `keywords_read=false`, `keywords_write=false`.
O inventário de dados públicos das fotos funciona independentemente disso.

### Extensão nativa necessária quando Pyto não oferece o runtime

Uma implementação Swift opcional precisará de um SDK que realmente inclua
as APIs acima e de verificação de disponibilidade em execução. O adaptador deve:

1. Solicitar autorização `.readWrite` com `PHPhotoLibrary`, tratar acesso limitado
   e buscar apenas o `PHAsset` de identidade mapeada/confirmada pelo usuário.
2. Ler `PHAsset.extendedMetadata.keywords` usando API pública disponível, montar
   a revisão do snapshot e comparar a revisão aprovada no backend.
3. Criar `PHAssetChangeRequest` somente dentro do bloco `performChanges`, aplicar
   `addKeyword`/`removeKeyword` exclusivamente ao delta aprovado; remover somente
   keywords comprovadamente gerenciadas e explicitamente autorizadas.
4. Refazer a leitura do mesmo asset, verificar identidade + revisão + conjunto
   final e enviar o recibo idempotente com lease/fencing do protocolo existente.
5. Manter `awaiting_cloud_confirmation` após read-back local. Confirmar iCloud
   separadamente antes de marcar `completed`; nunca presumir propagação por
   uma chamada aceita ou por presença de `PHCloudIdentifier`.

Isso exige compilação/assinatura nativa e hardware compatível; não é requisito
para catálogo, ingestão, inferência ou pesquisa cloud. Nenhum stub de escrita
é apresentado como funcional. No Pyto atual, operações ficam pendentes ou
unsupported com `PHOTOKIT_WRITE_UNAVAILABLE`.

### Protocolo de teste: exatamente uma fotografia

Registre SHA da release, versão do OS/SDK, versão Pyto/adaptador e um ID interno
sem exportar a imagem. Escolha manualmente uma foto de teste autorizada, confira
nome/data/dimensões na tela e confirme correspondência única; semelhantes não
servem como prova de identidade. Leia keywords existentes e salve a revisão.
Solicite prévia com **uma** keyword inofensiva nova, `single_asset_test=true`,
aprove explicitamente e mantenha escrita em lote desativada. Execute somente o
delta, refaça leitura e compare a identidade e todas as keywords preexistentes.
Conferir no app Fotos e, depois, em outra visualização sincronizada do iCloud
é uma etapa adicional, não uma consequência automática do read-back.
Se a leitura, identidade, disponibilidade ou revisão falhar, interrompa sem
escrever nem confirmar sucesso. Remoção da keyword de teste exige uma nova
prévia/ aprovação e prova de gerenciamento. O checklist físico completo está
em [docs/operations/iphone-acceptance.md](docs/operations/iphone-acceptance.md).

### Access na origem Cloud Run

Além do Bearer do aparelho, a produção valida o JWT Service Auth da aplicação
Bridge com `ACCESS_BRIDGE_AUDIENCE` e allowlist de Client IDs em
`ACCESS_BRIDGE_SERVICE_TOKENS`. Isso protege também a URL direta `run.app`.
O Pyto deve usar o hostname Cloudflare configurado em `access`; não enviar
Client Secret para a origem Google. A sessão Safari não substitui esse par.
Ausência/expiração/revogação exige recuperação explícita, nunca bypass.


### Chave global de escrita nativa

`APPLE_NATIVE_WRITE_ENABLED=false` é o padrão e é aplicado no backend. Mesmo um
aparelho que declare `keywords_write=true` e tenha teste anterior registrado não
adquire operações de escrita com essa chave desativada; as propostas permanecem
armazenadas. A prévia declara `write_available=false` e um recibo
`applied_on_device` é recusado sem alterar o estado da operação. Desativar
`APPLE_KEYWORD_SYNC_MODE` também bloqueia aquisição e confirmação de aplicação.
O estado `/v1/apple-sync/status` expõe `native_write_enabled` para diagnóstico,
sem expor segredos. Testes de protocolo que simulam recibos usam opt-in explícito
no processo de teste; não habilitam essa chave na produção.

A chave não comprova suporte do OS nem substitui aprovação, identidade inequívoca,
lease, leitura prévia, read-back ou o teste individual descrito acima. Somente
ative após implementar/validar um adaptador real numa foto selecionada, mantendo
`APPLE_BULK_WRITE_ENABLED=false`. O adaptador Pyto entregue continua read-only;
ativar a chave sozinha não lhe fornece capacidade de escrita.
