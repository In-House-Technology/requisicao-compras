# Requisição de compras

App `inhouse/requisicao-compras`, versão **1.0.1**, para instalar na nuvem da sua empresa pelo catálogo In House Apps. Licença [MIT](LICENSE).

Registre uma descrição, quantidade, valor estimado total em reais e justificativa. A interface organiza os pedidos em pendentes, aprovados e recusados, com solicitante, data, responsável pela decisão e comentário opcional. Todos com acesso ao app veem as requisições; o filtro “Só as minhas” também mostra pedidos que você pode decidir. A consulta limita-se aos 500 pedidos mais recentes, com até 30 cartões por coluna de decisões.

Gestores podem aprovar ou recusar, mas ninguém decide o próprio pedido. O solicitante pode retirar seu pedido enquanto estiver pendente; a exclusão é lógica e preserva o registro no banco. Pedidos retirados deixam de aparecer na interface, na API e no MCP. A decisão é atômica: um pedido já decidido ou retirado não pode ser aprovado novamente.

## Instalação

Escolha esta versão no catálogo da nuvem e confirme as permissões. A instalação substitui `__APP_SLUG__`, `__APP_NAME__`, `__OWNER_EMAIL__`, `__APP_DOMAIN__` e `__APP_GROUP__` em `company-app.yaml`, além do slug no fluxo de deploy da empresa. Você pode escolher outro slug. O runtime recebe `APP_SLUG`, as variáveis do Postgres compartilhado e as variáveis `IHC_MCP_*` da nuvem. O app usa Node 22 e não precisa de Redis nem armazenamento de objetos.

O repositório de origem não contém `ihapp-config.yaml` nem `ihapp-origin.yaml`. O segundo é mantido pelo mecanismo de instalação e atualização; não o edite manualmente.

## Configuração da empresa

Crie `ihapp-config.yaml` na raiz do repositório **instalado** para alterar os padrões. Exemplo sem dados reais:

```yaml
company_name: Sua empresa
approver_groups:
  - ihc-admins
approver_emails: []
```

| Ponto | Tipo e limites | Padrão |
| --- | --- | --- |
| `company_name` | Texto de até 100 caracteres Unicode; exibido no cabeçalho e título | `Sua empresa` |
| `approver_groups` | Lista com pelo menos um nome de grupo não vazio | `[ihc-admins]` |
| `approver_emails` | Lista de e-mails válidos; pode ser vazia | `[]` |

Pertencer a qualquer grupo configurado **ou** ter um dos e-mails configurados permite decidir pedidos de outras pessoas. E-mails são comparados sem diferenciar maiúsculas de minúsculas; nomes de grupos são exatos. Esses valores não concedem entrada no app: a pessoa ainda precisa ter acesso pelo login da empresa e pelas políticas da nuvem. Garanta que os grupos existam no diretório.

Sem o arquivo, valem os padrões. Cada lista informada substitui a lista inteira. Chaves desconhecidas, valores nulos, tipos errados, listas fora dos limites e campos obrigatórios ausentes impedem a inicialização com uma mensagem indicando o campo a corrigir. Alterações são lidas ao iniciar: publique a mudança pelo fluxo normal de check/deploy. Não coloque segredos nesse arquivo.

## Permissões e dados

- **Postgres do próprio app:** `purchase_requests` guarda pedidos, solicitante e decisão; `schema_migrations` registra revisões aplicadas e seus checksums. Todas as linhas de negócio têm UUID, datas de criação/alteração/exclusão e os respectivos segundos Unix. Um gatilho mantém os pares atualizados.
- **Identidade:** nome, e-mail e grupos fornecidos pelo login da empresa; sem tela de login própria. E-mail e grupos determinam quem decide. O nome é usado na apresentação do solicitante e de quem decidiu.
- **MCP:** `list_requests`, somente leitura, retorna os mesmos pedidos visíveis na interface, opcionalmente filtrados por `pendente`, `aprovada` ou `recusada`. O app valida o JWT do gateway (chave, emissor, audiência, validade e escopo `<slug>.read`). Não há ferramenta MCP de decisão.
- **Integrações:** nenhum conector, Redis, bucket ou destino direto de internet. A comunicação interna com o Postgres e com o JWKS do gateway usa os endereços fornecidos pela nuvem.

As rotas `/api/requests`, `/api/me` e `/me` exigem a identidade da empresa. `GET /api/me` retorna a mesma pessoa autenticada que `/me`; sem identidade, ambas retornam 401. `/health` é pública, verifica a conexão ao banco e inclui `commit` de `COMMIT_SHA` ou `GIT_SHA` (nessa ordem), ou `null` quando ausentes. Os cabeçalhos `X-authentik-*` só devem chegar pelo proxy confiável da nuvem; não exponha o container diretamente à internet.

## Atualizações e migrações

Versões são tags `vX.Y.Z` na [origem pública](https://github.com/In-House-Technology/requisicao-compras). A nuvem oferece atualizações; elas dependem de aceitação. O processo integra a nova origem preservando as alterações locais e o `ihapp-config.yaml` da empresa. Mudanças de permissões são apresentadas para revisão; o histórico de cada versão está em `ihapp-catalog.yaml`.

Faça backup antes de atualizar. `node migrate.js` aplica os arquivos `migrations/NNN_name.sql` em ordem, cada um na própria transação, sob uma trava para evitar execuções concorrentes. A revisão só é registrada após sucesso; uma nova execução pula as já aplicadas e recusa arquivos históricos alterados ou removidos. Novas alterações de esquema exigem novos arquivos; nunca edite uma migração aplicada. O servidor também executa esse runner antes de abrir a porta HTTP. Uma falha interrompe a inicialização.

A primeira migração cria a tabela de pedidos numa base vazia. Nenhum pedido é apagado fisicamente pelo app: a retirada de um pedido pendente usa exclusão lógica.

## Desenvolvimento local

Com Node 22 e acesso a um Postgres de desenvolvimento já existente:

```sh
npm ci
cp .env.example .env
# Defina DATABASE_URL (ou PGHOST/PGDATABASE/PGUSER/PGPASSWORD) no .env.
# O .env é lido pelo Docker Compose; para Node diretamente use:
node --env-file=.env server.js
npm test
```

Os valores `LOCAL_AUTH_MOCK_*` do exemplo servem apenas para desenvolvimento. Remova-os da configuração de produção. Não versione `.env`. Opcionalmente, `docker compose up --build` publica a porta local 8080; na nuvem, o overlay remove essa publicação. O Dockerfile inclui a configuração da empresa na imagem quando ela existir no repositório instalado.

A CI executa `npm ci`, `npm test` e o validador oficial em modo app; em tags verifica também versão e commit. A action `Estoca/inhousecloud/.github/actions/ihapp-catalog-validate@77b5b92c4c000e75b86e9c088b93c8b87e55dc5d` precisa estar publicada na plataforma para essa etapa funcionar. O fluxo `.gitea/workflows/deploy.yml` é o fluxo genérico usado pela empresa após instalar o app.
