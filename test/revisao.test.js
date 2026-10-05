// O que a revisão com os dados reais da loja corrigiu: milhares de produtos
// esgotados não podem atrapalhar o PDV, o Estoque e os Custos; lucro sem
// custo não pode aparecer como 100%; venda de balcão não recebe aviso de
// pedido; e o Canvas separa balcão de site.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { subirServidor } from './servidor.js';

const LOJA = '123';
const produto = (id, nome, vid, estoque) => ({
  id, name: { pt: nome }, published: true, categories: [], images: [],
  variants: [{ id: vid, values: [{ pt: 'Único' }], price: '100.00', sku: '', stock: estoque, stock_management: true }],
});
const produtos = [produto(100, 'Boné Na Loja', 1001, 3), produto(200, 'Boné Esgotado Antigo', 2001, 0), produto(300, 'Jaqueta Vendida', 3001, 0)];
const agora = new Date().toISOString();
const pedido = (id, storefront, vid) => ({
  id, number: id, created_at: agora, status: 'open', payment_status: 'paid', shipping_status: 'delivered',
  shipping_pickup_details: storefront === 'pos' ? {} : undefined,
  total: '100.00', gateway: 'pix', storefront, customer: { id: 10 + id, name: `Cliente ${id}`, phone: `+55119999900${id}` },
  products: [{ product_id: Math.floor(vid / 10), variant_id: vid, quantity: 1, price: '100.00', name: `Peça ${vid}` }],
});
const pedidos = [pedido(1, 'pos', 1001), pedido(2, 'store', 3001)];

let nuvem, s;
const get = async (c) => (await s.pedir('GET', c)).json;
before(async () => {
  nuvem = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const [, recurso] = url.pathname.split('/').filter(Boolean);
    const p1 = url.searchParams.get('page') === '1';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(recurso === 'products' ? (p1 ? produtos : []) : recurso === 'orders' ? (p1 ? pedidos : []) : []));
  });
  await new Promise((ok) => nuvem.listen(0, '127.0.0.1', ok));
  s = await subirServidor({
    NUVEMSHOP_STORE_ID: LOJA, NUVEMSHOP_ACCESS_TOKEN: 'token-de-teste',
    NUVEMSHOP_API_BASE: `http://127.0.0.1:${nuvem.address().port}`,
  });
  // Catálogo completo, esgotados inclusive — como a loja real ficou.
  await s.pedir('POST', '/api/sync', { corpo: { only_available: false } });
  await s.pedir('POST', '/api/import-customers', { corpo: { days: 30 } });
});
after(() => { s?.parar(); nuvem?.close(); });

test('PDV mostra o que dá para vender; buscando, o esgotado vem no fim', async () => {
  assert.deepEqual((await get('/api/products')).map((v) => v.product_name), ['Boné Na Loja']);
  const busca = (await get('/api/products?q=Bon%C3%A9')).map((v) => v.product_name);
  assert.deepEqual(busca, ['Boné Na Loja', 'Boné Esgotado Antigo']);
});

test('Estoque separa com estoque de esgotados', async () => {
  const com = (await get('/api/catalog?estoque=com')).map((p) => p.name);
  assert.deepEqual(com, ['Boné Na Loja']);
  const esg = (await get('/api/catalog?estoque=esgotados')).map((p) => p.name).sort();
  assert.deepEqual(esg, ['Boné Esgotado Antigo', 'Jaqueta Vendida']);
});

test('Custos: primeiro o que está na loja ou vendeu; esgotado parado só pedindo', async () => {
  const c = await get('/api/custos?falta=1');
  assert.deepEqual(c.variantes.map((v) => v.product_name).sort(), ['Boné Na Loja', 'Jaqueta Vendida']);
  assert.equal(c.resumo.sem_custo, 2);
  const tudo = await get('/api/custos?falta=1&tudo=1');
  assert.equal(tudo.variantes.length, 3);
});

test('sem custo cadastrado, a tela sabe que o lucro não é real', async () => {
  assert.equal((await get('/api/dashboard')).custo_cobertura, 0);
  assert.equal((await get('/api/financial')).custo_cobertura, 0);
  const v = (await get('/api/custos?falta=1')).variantes.find((x) => x.product_name === 'Boné Na Loja');
  await s.pedir('POST', '/api/custos', { corpo: { itens: [{ variant_id: v.id, cost: 40 }] } });
  assert.equal((await get('/api/relatorios?days=7')).totais.custo_cobertura, 0.5);   // 1 das 2 vendas tem custo
});

test('venda de balcão não recebe "seu pedido foi pago"', async () => {
  await s.pedir('POST', '/api/mensagens/atualizar', { corpo: {} });
  const m = await get('/api/mensagens?status=pendente');
  const pedidosAvisados = m.linhas.filter((x) => x.tipo === 'pedido').map((x) => x.corpo).join(' ');
  assert.match(pedidosAvisados, /SITE-2/);
  assert.doesNotMatch(pedidosAvisados, /SITE-1\b/);
});

test('Canvas separa balcão de site', async () => {
  const c = await get('/api/canvas');
  const receitas = c.blocos.find((b) => b.id === 'receitas').real;
  assert.match(receitas, /Balcão: R\$ 100,00 \(50%\)/);
  assert.match(receitas, /Site: R\$ 100,00 \(50%\)/);
});
