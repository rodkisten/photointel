# Validação manual dos modelos em CPU

> **Nota de revisão arquitetural (04/11/2026):** Provas de inferência CPU com pesos reais não validam automaticamente Modal/CUDA, latência, billing ou dados Apple reais. Mantenha pins dos modelos e do pré-processamento compatíveis com o schema pgvector. Consulte [a referência técnica](../architecture/DATA_AND_INFERENCE.md).

O workflow **Real models on CPU (manual)** executa os checkpoints reais fixados
de JoyTag e SigLIP 2 em um runner Linux AMD64 comum, sem reservar GPU nem chamar
Modal. Não depende de secrets, iCloud ou fotos particulares. Ele só inicia por
`workflow_dispatch`, com `confirm_download=true`, ou por push explícito do operador
na branch reservada `validation/real-cpu`: baixar os pesos pode transferir
vários GB e o runner usa minutos de GitHub Actions conforme o plano da conta.

Pelo Safari no iPhone, abra **GitHub → photointel → Actions → Real models on CPU
(manual) → Run workflow**, selecione a branch e habilite a confirmação. A execução
tem limite de 45 minutos, lote de uma única imagem sintética e concorrência global
de uma execução. O campo histórico `GPU_ENABLED=true` habilita a interface de
inferência, mas `INFERENCE_BACKEND=cpu`, as wheels `+cpu` e a validação em runtime
impedem alocação CUDA ou fallback para Modal. O estimador é zerado para este teste;
isso não afirma que minutos de GitHub Actions sejam gratuitos.

A branch `validation/real-cpu` é uma alternativa para disparar a mesma validação
por ferramentas Git. Criá-la ou atualizá-la é a ação explícita do operador que
autoriza download e minutos de execução CPU. Push em `main`, pull requests e
instalação normal não disparam esse workflow.

O ambiente instala as versões base exatas de `torch` e `torchvision` presentes em
`uv.lock`, substituindo apenas a distribuição CUDA pela wheel oficial `+cpu` no
índice `https://download.pytorch.org/whl/cpu`. As demais dependências vêm do lock.
Se uma wheel CPU dessa versão não existir, a instalação falha: não há downgrade
oculto, resolução de outro checkpoint ou saída fictícia.

Um PostgreSQL com pgvector é criado para a execução, recebe as migrações e uma
única imagem procedural pelo pipeline normal, inicialmente com inferência
desabilitada. Depois o smoke exige banco sem inferências prévias, processa essa
imagem e confirma em uma nova sessão do banco:

- Duas inferências concluídas com as revisões imutáveis esperadas.
- 5.813 probabilidades JoyTag finitas no intervalo de zero a um.
- Um vetor de imagem de 768 dimensões finitas e norma aproximadamente um.
- Embeddings reais de duas frases em português, da mesma revisão SigLIP 2, com
  similaridades de cosseno finitas.

O artefato `real-cpu-model-validation` contém `result.json`, duração medida,
versões instaladas, seleções exatas de dependências e o resultado do seed. Um
arquivo de resultado só é escrito após todos os checks. Um job interrompido ou
falho não comprova inferência. Não são exportados pesos, imagens, labels
sensíveis individuais nem dados de bibliotecas particulares.

Essa execução confirma o caminho CPU e a persistência; não comprova CUDA, Modal,
cobrança do provedor, precisão da classificação ou qualidade de busca multilíngue
em uma biblioteca real. O smoke Modal permanece uma validação separada, explícita
e sujeita aos controles de orçamento documentados em `MODAL_SETUP.md`.
