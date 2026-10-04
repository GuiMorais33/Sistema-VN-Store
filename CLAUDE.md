# VN Store — sistema da loja

Loja de roupa (streetwear) com site na Nuvemshop. Este sistema é o back-office: PDV, estoque,
financeiro, clientes/CRM, equipe e metas. Node 22 + Express + SQLite (better-sqlite3) + HTML puro,
sem etapa de build. Roda numa VM da Oracle (`deploy/DEPLOY-ORACLE.md`).

## Como trabalhar no código
- Comentários, nomes e textos de tela em português, explicando o **porquê** da regra de negócio.
- Regras que valem no sistema todo: `VENDA` e `FIADO` no topo de `server/index.js`; fuso da loja em
  `server/fuso.js`; estoque que vai para a Nuvemshop sempre por `server/estoque.js` (diferença somada
  ao número atual da loja — nunca o número daqui).
- Testes: `npm test` (sobem o servidor de verdade contra uma Nuvemshop de mentira). Rode antes de
  qualquer push.
- O dono não é programador: explique em passos simples, um comando por vez.

## Acesso à loja real (agente)
Se as variáveis `VNSTORE_URL` e `VNSTORE_AGENT_TOKEN` existirem no ambiente, o sistema real pode ser
consultado:
```bash
curl -s -H "Authorization: Bearer $VNSTORE_AGENT_TOKEN" "$VNSTORE_URL/api/agente"
```
- O acesso é **somente leitura** e limitado à lista de `server/agente.js`; tudo fica registrado
  na tela Agentes do sistema.
- Nunca mostre, copie ou peça a chave no chat. Se ela não funcionar (401), peça ao dono para
  gerar outra na tela Agentes.
- Dados de clientes (nome, telefone, e-mail) são pessoais: use só para o trabalho da loja.
