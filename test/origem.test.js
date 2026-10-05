// Balcão ou site: o PDV da Nuvemshop também vira pedido lá, e não pode
// aparecer como venda do site — nem na receita, nem nas filas de envio.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { subirServidor } from './servidor.js';

const LOJA = '123';
const pedido = (id, storefront, extra = {}) => ({
  id, number: id, created_at: new Date().toISOString(), status: 'open', payment_status: 'paid',
  shipping_status: 'unpacked', total: '100.00', gateway: 'pix', customer: { id: 9, name: 'Cliente Teste' },
  products: [], ...(storefront ? { storefront } : {}), ...extra,
});
const pedidos = [
  pedido(1, 'store'),                       // loja online
  pedido(2, 'pos', { gateway: 'cash' }),    // PDV da Nuvemshop, no balcão
  pedido(3, null),                          // sem a informação: fica como site
  pedido(4, 'store'),                       // vai ser corrigido para balcão
];

let nuvem, s;
const lerPedidos = () => s.pedir('POST', '/api/import-customers', { corpo: { days: 30 } });
before(async () => {
  nuvem = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const [l, recurso] = url.pathname.split('/').filter(Boolean);
    res.writeHead(l === LOJA ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(recurso === 'orders' && url.searchParams.get('page') === '1' ? pedidos : []));
  });
  await new Promise((ok) => nuvem.listen(0, '127.0.0.1', ok));
  s = await subirServidor({
    NUVEMSHOP_STORE_ID: LOJA, NUVEMSHOP_ACCESS_TOKEN: 'token-de-teste',
    NUVEMSHOP_API_BASE: `http://127.0.0.1:${nuvem.address().port}`,
  });
  assert.equal((await lerPedidos()).status, 200);
});
after(() => { s?.parar(); nuvem?.close(); });

const origem = (code) => s.banco().prepare('SELECT origem FROM sales WHERE code = ?').get(code).origem;
const receita = (code) => s.banco().prepare("SELECT category, description FROM financial_entries WHERE type = 'receita' AND ref = ?").get(code);

test('cada pedido sabe se veio do balcão ou do site', () => {
  assert.deepEqual(['SITE-1', 'SITE-2', 'SITE-3'].map(origem), ['site', 'balcao', 'site']);
  assert.deepEqual(receita('SITE-2'), { category: 'Venda Balcão Nuvemshop', description: 'Venda no balcão (PDV Nuvemshop) SITE-2' });
  assert.equal(receita('SITE-1').category, 'Venda Site');
});

test('"de onde vem a receita" separa o balcão do site', async () => {
  const f = (await s.pedir('GET', '/api/financial')).json;
  const por = Object.fromEntries(f.por_origem.map((o) => [o.origem, o.n]));
  assert.deepEqual(por, { Site: 3, 'PDV Nuvemshop': 1 });
  const d = (await s.pedir('GET', '/api/dashboard')).json;
  const hoje = Object.fromEntries(d.por_origem_hoje.map((o) => [o.o, o.n]));
  assert.deepEqual(hoje, { site: 3, pdv: 1 });
});

test('venda de balcão não entra na fila de embalar', async () => {
  const lista = (await s.pedir('GET', '/api/operacao/por_embalar')).json.map((p) => p.code).sort();
  assert.deepEqual(lista, ['SITE-1', 'SITE-3', 'SITE-4']);
});

test('quando a origem muda, a receita já lançada muda de categoria', async () => {
  pedidos[3].storefront = 'pos';
  await lerPedidos();
  assert.equal(origem('SITE-4'), 'balcao');
  assert.equal(receita('SITE-4').category, 'Venda Balcão Nuvemshop');
  assert.equal(s.banco().prepare("SELECT COUNT(*) n FROM financial_entries WHERE ref = 'SITE-4'").get().n, 1);
});
