// Cada vendedor entra com o próprio PIN: a venda fica com ele (é o que
// faz a comissão ser dele), e ele não vê financeiro nem cancela venda.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { subirServidor } from './servidor.js';

const SENHA = 'senha-do-dono';
let s, dono, ana, bruno, sessaoAna;

const cookieDe = (r, nome) => r.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith(nome + '=') && c.length > nome.length + 1);
const comoDono = (m, c, corpo) => s.pedir(m, c, { corpo, headers: { Cookie: dono } });
const comoAna = (m, c, corpo, ck = sessaoAna) => s.pedir(m, c, { corpo, headers: { Cookie: ck } });
const umaVariante = async (nome) => (await comoDono('GET', '/api/products')).json.find((v) => v.product_name.startsWith(nome));

before(async () => {
  s = await subirServidor({ APP_PASSWORD: SENHA });
  dono = cookieDe(await s.pedir('POST', '/api/login', { corpo: { password: SENHA } }), 'vn_auth');
  ana = (await comoDono('POST', '/api/team', { name: 'Ana Souza', pin: '2468', commission_pct: 5 })).json.membro;
  bruno = (await comoDono('POST', '/api/team', { name: 'Bruno Lima', pin: '1357', commission_pct: 3 })).json.membro;
});
after(() => s?.parar());

test('a tela de entrar mostra só o primeiro nome, e o PIN nunca sai do servidor', async () => {
  const vs = (await s.pedir('GET', '/api/login/vendedores')).json;
  assert.deepEqual(vs.map((v) => v.nome), ['Ana', 'Bruno']);
  const equipe = (await comoDono('GET', '/api/team')).json.membros;
  assert.ok(equipe.every((m) => m.tem_pin === true && !('pin_hash' in m)));
});

test('PIN errado não entra; o certo entra como vendedor', async () => {
  assert.equal((await s.pedir('POST', '/api/login/vendedor', { corpo: { id: ana.id, pin: '0000' } })).status, 401);
  const r = await s.pedir('POST', '/api/login/vendedor', { corpo: { id: ana.id, pin: '2468' } });
  assert.equal(r.status, 200);
  sessaoAna = cookieDe(r, 'vn_vend');
  assert.ok(sessaoAna);
  assert.deepEqual((await comoAna('GET', '/api/eu')).json, { papel: 'vendedor', id: ana.id, nome: 'Ana Souza' });
});

test('o vendedor não vê financeiro, custo, equipe nem configuração', async () => {
  for (const c of ['/api/dashboard', '/api/financial', '/api/custos', '/api/team', '/api/caixa', '/api/connection']) {
    assert.equal((await comoAna('GET', c)).status, 403, c);
  }
  // Página do dono manda de volta para o PDV.
  const inicio = await comoAna('GET', '/');
  assert.match(inicio.bytes.toString(), /id="cartTit"/);
  assert.equal((await comoAna('GET', '/pdv')).status, 200);
});

let venda;
test('a venda é de quem está logado, com o canal escolhido', async () => {
  const v = await umaVariante('Camiseta');
  // Mesmo mandando outro vendedor, a venda fica com a Ana.
  const r = await comoAna('POST', '/api/sales', { items: [{ variant_id: v.id, qty: 1 }], payment_method: 'Pix',
    seller_id: bruno.id, canal: 'whatsapp' });
  assert.equal(r.status, 200);
  venda = s.banco().prepare('SELECT * FROM sales WHERE code = ?').get(r.json.code);
  assert.equal(venda.seller_id, ana.id);
  assert.equal(venda.canal, 'whatsapp');
  // O Financeiro separa a venda pela internet do balcão e do site —
  // com uma de cada, para não somar as duas no mesmo lugar.
  await comoDono('POST', '/api/sales', { items: [{ variant_id: v.id, qty: 1 }], payment_method: 'Pix', canal: 'balcao' });
  const fin = (await comoDono('GET', '/api/financial?period=month')).json;
  const por = Object.fromEntries(fin.por_origem.map((o) => [o.origem, o.n]));
  assert.deepEqual(por, { Internet: 1, PDV: 1 });
});

test('o vendedor troca, mas cancelar é só do dono', async () => {
  assert.equal((await comoAna('POST', `/api/sales/${venda.id}/cancelar`, {})).status, 403);
  const det = (await comoAna('GET', `/api/vendas/${venda.id}`)).json;
  const t = await comoAna('POST', `/api/sales/${venda.id}/troca`, { devolver: [{ item_id: det.itens[0].id, qty: 1 }], forma: 'Pix' });
  assert.equal(t.status, 200);
  assert.equal(s.banco().prepare('SELECT feito_por FROM trocas WHERE sale_id = ?').get(venda.id).feito_por, 'Ana Souza');
});

test('trocar o PIN derruba a sessão antiga', async () => {
  await comoDono('POST', '/api/team', { id: ana.id, name: 'Ana Souza', pin: '9999' });
  assert.equal((await comoAna('GET', '/api/eu')).status, 401);
});

test('cinco PINs errados travam a pessoa', async () => {
  for (let i = 0; i < 5; i++) await s.pedir('POST', '/api/login/vendedor', { corpo: { id: bruno.id, pin: '0000' } });
  const r = await s.pedir('POST', '/api/login/vendedor', { corpo: { id: bruno.id, pin: '1357' } });
  assert.equal(r.status, 429);
});
