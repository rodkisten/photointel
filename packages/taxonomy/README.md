# Taxonomia 1.0.0

O mapeamento executável versionado está em
`apps/api/src/photointel/services/taxonomy.py`. Ele conserva todas as chaves JoyTag,
inclui as 14 categorias, traduções pt-BR revisáveis e regras compostas declarativas.
Chaves sem mapeamento ficam em `other`, sem inventar traduções ou identidades.

As configurações persistidas `taxonomy_overrides`, `taxonomy_categories` e
`taxonomy_compound_rules` permitem mapeamento, aliases, hierarquia, ativação e limiar
por categoria. A interface administrativa de tags também permite alterações manuais
e fusões. Predições brutas permanecem vinculadas à revisão exata do modelo.

Categorias sensíveis são ocultadas por padrão. Aprovação/rejeição do usuário é um
registro independente, preservado após reprocessamento. Os termos de pessoa da
taxonomia não são um detector validado de contagem de pessoas.
