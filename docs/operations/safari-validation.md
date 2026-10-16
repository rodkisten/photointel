# Validação de navegação com WebKit

O projeto Playwright `iphone-webkit` usa o WebKit distribuído pelo Playwright no
Linux, com dimensões, touch e user agent do perfil `iPhone 13`. Ele complementa
os projetos Chromium `iphone` e `desktop`. Só é incluído quando
`PHOTOINTEL_TEST_WEBKIT=1`; a CI habitual mantém os dois projetos existentes.

O workflow [Validate iPhone WebKit](../../.github/workflows/webkit-validation.yml)
é opt-in: execute **Run workflow** na aba Actions do GitHub ou envie um commit
para a branch `validation/webkit`. Ele não executa em pushes normais de `main`.
Use Safari no iPhone para abrir o GitHub e executar o workflow; nenhum Mac ou
Xcode é necessário para essa verificação.

O ambiente de validação usa dependências dos locks, PostgreSQL/pgvector, MinIO
privado compilado da fonte fixada, migrações e um papel SQL limitado. O mesmo
`infra/scripts/run-e2e.sh` inicia a API, uma API com autenticação obrigatória e
o worker. Os três projetos de navegador exercitam as fotografias sintéticas.
O backend determinístico exige explicitamente `APP_ENV=test` e revisões fictícias;
não instala os modelos de GPU, não acessa iCloud e não chama Modal.

Para executar localmente com as dependências e os serviços de teste configurados:

```bash
npm exec --prefix apps/web -- playwright install --with-deps chromium webkit
PHOTOINTEL_TEST_WEBKIT=1 bash infra/scripts/run-e2e.sh
```

O helper exige as mesmas variáveis de teste da CI: `APP_ENV=test`,
`INFERENCE_BACKEND=test`, `GPU_ENABLED=true`, as revisões fictícias de JoyTag
(`1111111111111111111111111111111111111111`) e SigLIP 2
(`2222222222222222222222222222222222222222`), além de PostgreSQL e storage de
teste. `GPU_ENABLED=true` nesse backend habilita exclusivamente a simulação
controlada. Não use as variáveis de um catálogo pessoal.

Os resultados ficam no artifact `iphone-webkit-validation`, com JUnit em
`reports/browser-webkit.xml` e traces/capturas de falhas quando produzidos pelo
Playwright. Esses arquivos contêm apenas a biblioteca sintética da execução.
A conclusão do job deve ser aprovada e o JUnit precisa incluir o projeto
`iphone-webkit` antes de registrar WebKit como validado.

O [run 38831575164](https://github.com/rodkisten/photointel/actions/runs/38831575164)
passou: 46 testes aprovados nos três projetos, incluindo os 15 fluxos da aplicação
em WebKit, e duas capturas desmarcadas intencionalmente. O JUnit e o hash do
artifact estão no [relatório permanente](../evidence/webkit-validation.json).
WebKit no Linux não
comprova Safari no iOS: instalação da PWA, permissões, safe areas, teclado,
gestos e navegação no aparelho real continuam exigindo validação manual em um
iPhone. PhotoKit e escrita de keywords não são exercitados por este workflow.
