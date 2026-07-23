# VN Store — Sistema 🐊

Sistema "vivo" com um **time de agentes autônomos** para administrar a loja de roupa VN Store.
Substitui a gestão feita hoje na Nuvemshop (com **PDV próprio sem taxa por lançamento**) e usa a
**API da Nuvemshop** como fonte da loja — lendo produtos/pedidos e **escrevendo estoque de volta**.

> _Vestindo as quebradas de todo o Brasil desde 2018._

## O que já funciona

- 🛒 **PDV próprio** (`/pdv`) — lançamento de venda ilimitado, **sem taxa por lançamento**. Ao finalizar:
  baixa o estoque, lança no financeiro e **atualiza o estoque na Nuvemshop** (quando conectado).
- 💰 **Financeiro automático** — cada venda vira receita, com custo e margem calculados.
- 📦 **Estoque** — controle unificado, alerta de ruptura (≤ 4 un.).
- 📊 **Sala de Comando** (`/`) — painel ao vivo com KPIs do dia, últimas vendas, estoque no vermelho
  e o time de agentes (Maestro, Vendas e Financeiro já ativos; demais no roadmap).

Roda em **modo demonstração** (com produtos de exemplo) sem nenhuma configuração, e fica **ao vivo**
assim que você preenche o `.env` com as credenciais da Nuvemshop.

## Como rodar

```bash
npm install
npm start
# abre em http://localhost:3000  (PDV em /pdv)
```

### Conectar na sua loja (modo ao vivo)

1. Copie o modelo: `cp .env.example .env`
2. Preencha `NUVEMSHOP_STORE_ID` e `NUVEMSHOP_ACCESS_TOKEN` (o token é uma senha — o `.env` **nunca** vai pro Git).
3. `npm start` e clique em **Sincronizar** para puxar os produtos da loja.

## Arquitetura

```
server/
  index.js      API (Express) + páginas + regra de negócio da venda
  db.js         Banco SQLite — vendas, estoque, financeiro, movimentações
  nuvemshop.js  Cliente da API da Nuvemshop (auth + estoque)
public/
  index.html    Sala de Comando (painel ao vivo)
  pdv.html      PDV
  theme.css     Identidade visual (street / neon / cromado)
  logo.webp     Logo da loja
```

- **Nuvemshop** = a loja (vitrine + checkout). Conectada via API.
- **Este sistema** = o cérebro: PDV, financeiro, estoque e o time de agentes. Fonte da verdade do
  que a Nuvemshop não guarda (custo, margem, caixa).
- **Referência de funções**: Bling (a fatia que cabe no tamanho da operação).

## Paleta

| Elemento | Cor |
|----------|-----|
| Verde neon (assinatura) | `#2fd24f` |
| Preto / grafite (fundo) | `#080a08` |
| Prata / cromado (logo) | `#c3ccd3` |
| Branco (texto) | `#eef3ee` |

## Roadmap (por fase)

- **Fase 2** — agentes agindo: Atendimento (SAC/WhatsApp), Marketing, Logística, Compras.
- **Fiscal** — emissão de NF-e via API pronta (Focus NFe / PlugNotas), só quando precisar.
- **Automação viva** — agentes rodando em horário/gatilho (webhooks da Nuvemshop em tempo real).
