# Checkpoints e configuração

model-pins.json registra os commits imutáveis conferidos em metadados públicos
em 15/10/2026. As cópias pequenas em checkpoints/ permitem auditar a seleção.
Nenhum peso de modelo ou fotografia é incluído no repositório.

JoyTag: Apache-2.0 declarado no Hugging Face; 5.813 tags e entrada de 448 pixels.
O vocabulário top_tags.txt foi consultado no mesmo commit do checkpoint.

SigLIP 2 base patch16-224: Apache-2.0 declarado no Hugging Face. O config esparso
usa os defaults de SiglipConfig do Transformers 5.10.2: hidden size 768 nos dois
encoders e projection size do texto igual ao hidden size. A fonte conferida é
src/transformers/models/siglip/configuration_siglip.py, blob
69f5fba89f1e0dbd6dea6a7082fbb0947eb54c27. A fonte da tag 5.10.2 foi comparada
byte a byte com o wheel instalado. O adapter verifica novamente as dimensões
do modelo instanciado e rejeita qualquer incompatibilidade com vector(768).

Essas verificações confirmam metadados e contratos. Inferência real e medição de
qualidade/custo ainda exigem executar o smoke test com os pesos e recursos reais.
Instalar ou testar o projeto não ativa GPU automaticamente.

A atualização de runtime cria um novo namespace de preprocessing
`siglip2-transformers-5.10.2-v2`. Embeddings antigos permanecem no banco; não são
misturados automaticamente com os novos. A migração 0007 exige pausar workers
antigos e atualizar API, Jobs e Modal juntos. Reindexação é uma ação explícita.
