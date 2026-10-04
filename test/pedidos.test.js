// Pedidos do site: as peças entram junto (e o sistema passa a saber o que
// vende), o custo cadastrado depois preenche as vendas que ficaram sem, o
// "acabando" olha o produto que vende, e as filas só mostram o que é atual.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { subirServidor } from './servidor.js';

const LOJA = '123';
const diasAtras = (d) => new Date(Date.now() - d * 864e5).toISOString();
const produto = (id, nome, vid, estoque) => ({
  id, name: { pt: nome }, description: { pt: '' }, published: true, categories: [], images: [],
  variants: [{ id: vid, values: [{ pt: 'Único' }], price: '100.00', sku: '', stock: estoque, stock_management: true }],
});
const produtos = [
  produto(100, 'Tênis Que Vende', 1001, 2),     // vende e tem 2: acabando
  produto(200, 'Boné Parado', 2001, 2),         // tem 2 mas não vende: não é urgente
  produto(300, 'Camiseta Cheia', 3001, 10),     // vende mas tem bastante
];
const pedido = (id, quando, pago, envio, itens) => ({
  id, number: id, created_at: quando, status: 'open',
  payment_status: pago ? 'paid' : 'pending', shipping_status: envio,
  total: String(itens.reduce((s, [, q, p]) => s + q * p, 0)), gateway: 'pix',
  customer: { id: 9, name: 'Cliente Teste', email: 'cliente@teste.com' },
  products: itens.map(([vid, quantity, price]) => ({
    product_id: Math.floor(vid / 10), variant_id: vid, quantity, price: String(price), name: `Peça ${vid}` })),
});
const pedidos = [
  pedido(1, diasAtras(2), true, 'unpacked', [[1001, 1, 300], [3001, 2, 100]]),   // atual, por embalar
  // Dois produtos que esgotaram e não estão no catálogo daqui.
  pedido(5, diasAtras(3), true, 'delivered', [[9001, 1, 80], [9011, 1, 90]]),
  pedido(2, diasAtras(60), true, 'unpacked', [[3001, 1, 100]]),                   // velho: fora da fila
  pedido(3, diasAtras(1), false, 'unpacked', [[3001, 1, 200]]),                   // pix de ontem
  pedido(4, diasAtras(20), false, 'unpacked', [[3001, 1, 150]]),                  // pix abandonado
];

let nuvem, s;
before(async () => {
  nuvem = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const [loja, recurso] = url.pathname.split('/').filter(Boolean);
    const json = (d) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };
    const primeira = url.searchParams.get('page') === '1';
    if (loja !== LOJA) { res.writeHead(404); return res.end('{}'); }
    if (recurso === 'products') return json(primeira ? produtos : []);
    if (recurso === 'orders') return json(primeira ? pedidos : []);
    return json([]);   // categorias, clientes, carrinhos
  });
  await new Promise((ok) => nuvem.listen(0, '127.0.0.1', ok));
  s = await subirServidor({
    NUVEMSHOP_STORE_ID: LOJA, NUVEMSHOP_ACCESS_TOKEN: 'token-de-teste',
    NUVEMSHOP_API_BASE: `http://127.0.0.1:${nuvem.address().port}`,
  });
  assert.equal((await s.pedir('POST', '/api/sync', { corpo: {} })).status, 200);
  assert.equal((await s.pedir('POST', '/api/import-customers', { corpo: { days: 90 } })).status, 200);
});
after(() => { s?.parar(); nuvem?.close(); });

const variante = (nsId) => s.banco().prepare('SELECT id FROM variants WHERE nuvemshop_variant_id = ?').get(String(nsId)).id;
const venda = (code) => s.banco().prepare('SELECT * FROM sales WHERE code = ?').get(code);
const itensDa = (code) => s.banco().prepare('SELECT * FROM sale_items WHERE sale_id = ? ORDER BY id').all(venda(code).id);

test('o pedido do site chega com as peças, ligadas às variações daqui', async () => {
  const itens = itensDa('SITE-1');
  assert.equal(itens.length, 2);
  assert.deepEqual(itens.map((i) => [i.variant_id, i.qty, i.unit_price]), [[variante(1001), 1, 300], [variante(3001), 2, 100]]);
  // Ler a loja de novo não duplica.
  await s.pedir('POST', '/api/import-customers', { corpo: { days: 90 } });
  assert.equal(itensDa('SITE-1').length, 2);
  const rel = (await s.pedir('GET', '/api/relatorios?days=90')).json;
  assert.equal(rel.totais.pecas, 6);   // pedidos pagos (1, 2 e 5); pix pendente não conta
  // Produto esgotado (fora do catálogo daqui) tem a sua linha, não vira um bolo só.
  assert.ok(rel.produtos.some((p) => p.produto === 'Peça 9001'));
  assert.ok(rel.produtos.some((p) => p.produto === 'Peça 9011'));
});

test('"acabando" é o produto que vende e tem pouca peça', async () => {
  const d = (await s.pedir('GET', '/api/dashboard')).json;
  assert.equal(d.low_stock, 1);
  assert.equal(d.low_stock_list[0].product_name, 'Tênis Que Vende');
  const cat = (await s.pedir('GET', '/api/catalog')).json;
  const flag = Object.fromEntries(cat.map((p) => [p.name, p.acabando]));
  assert.deepEqual(flag, { 'Boné Parado': false, 'Camiseta Cheia': false, 'Tênis Que Vende': true });
});

test('as filas mostram só o que é atual', async () => {
  const { filas } = (await s.pedir('GET', '/api/operacao')).json;
  assert.equal(filas.por_embalar.n, 1);      // o de 60 dias não entra
  assert.equal(filas.aguardando_pix.n, 1);   // o de 20 dias é pagamento abandonado
  const lista = (await s.pedir('GET', '/api/operacao/por_embalar')).json;
  assert.deepEqual(lista.map((p) => p.code), ['SITE-1']);
});

test('custo cadastrado depois preenche as vendas que ficaram sem', async () => {
  assert.equal(venda('SITE-1').margin, 500);   // sem custo: tudo parece lucro
  const r = await s.pedir('POST', '/api/custos', { corpo: { itens: [{ variant_id: variante(1001), cost: 120 }] } });
  assert.equal(r.json.vendas_com_custo, 1);
  assert.equal(venda('SITE-1').cost_total, 120);
  assert.equal(venda('SITE-1').margin, 380);

  // Mudar o custo de novo não reescreve o passado.
  await s.pedir('POST', '/api/custos', { corpo: { itens: [{ variant_id: variante(1001), cost: 150 }] } });
  assert.equal(venda('SITE-1').margin, 380);
  // E ler a loja de novo não apaga o custo da venda.
  await s.pedir('POST', '/api/import-customers', { corpo: { days: 90 } });
  assert.equal(venda('SITE-1').margin, 380);
});
