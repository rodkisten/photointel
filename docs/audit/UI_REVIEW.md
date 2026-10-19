# Revisão da interface — v1.1

A revisão preserva React/Vite, o tema escuro existente, os diálogos Radix, o cliente
OpenAPI e a grade virtualizada. Inspeção de código não equivale a um teste em
Safari físico. A data e o SHA dos testes finais devem constar no manifesto da
release; evidências antigas não aprovam os gates desta versão.

| Tela | Constatação | Correção ou comportamento preservado | Verificação |
| --- | --- | --- | --- |
| Home | Os próximos passos eram estáticos e podiam recomendar conectar iCloud já configurado. | Painel `/v1/setup/status` apresenta banco, storage, sessão, IA, gasto habilitado e a próxima ação determinada pelo servidor. Configuração não é apresentada como teste realizado. | Teste de diagnóstico com Modal não configurado e gasto desabilitado. |
| Biblioteca | A grade já limitava elementos no DOM e carregava cursores. | Virtualização preservada. Dependências do efeito de carregamento incremental explicitadas. Estados vazio, erro e autorização permanecem reais. | Teste de 1.000 itens mantém menos de 150 tiles no DOM. |
| Detalhe | O viewer já tinha navegação, zoom, edição manual e painel móvel. | Fluxos preservados; não se atribui capacidade PhotoKit inexistente. | Suíte existente; Safari físico continua requisito separado. |
| Search Intelligence | Texto preenchido com GPU indisponível desabilitava também a aplicação de filtros exatos. | Filtros e buscas salvas permanecem utilizáveis. Resposta degradada informa ausência de relevância semântica e oferece nova chamada real; não inventa pontuações. | Teste de aviso e refetch; teste do fallback no backend. |
| Tags | Categorias, aprovações/rejeições, aliases e origem já invocavam operações reais. | Fluxos e opt-in de apresentação sensível preservados. | Suíte de taxonomia existente. |
| Álbuns | Um deep link dependia de o álbum estar entre os primeiros 100 resultados da listagem. | O álbum ativo é consultado por UUID no endpoint de detalhe e possui erro recuperável próprio. | Typecheck/build e teste de link fora da listagem. |
| Duplicadas | A seleção e a comparação eram apenas de catálogo, sem exclusão. | Preservadas. Nenhuma exclusão remota ou automática introduzida. | Suíte E2E existente e revisão de handlers. |
| Jobs | Já havia SSE com recuperação, polling, inspeção e ação real de retry. | Estados persistidos, erros e controles preservados. Não há progresso fictício. | Suíte operacional existente. |
| iCloud | Faltava revisão individual de falhas/quarentena e o limite visual era fixo. | Limite padrão e hard limit vêm da API. Falhas têm paginação, retry por UUID e quarentena com motivo explícito. Orientação diferencia sessão efêmera Cloud Run de host persistente. | Teste de retry/quarentena e confirmação de expansão. |
| Apple Bridge | Recursos nativos indisponíveis já eram indicados. | Read-only e operações pendentes preservados; não se afirma escrita verificada sem dispositivo. | Suíte Bridge existente; protocolo físico em documentação específica. |
| Configurações | Os diagnósticos de capacidades já existiam, mas não havia sequência de validação de release. | Preservada, com nova página Preparação e validação para gates e proveniência. | Teste de aprovação manual exige evidência, SHA e declaração explícita. |

## Nova página: Preparação e validação

`/setup` mostra diagnóstico real, gates A–F e identificação segura da release.
Um gate bloqueado não oferece aprovação. Para registrar resultado, o operador
informa referências e confirma que executou o teste; o servidor valida SHA,
pré-requisitos e aprovação. A interface não acessa credenciais ou cookies.

Referências são texto, não HTML. Links de próximas ações aceitam apenas caminhos
locais. Quarentena suspende novas tentativas, preservando catálogo, histórico e
originais. Não existe botão para importar a biblioteca completa automaticamente.

## Limites desta revisão

Os novos testes unitários verificam comportamentos, não os provedores reais.
Cloudflare Access, rede celular, renovação de sessão, instalação da PWA, teclado,
notch e PhotoKit exigem aceitação em iPhone físico. O checklist do dispositivo é
independente dos testes Linux WebKit. Não há equivalência presumida entre ambos.
