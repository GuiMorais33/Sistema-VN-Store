// Venda lançada depois de acontecer (o caderno do dia, a venda de ontem
// que ficou para trás): ela tem que cair no dia em que aconteceu — caixa,
// meta e comissão daquele dia —, e o estoque baixa na hora em que é lançada.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { subirServidor } from './servidor.js';

const SENHA = 'senha-do-dono';
let s, dono, sessaoAna, ana;
const cookieDe = (r, nome) => r.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith(nome + '=') && c.length > nome.length + 1);
const comoDono = (m, c, corpo) => s.pedir(m, c, { corpo, headers: { Cookie: dono } });

// Dia no fuso da loja, como o servidor calcula.
const diaDaLoja = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(d));
const diasAtras = (n) => diaDaLoja(Date.now() - n * 864e5);
const horaDaLoja = (d) => new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }).format(new Date(d));

let variante;
before(async () => {
  s = await subirServidor({ APP_PASSWORD: SENHA });
  dono = cookieDe(await s.pedir('POST', '/api/login', { corpo: { password: SENHA } }), 'vn_auth');
  ana = (await comoDono('POST', '/api/team', { name: 'Ana Souza', pin: '2468', commission_pct: 5 })).json.membro;
  sessaoAna = cookieDe(await s.pedir('POST', '/api/login/vendedor', { corpo: { id: ana.id, pin: '2468' } }), 'vn_vend');
  // A que tem mais peças: o teste vende várias vezes a mesma.
  variante = (await comoDono('GET', '/api/products')).json.filter((v) => v.stock_management).sort((a, b) => b.stock - a.stock)[0];
  assert.ok(variante.stock >= 7, 'precisa de 7 peças');
});
after(() => s?.parar());

const vender = (corpo) => comoDono('POST', '/api/sales', { items: [{ variant_id: variante.id, qty: 1 }], payment_method: 'Pix', ...corpo });
const venda = (code) => s.banco().prepare('SELECT * FROM sales WHERE code = ?').get(code);
const entrada = (code) => s.banco().prepare("SELECT * FROM financial_entries WHERE ref = ? AND description LIKE 'Venda PDV%'").get(code);
const estoque = () => s.banco().prepare('SELECT stock, updated_at FROM variants WHERE id = ?').get(variante.id);

test('venda de ontem: caixa, venda e meta de ontem; estoque baixa agora', async () => {
  const ontem = diasAtras(1);
  const antes = estoque().stock;
  const comecou = new Date().toISOString();
  const caixaHojeAntes = (await comoDono('GET', '/api/dashboard')).json.revenue_today;
  const r = await vender({ data: ontem, seller_id: ana.id });
  assert.equal(r.status, 200, String(r.bytes));
  assert.equal(r.json.data, ontem);
  const v = venda(r.json.code);
  assert.equal(diaDaLoja(v.created_at), ontem);
  assert.equal(diaDaLoja(v.paid_at), ontem);
  assert.equal(diaDaLoja(entrada(r.json.code).created_at), ontem);
  // Hoje não muda; o caixa de ontem tem o Pix.
  assert.equal((await comoDono('GET', '/api/dashboard')).json.revenue_today, caixaHojeAntes);
  const cx = (await comoDono('GET', `/api/caixa?day=${ontem}`)).json;
  assert.ok(cx.por_forma.some((f) => /pix/i.test(f.forma) && f.total >= variante.price), JSON.stringify(cx.por_forma));
  // O atendimento (funil da vendedora) também é de ontem.
  const at = s.banco().prepare('SELECT day FROM atendimentos WHERE sale_id = ?').get(v.id);
  assert.equal(at.day, ontem);
  // Estoque: baixou agora, e a hora da mudança é a de agora (o vigia da
  // releitura da loja depende disso).
  assert.equal(estoque().stock, antes - 1);
  assert.ok(estoque().updated_at >= comecou);
});

test('sem data, ou com a de hoje, é venda de agora', async () => {
  const r1 = await vender({});
  const r2 = await vender({ data: diaDaLoja(Date.now()) });
  for (const r of [r1, r2]) {
    assert.equal(r.status, 200);
    assert.ok(Date.now() - new Date(venda(r.json.code).created_at).getTime() < 60e3);
  }
});

test('data no futuro, muito antiga ou que não existe: não lança', async () => {
  const antes = s.banco().prepare('SELECT COUNT(*) n FROM sales').get().n;
  for (const data of [diaDaLoja(Date.now() + 2 * 864e5), diasAtras(120), '2026-02-30', 'ontem']) {
    const r = await vender({ data });
    assert.equal(r.status, 400, `${data}: ${r.bytes}`);
  }
  assert.equal(s.banco().prepare('SELECT COUNT(*) n FROM sales').get().n, antes);
});

test('o caixa daquele dia já estava fechado: lança e avisa', async () => {
  const dia = diasAtras(3);
  assert.equal((await comoDono('POST', '/api/caixa/fechar', { day: dia, contado: 0 })).status, 200);
  const r = await vender({ data: dia });
  assert.equal(r.status, 200);
  assert.equal(r.json.caixa_fechado, true);
  assert.equal((await vender({ data: diasAtras(4) })).json.caixa_fechado, false);
});

test('vendedor com PIN não lança venda de outro dia', async () => {
  const r = await s.pedir('POST', '/api/sales', { corpo: { items: [{ variant_id: variante.id, qty: 1 }], payment_method: 'Pix',
    data: diasAtras(1) }, headers: { Cookie: sessaoAna } });
  assert.equal(r.status, 403);
});

test('lançou no dia errado: corrige a data, a hora fica, o dinheiro vai junto', async () => {
  const r = await vender({});
  const v = venda(r.json.code);
  const dia = diasAtras(2);
  const c = await comoDono('POST', `/api/sales/${v.id}/vendedor`, { data: dia });
  assert.equal(c.status, 200, String(c.bytes));
  const depois = venda(r.json.code);
  assert.equal(diaDaLoja(depois.created_at), dia);
  assert.equal(horaDaLoja(depois.created_at), horaDaLoja(v.created_at));
  assert.equal(depois.paid_at, depois.created_at);
  assert.equal(entrada(r.json.code).created_at, depois.created_at);
  // Para o futuro, não; venda cancelada, também não (lança de novo).
  assert.equal((await comoDono('POST', `/api/sales/${v.id}/vendedor`, { data: diaDaLoja(Date.now() + 864e5) })).status, 400);
  await comoDono('POST', `/api/sales/${v.id}/cancelar`, { motivo: 'teste', forma: 'Pix' });
  assert.equal((await comoDono('POST', `/api/sales/${v.id}/vendedor`, { data: diasAtras(1) })).status, 400);
});

test('últimas vendas lançadas: pela ordem em que entraram, e quantas hoje', async () => {
  const hojeAntes = (await comoDono('GET', '/api/vendas/ultimas')).json.hoje.n;
  const deHoje = await vender({});
  const deOntem = await vender({ data: diasAtras(1) });   // lançada agora, com data de ontem
  const r = (await comoDono('GET', '/api/vendas/ultimas?n=3')).json;
  assert.deepEqual(r.vendas.slice(0, 2).map((v) => v.code), [deOntem.json.code, deHoje.json.code]);
  assert.equal(r.hoje.n, hojeAntes + 1);                   // a de ontem não conta como de hoje
  // O vendedor com PIN também vê (é ele que procura a venda que lançou).
  const ana = await s.pedir('GET', '/api/vendas/ultimas', { headers: { Cookie: sessaoAna } });
  assert.equal(ana.status, 200);
});
