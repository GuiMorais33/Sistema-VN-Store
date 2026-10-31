// ============================================================
//  Entrada do agente (Claude).
//
//  O agente não usa a senha da loja: tem uma chave própria, que o dono
//  gera na tela Agentes e pode revogar quando quiser. A chave vai no
//  cabeçalho "Authorization: Bearer <chave>". Aqui fica só o resumo
//  (hash) dela — nem quem abrir o banco consegue recuperá-la.
//
//  Dois níveis, que só o dono escolhe na tela Agentes:
//   - "leitura" (o padrão, e o de toda chave nova): só consulta, e só o
//     que está em LEITURAS;
//   - "total": faz tudo o que o dono faz nas telas — vender, cancelar,
//     acertar estoque (que sobe para a Nuvemshop), financeiro, equipe —,
//     menos o que está em SO_DO_DONO.
//  Tudo o que ele pede fica registrado em agent_log, à vista na tela
//  Agentes; o que ele altera, com o resumo do que mandou.
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
  ['/api/purchases', 'Entradas de mercadoria (com o giro: quanto de cada uma já vendeu)'],
  ['/api/repor', 'O que vendeu e acabou: sugestão de reposição por tamanho (?dias=15|30|60|90)'],
  ['/api/pedidos', 'Pedidos ao fornecedor (?status=aberto|chegou|cancelado)'],
  ['/api/customers', 'Clientes e histórico de compras'],
  ['/api/crm', 'Com quem falar hoje e por quê; /clientes e /cliente/:id'],
  ['/api/mensagens', 'Fila de mensagens aos clientes e modelos'],
  ['/api/atendimentos', 'Funil de atendimento'],
  ['/api/pipeline', 'Funil resumido'],
  ['/api/team', 'Equipe (sem o PIN: só se a pessoa tem acesso)'],
  ['/api/metas', 'Metas do mês e quanto cada um vendeu'],
  ['/api/comissoes', 'Comissão do mês de cada vendedor: base, devido, pago, a pagar (?ym=AAAA-MM)'],
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

// Nem com acesso total. Não é trabalho da loja, é a chave de casa: quem
// tem a chave do agente não pode mexer na própria chave nem subir o
// próprio nível (senão um vazamento vira acesso para sempre), nem levar a
// cópia do banco ou mexer na ligação com a Nuvemshop (lá estão o token e
// o segredo do app, e desligar para o estoque e os pedidos da loja toda).
export const SO_DO_DONO = [
  ['/api/agente/chave', 'Gerar ou revogar a chave do agente'],
  ['/api/agente/nivel', 'Mudar o nível de acesso do agente'],
  ['/api/backup/baixar', 'Baixar a cópia do banco (tem o token da Nuvemshop)'],
  ['/api/connect', 'Trocar o App ID e o Secret da Nuvemshop'],
  ['/api/disconnect', 'Desligar a loja da Nuvemshop'],
  ['/oauth', 'Autorizar o app na Nuvemshop'],
];

export const nivel = () => (getSetting('agent_nivel') === 'total' ? 'total' : 'leitura');

export function definirNivel(n) {
  if (n !== 'total' && n !== 'leitura') throw new Error('Nível deve ser "total" ou "leitura".');
  setSetting('agent_nivel', n);
  setSetting('agent_nivel_desde', new Date().toISOString());
}

const resumo = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

// Gera uma chave nova (a anterior para de valer). Ela só aparece aqui,
// uma vez: quem perdeu, gera outra.
// Chave nova sempre nasce só de leitura: o acesso total é dado de novo, de
// propósito, para a chave que está em uso.
export function gerarChave() {
  const chave = 'vnag_' + crypto.randomBytes(32).toString('base64url');
  setSetting('agent_token_hash', resumo(chave));
  setSetting('agent_token_criada', new Date().toISOString());
  definirNivel('leitura');
  return chave;
}

export function revogarChave() {
  setSetting('agent_token_hash', null);
  setSetting('agent_token_criada', null);
  definirNivel('leitura');
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

const casa = (lista, caminho) => lista.some(([c]) => caminho === c || caminho.startsWith(c + '/'));

export function podeLer(metodo, caminho) {
  if (metodo !== 'GET') return false;
  return casa(LEITURAS, caminho);
}

// O que a chave pode fazer agora, no nível que o dono escolheu.
export function pode(metodo, caminho) {
  // Sem diferença de maiúscula nem barra no fim: /API/Backup/Baixar/ é o
  // mesmo caminho para o Express, então tem que ser o mesmo aqui.
  const c = caminho.toLowerCase().replace(/\/+$/, '') || '/';
  if (casa(SO_DO_DONO, c)) return false;
  return nivel() === 'total' || podeLer(metodo, c);
}

// O que ele mandou numa alteração, em poucas palavras, para o dono ler na
// tela Agentes ("cancelou a venda 123 porque…").
// PIN, senha e chave não ficam escritos nem aqui.
const SEGREDO = /pin|senha|password|secret|token|chave/i;
function detalheDe(corpo) {
  if (!corpo || typeof corpo !== 'object' || !Object.keys(corpo).length) return null;
  const t = JSON.stringify(corpo, (k, v) => (k && SEGREDO.test(k) && v != null && v !== '' ? '***' : v));
  return t.length > 400 ? t.slice(0, 399) + '…' : t;
}

const insLog = db.prepare('INSERT INTO agent_log (quando, metodo, caminho, status, detalhe) VALUES (?,?,?,?,?)');
const podar = db.prepare('DELETE FROM agent_log WHERE id <= (SELECT MAX(id) - 2000 FROM agent_log)');
export function registrar(metodo, caminho, status, corpo) {
  const detalhe = metodo === 'GET' ? null : detalheDe(corpo);
  const id = insLog.run(new Date().toISOString(), metodo, caminho.slice(0, 300), status, detalhe).lastInsertRowid;
  if (id % 100 === 0) podar.run();   // guarda as últimas 2000
}

export function situacao() {
  const ultimo = db.prepare('SELECT quando FROM agent_log ORDER BY id DESC LIMIT 1').get();
  return {
    chave_ativa: Boolean(getSetting('agent_token_hash')),
    criada: getSetting('agent_token_criada') || null,
    nivel: nivel(),
    nivel_desde: getSetting('agent_nivel_desde') || null,
    ultimo_uso: ultimo ? ultimo.quando : null,
    so_do_dono: SO_DO_DONO.map(([caminho, o_que]) => ({ caminho, o_que })),
    log: db.prepare('SELECT quando, metodo, caminho, status, detalhe FROM agent_log ORDER BY id DESC LIMIT 30').all(),
    // As alterações ficam à parte: no meio de centenas de consultas, a
    // venda que ele cancelou não pode sumir da tela.
    alteracoes: db.prepare(`SELECT quando, metodo, caminho, status, detalhe FROM agent_log
      WHERE metodo <> 'GET' ORDER BY id DESC LIMIT 50`).all(),
  };
}
