// Entrada do agente (Claude): só lê, só o que está na lista, só com a
// chave certa — e tudo o que ele pede fica registrado.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { subirServidor } from './servidor.js';

const SENHA = 'senha-de-teste';
let s, cookie, chave;

before(async () => {
  s = await subirServidor({ APP_PASSWORD: SENHA });
  const r = await s.pedir('POST', '/api/login', { corpo: { password: SENHA } });
  assert.equal(r.status, 200);
  cookie = r.headers.get('set-cookie').split(';')[0];
});
after(() => s?.parar());

const dono = (metodo, caminho, corpo) => s.pedir(metodo, caminho, { corpo, headers: { Cookie: cookie } });
const comoAgente = (metodo, caminho, corpo, k = chave) =>
  s.pedir(metodo, caminho, { corpo, headers: { Authorization: `Bearer ${k}` } });
const umaVariante = async () => (await dono('GET', '/api/products')).json[0].id;

test('sem senha nem chave, nada passa', async () => {
  assert.equal((await s.pedir('GET', '/api/dashboard')).status, 401);
});

test('o dono gera a chave e o agente consulta com ela', async () => {
  chave = (await dono('POST', '/api/agente/chave')).json.chave;
  assert.match(chave, /^vnag_/);
  assert.equal((await comoAgente('GET', '/api/dashboard')).status, 200);
  assert.equal((await comoAgente('GET', '/api/catalog/summary')).status, 200);
  const indice = await comoAgente('GET', '/api/agente');
  assert.equal(indice.json.acesso, 'somente leitura');
  assert.ok(indice.json.leituras.some((l) => l.caminho === '/api/financial'));
});

test('o agente não altera nada nem vê o que é só do dono', async () => {
  const venda = await comoAgente('POST', '/api/sales', { items: [{ variant_id: await umaVariante(), qty: 1 }] });
  assert.equal(venda.status, 403);
  assert.equal(s.banco().prepare('SELECT COUNT(*) n FROM sales').get().n, 0);
  for (const caminho of ['/api/backup/baixar', '/conectar']) {
    assert.equal((await comoAgente('GET', caminho)).status, 403, caminho);
  }
  // A conexão ele vê (permissão do app, se gravar funciona) — nunca o token.
  const con = await comoAgente('GET', '/api/connection');
  assert.equal(con.status, 200);
  assert.doesNotMatch(con.bytes.toString(), /token|secret/i);
  assert.equal((await comoAgente('POST', '/api/connection/testar-escrita')).status, 403);
  assert.equal((await comoAgente('POST', '/api/agente/chave')).status, 403);
  assert.equal((await comoAgente('DELETE', '/api/agente/chave')).status, 403);
});

test('o agente vê as vendas com os itens', async () => {
  await dono('POST', '/api/sales', { items: [{ variant_id: await umaVariante(), qty: 2 }], payment_method: 'pix' });
  const r = await comoAgente('GET', '/api/agente/vendas?dias=1');
  assert.equal(r.status, 200);
  assert.equal(r.json.vendas.length, 1);
  assert.equal(r.json.vendas[0].conta_como_venda, true);
  assert.equal(r.json.vendas[0].itens[0].qty, 2);
});

test('tudo o que o agente pediu fica registrado, inclusive o recusado', async () => {
  const st = (await dono('GET', '/api/agente/status')).json;
  assert.equal(st.chave_ativa, true);
  const linhas = st.log.map((l) => `${l.metodo} ${l.caminho} ${l.status}`);
  assert.ok(linhas.includes('GET /api/dashboard 200'));
  assert.ok(linhas.includes('POST /api/sales 403'));
});

test('chave errada, trocada ou revogada não entra', async () => {
  assert.equal((await comoAgente('GET', '/api/dashboard', null, 'vnag_errada')).status, 401);
  const nova = (await dono('POST', '/api/agente/chave')).json.chave;
  assert.equal((await comoAgente('GET', '/api/dashboard')).status, 401);   // a antiga parou
  assert.equal((await comoAgente('GET', '/api/dashboard', null, nova)).status, 200);
  await dono('DELETE', '/api/agente/chave');
  assert.equal((await comoAgente('GET', '/api/dashboard', null, nova)).status, 401);
});

test('o dono baixa uma cópia do banco', async () => {
  const r = await dono('GET', '/api/backup/baixar');
  assert.equal(r.status, 200);
  assert.equal(r.bytes.subarray(0, 15).toString(), 'SQLite format 3');
});

// Acesso total: o dono liga na tela Agentes e o agente passa a fazer o que
// o dono faz nas telas. A chave continua sem poder mexer nela mesma, nem
// levar a cópia do banco, nem mexer na ligação com a Nuvemshop.
test('o agente não sobe o próprio nível', async () => {
  chave = (await dono('POST', '/api/agente/chave')).json.chave;
  assert.equal((await comoAgente('POST', '/api/agente/nivel', { nivel: 'total' })).status, 403);
  assert.equal((await dono('GET', '/api/agente/status')).json.nivel, 'leitura');
});

test('com acesso total, o agente vende, troca e cancela — e fica tudo anotado', async () => {
  const r = await dono('POST', '/api/agente/nivel', { nivel: 'total' });
  assert.equal(r.status, 200);
  assert.equal((await comoAgente('GET', '/api/agente')).json.acesso, 'total');
  assert.equal((await comoAgente('GET', '/api/eu')).json.nivel, 'total');

  const [a, b] = (await dono('GET', '/api/products')).json;
  const venda = await comoAgente('POST', '/api/sales', { items: [{ variant_id: a.id, qty: 1 }], payment_method: 'Pix' });
  assert.equal(venda.status, 200, String(venda.bytes));
  const id = s.banco().prepare('SELECT id FROM sales WHERE code = ?').get(venda.json.code).id;
  const det = (await comoAgente('GET', `/api/vendas/${id}`)).json;
  const troca = await comoAgente('POST', `/api/sales/${id}/troca`, { devolver: [{ item_id: det.itens[0].id, qty: 1 }],
    levar: [{ variant_id: b.id, qty: 1 }], forma: 'Pix' });
  assert.equal(troca.status, 200, String(troca.bytes));
  assert.equal(s.banco().prepare('SELECT feito_por FROM trocas ORDER BY id DESC LIMIT 1').get().feito_por, 'Claude');
  const canc = await comoAgente('POST', `/api/sales/${id}/cancelar`, { motivo: 'teste do agente', forma: 'Pix' });
  assert.equal(canc.status, 200, String(canc.bytes));
  assert.equal(s.banco().prepare('SELECT payment_status FROM sales WHERE id = ?').get(id).payment_status, 'cancelado');
  assert.equal((await comoAgente('POST', '/api/connection/testar-escrita')).status === 403, false);

  // O dono vê o que ele alterou, com o que mandou.
  const st = (await dono('GET', '/api/agente/status')).json;
  const cancelou = st.alteracoes.find((l) => l.caminho === `/api/sales/${id}/cancelar`);
  assert.ok(cancelou);
  assert.equal(cancelou.status, 200);
  assert.match(cancelou.detalhe, /teste do agente/);
  assert.ok(st.alteracoes.every((l) => l.metodo !== 'GET'));
});

test('PIN e senha que o agente manda não ficam escritos no registro', async () => {
  await comoAgente('POST', '/api/login', { password: 'senha-que-nao-pode-aparecer' });
  const st = (await dono('GET', '/api/agente/status')).json;
  const login = st.alteracoes.find((l) => l.caminho === '/api/login');
  assert.ok(login);
  assert.doesNotMatch(login.detalhe, /senha-que-nao-pode-aparecer/);
  assert.match(login.detalhe, /\*\*\*/);
});

test('nem com acesso total: a chave, a cópia do banco e a ligação com a Nuvemshop', async () => {
  const recusar = [
    ['POST', '/api/agente/chave'], ['DELETE', '/api/agente/chave'], ['POST', '/api/agente/nivel'],
    ['GET', '/api/backup/baixar'], ['GET', '/API/Backup/Baixar/'], ['GET', '/api/backup/baixar?x=1'],
    ['POST', '/api/connect/app'], ['POST', '/api/disconnect'], ['POST', '/api/disconnect/'], ['POST', '/API/Disconnect'], ['POST', '/api/%64isconnect'], ['POST', '/api//disconnect'],
    ['GET', '/oauth/callback'],
  ];
  // Um jeito diferente de escrever o caminho não pode passar: ou é recusado,
  // ou nem chega na rota (404) — e a loja continua ligada.
  const ligacao = () => s.banco().prepare("SELECT value FROM settings WHERE key = 'nuvemshop_store_id'").get()?.value ?? 'nunca gravado';
  const antes = ligacao();
  for (const [m, c] of recusar) {
    const st = (await comoAgente(m, c, m === 'GET' ? null : {})).status;
    assert.ok(st === 403 || st === 404, `${m} ${c} → ${st}`);
  }
  assert.equal(ligacao(), antes);   // "desligar" grava vazio: não gravou
  assert.equal((await dono('GET', '/api/agente/status')).json.nivel, 'total');   // nada disso mudou o nível
});

test('chave nova volta a só consultar; o dono desliga quando quiser', async () => {
  await dono('POST', '/api/agente/nivel', { nivel: 'leitura' });
  assert.equal((await comoAgente('POST', '/api/sales', { items: [{ variant_id: await umaVariante(), qty: 1 }] })).status, 403);
  await dono('POST', '/api/agente/nivel', { nivel: 'total' });
  chave = (await dono('POST', '/api/agente/chave')).json.chave;
  assert.equal((await dono('GET', '/api/agente/status')).json.nivel, 'leitura');
  assert.equal((await comoAgente('POST', '/api/sales', { items: [{ variant_id: await umaVariante(), qty: 1 }] })).status, 403);
  assert.equal((await dono('POST', '/api/agente/nivel', { nivel: 'tudo' })).status, 400);
});
