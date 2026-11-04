# Aceitação em iPhone físico — v1.1

> **Nota de revisão arquitetural (04/11/2026):** Validação WebKit/simulação não substitui Safari físico no iPhone. Cache de service worker não inclui `/v1/*`, mídias privadas ou sessão; teste explicitamente Access, FCM, teclado, safe areas e mídia autenticada. Consulte [a referência técnica](../architecture/FRONTENDS_AND_BRIDGE.md).

Este protocolo exige o aparelho real e a implantação privada. Playwright/WebKit
no Linux não comprova Safari, instalação PWA, Keychain, PhotoKit nem autenticação
na conta Cloudflare. Nenhum item abaixo está marcado como aprovado por testes
sintéticos. Registre SHA da release, versão iOS/Pyto, modelo de iPhone, horário,
rede, resultado e ID de correlação sem incluir fotos, cookies ou tokens.

## Pré-condições

- [ ] Deploy identificado pelo manifesto de release e migration head correto.
- [ ] Access exige a identidade humana autorizada na PWA e na API.
- [ ] R2 privado; importação e GPU pausados até autorização de gasto.
- [ ] Somente dez fotos explicitamente autorizadas na primeira execução.
- [ ] Backup e restauração verificados antes de ampliar a biblioteca.

## Safari, autenticação e mídia

Execute os passos em Safari normal; repita o fluxo principal na PWA instalada
pela ação **Adicionar à Tela de Início**. Repita em Wi-Fi e dados móveis.

- [ ] Sem login, abrir o domínio Pages personalizado exige Access.
- [ ] `pages.dev`, deployments de preview e endereços alternativos também exigem
      Access ou estão desativados. Não validar apenas o domínio personalizado.
- [ ] Concluir login e acessar a galeria sem ciclo de redirecionamento.
- [ ] Reautenticar depois de expiração/revogação; mídia volta a carregar.
- [ ] Retomar PWA após bloqueio do aparelho e troca entre Wi-Fi/celular.
- [ ] Rolar várias páginas; grade permanece virtualizada e não perde a posição.
- [ ] Abrir foto; navegar próxima/anterior, deslizar, zoom e voltar à grade.
- [ ] Painel inferior abre/fecha sem sobrepor controles; foco e VoiceOver coerentes.
- [ ] Safe areas respeitam notch e indicador inferior em retrato/paisagem.
- [ ] Teclado na busca e edição de tag não cobre campo, ações ou navegação.
- [ ] Seleção múltipla, filtros, álbum, tags e busca salva persistem após recarregar.
- [ ] Em busca sem Modal, filtros exatos continuam disponíveis e a indisponibilidade
      semântica aparece sem similaridades inventadas.
- [ ] Com login expirado, thumbnail/preview exigem nova autenticação.
- [ ] Direto em `https://SERVICO.run.app/v1/assets` e uma URL de mídia, sem JWT,
      retorno 401/403. Forjar email/X-Forwarded-* não concede identidade.
- [ ] Objeto R2 sem assinatura retorna 403; não existe domínio público do bucket.
- [ ] DevTools remoto é opcional. Se medir rede, registre bytes/contagens/latência,
      nunca payload, nome pessoal, URLs assinadas ou credenciais.
- [ ] Logout/revogação impede novas consultas privadas; service worker não contém
      foto, resposta `/v1`, token ou URL assinada em Cache Storage.

O proxy de mídia mantém `private, no-store`. `ETag` é restrito à revisão e
processado somente depois da autenticação; não autoriza cache público/offline.
Ranges e streaming reduzem memória da API, não garantem redução de tráfego na
rolagem repetida. Meça bytes reais em celular antes de alterar a retenção.

## Bridge: Access de serviço separado do navegador

- [ ] Criar aplicação Access específica `/v1/bridge/*` com política Service Auth;
      nenhuma regra Bypass e nenhum acesso a `/v1/apple-sync/*`.
- [ ] Cadastrar audience Bridge e Client ID exato na allowlist do backend.
- [ ] `python bridge.py access --url https://api.SEUDOMINIO` solicita segredo
      oculto e confirma Keychain. Credenciais Safari não são reaproveitadas.
- [ ] `doctor`, matrícula e `status` funcionam com iPhone desbloqueado.
- [ ] Fechar/reabrir Pyto; `status` reutiliza Keychain sem arquivo de segredo.
- [ ] Service token revogado/faltando e Bearer Bridge revogado/faltando falham.
- [ ] Service JWT Bridge não acessa catálogo, fotos ou administração humana.
- [ ] Inventário limitado/resumível gera candidatos; identificadores icloudpd e
      PhotoKit permanecem distintos; correspondência ambígua bloqueia escrita.
- [ ] Com APIs keyword ausentes, `keywords_read=false`, `keywords_write=false`;
      `sync` não adquire operações nem confirma modificações inexistentes.

## Uma foto para eventual validação nativa

O adaptador executável atual permanece read-only. A presença de símbolos
observada por `doctor` não habilita escrita. Antes de implementar/habilitar um
adaptador nativo, cumpra o protocolo em [PYTO_BRIDGE.md](../../PYTO_BRIDGE.md),
registre disponibilidade real do OS/SDK, leitura de keywords, identidade única,
aprovação explícita, delta aditivo, read-back e recibo. Depois confirme propagação
no iCloud separadamente. Nunca marcar escrita verificada com base apenas na
resposta de `performChanges`, presença de selector ou simulação de teste.
