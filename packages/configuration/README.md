# Checkpoints e configuração

model-pins.json registra os commits imutáveis conferidos em metadados públicos
em 15/10/2026. As cópias pequenas em checkpoints/ permitem auditar a seleção.
Nenhum peso de modelo ou fotografia é incluído no repositório.

JoyTag: Apache-2.0 declarado no Hugging Face; 5.813 tags e entrada de 448 pixels.
O vocabulário top_tags.txt foi consultado no mesmo commit do checkpoint.

SigLIP 2 base patch16-224: Apache-2.0 declarado no Hugging Face. O config esparso
usa os defaults de SiglipConfig do Transformers 4.57.6: hidden size 768 nos dois
encoders e projection size do texto igual ao hidden size. A fonte conferida é
src/transformers/models/siglip/configuration_siglip.py, blob
0c182014fa272bb53b9e597894daa104a864a2c9. O adapter verifica novamente as dimensões
do modelo instanciado e rejeita qualquer incompatibilidade com vector(768).

Essas verificações confirmam metadados e contratos. Inferência real e medição de
qualidade/custo ainda exigem executar o smoke test com os pesos e recursos reais.
Instalar ou testar o projeto não ativa GPU automaticamente.
