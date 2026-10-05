// ============================================================
//  Entrada do agente (Claude).
//
//  O agente não usa a senha da loja: tem uma chave própria, que o dono
//  gera na tela Agentes e pode revogar quando quiser. A chave vai no
//  cabeçalho "Authorization: Bearer <chave>". Aqui fica só o resumo
//  (hash) dela — nem quem abrir o banco consegue recuperá-la.
//
//  Por enquanto o agente só LÊ, e só o que está em LEITURAS. Tudo o que
//  ele pede fica registrado em agent_log, à vista na tela Agentes.
// ============================================================
import crypto from 'node:crypto';
import db, { getSetting, setSetting } from './db.js';

// O que o agente pode consultar (GET). Lista fechada de propósito: uma
// consulta nova só entra aqui depois de conferir que não expõe segredo
// (token da Nuvemshop, senha) nem a cópia do banco. Cada caminho vale
// também para o que vem depois dele (/api/catalog → /api/catalog/12).
export const LEITURAS = [
  ['/api/agente', 'Este índice, a situação da chave e as vendas com itens (/api/agente/vendas?dias=7)'],
  ['/api/health', 'Modo (ao vivo/demonstração) e tamanho do catálogo'],
  ['/api/connection', 'Conexão com a Nuvemshop: permissão do app e se gravar estoque funciona'],
  ['/api/dashboard', 'Números de hoje: vendas, margem, fiado, estoque baixo'],
  ['/api/vendas', 'Vendas para achar e conferir (/api/vendas?q=&dias=); /api/vendas/:id traz itens e trocas'],
  ['/api/operacao', 'O que precisa de ação agora (pedidos do site, fiado, encomendas)'],
  ['/api/sales-series', 'Vendas por dia (gráfico)'],
  ['/api/products', 'Variações à venda (como o PDV vê)'],
  ['/api/catalog', 'Produtos com variações, custo e estoque; /summary traz o resumo'],
  ['/api/custos', 'Custo de cada variação'],
  ['/api/encomenda', 'Produtos sob encomenda: a grade do site e os pares que estão na loja'],
  ['/api/suppliers', 'Fornecedores'],
  ['/api/purchases', 'Entradas de mercadoria'],
  ['/api/customers', 'Clientes e histórico de compras'],
  ['/api/crm', 'Com quem falar hoje e por quê; /clientes e /cliente/:id'],
  ['/api/mensagens', 'Fila de mensagens aos clientes e modelos'],
  ['/api/atendimentos', 'Funil de atendimento'],
  ['/api/pipeline', 'Funil resumido'],
  ['/api/team', 'Equipe'],
  ['/api/metas', 'Metas do mês e quanto cada um vendeu'],
  ['/api/sonhos', 'Sonho → meta de cada vendedor'],
  ['/api/financial', 'Financeiro do mês: entradas, saídas, a pagar, a receber'],
  ['/api/fixed-expenses', 'Despesas fixas'],
  ['/api/fin-categories', 'Plano de contas'],
  ['/api/caixa', 'Fechamento de caixa do dia'],
  ['/api/relatorios', 'Lucro: curva ABC, margem por produto, dinheiro parado'],
  ['/api/reminders', 'Lembretes'],
  ['/api/canvas', 'Visão do negócio (Canvas)'],
  ['/api/mapa', 'Mapa da estratégia'],
  ['/api/backup/status', 'Se a cópia de segurança do dia foi feita'],
];

const resumo = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

// Gera uma chave nova (a anterior para de valer). Ela só aparece aqui,
// uma vez: quem perdeu, gera outra.
export function gerarChave() {
  const chave = 'vnag_' + crypto.randomBytes(32).toString('base64url');
  setSetting('agent_token_hash', resumo(chave));
  setSetting('agent_token_criada', new Date().toISOString());
  return chave;
}

export function revogarChave() {
  setSetting('agent_token_hash', null);
  setSetting('agent_token_criada', null);
}

export function chaveDoPedido(req) {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization || '');
  return m ? m[1] : null;
}

export function chaveValida(chave) {
  const salvo = getSetting('agent_token_hash');
  if (!salvo || !chave) return false;
  const a = Buffer.from(resumo(chave), 'hex');
  const b = Buffer.from(salvo, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function podeLer(metodo, caminho) {
  if (metodo !== 'GET') return false;
  return LEITURAS.some(([c]) => caminho === c || caminho.startsWith(c + '/'));
}

const insLog = db.prepare('INSERT INTO agent_log (quando, metodo, caminho, status) VALUES (?,?,?,?)');
const podar = db.prepare('DELETE FROM agent_log WHERE id <= (SELECT MAX(id) - 2000 FROM agent_log)');
export function registrar(metodo, caminho, status) {
  const id = insLog.run(new Date().toISOString(), metodo, caminho.slice(0, 300), status).lastInsertRowid;
  if (id % 100 === 0) podar.run();   // guarda as últimas 2000
}

export function situacao() {
  const ultimo = db.prepare('SELECT quando FROM agent_log ORDER BY id DESC LIMIT 1').get();
  return {
    chave_ativa: Boolean(getSetting('agent_token_hash')),
    criada: getSetting('agent_token_criada') || null,
    ultimo_uso: ultimo ? ultimo.quando : null,
    log: db.prepare('SELECT quando, metodo, caminho, status FROM agent_log ORDER BY id DESC LIMIT 30').all(),
  };
}
