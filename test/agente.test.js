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
  for (const caminho of ['/api/backup/baixar', '/api/connection', '/conectar']) {
    assert.equal((await comoAgente('GET', caminho)).status, 403, caminho);
  }
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
