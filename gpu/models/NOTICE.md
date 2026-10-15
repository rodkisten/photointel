# JoyTag — código de terceiros

`joytag_upstream.py` reproduz `Models.py` de
https://github.com/fpgaminer/joytag, commit
`ce0c4a451e31b69a92df24c8bcd1c0418e3e4feb`.
O blob consultado no GitHub tem SHA
`ddeba5f5cd8beb65c7e691e87e650542b4c6d366`.
Licença Apache 2.0 em `LICENSE.JoyTag`.

Alteração local explicitamente identificada: os dois contextos SDPA habilitam o
kernel matemático quando `q_states` está na CPU; o comportamento CUDA permanece
igual. Isso permite o adaptador CPU opcional sem depender de kernels CUDA.

O adaptador local só aceita pesos `safetensors`, valida a quantidade de tags contra
`top_tags.txt`, exige revisão imutável no Hugging Face e usa o pré-processamento
publicado no README oficial: preenchimento branco quadrado, resize BICUBIC e
normalização CLIP. O código de arquitetura é mantido separado das políticas da
aplicação. A licença dos pesos deve ser consultada no model card fixado.
