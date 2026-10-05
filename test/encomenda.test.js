// Na loja × sob encomenda: o valor do estoque conta só o que está na loja;
// a grade do site é para não perder venda. Venda do site tira o par da loja
// quando ele estava aqui, vira "pegar no fornecedor" quando não estava, e
// o número vendido volta para o site sozinho.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { subirServidor } from './servidor.js';

const LOJA = '123';
const TENIS = { id: 10, name: { pt: 'Tênis' }, parent: null };
const BONES = { id: 20, name: { pt: 'Bonés' }, parent: null };
const variacao = (id, nome, estoque) => ({ id, values: [{ pt: nome }], price: '500.00', sku: '', stock: estoque, stock_management: true });
const loja = {
  produtos: [
    { id: 100, name: { pt: 'Tênis Gucci' }, published: true, categories: [TENIS], images: [],
      variants: [variacao(1001, '38', 1), variacao(1002, '39', 1), variacao(1003, '40', 1)] },
    { id: 200, name: { pt: 'Boné Lacoste' }, published: true, categories: [BONES], images: [],
      variants: [variacao(2001, 'Único', 1)] },
  ],
  pedidos: [],
  falharEstoque: 0,   // quantos PUT de variação seguidos a loja recusa
};
const daLoja = (vid) => loja.produtos.flatMap((p) => p.variants).find((v) => v.id === vid);
const pedido = (id, quando, itens, extra = {}) => ({
  id, number: id, created_at: quando, status: 'open', payment_status: 'paid', shipping_status: 'delivered',
  total: String(itens.length * 500), gateway: 'pix', customer: { id: 9, name: 'Cliente Teste' },
  products: itens.map((vid) => ({ product_id: Math.floor(vid / 10), variant_id: vid, quantity: 1, price: '500.00', name: `Peça ${vid}` })),
  ...extra,
});

let nuvem, s;
before(async () => {
  nuvem = http.createServer((req, res) => {
    let corpo = '';
    req.on('data', (c) => { corpo += c; });
    req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    const [l, recurso, pid, sub, vid] = url.pathname.split('/').filter(Boolean);
    const json = (d, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };
    const primeira = url.searchParams.get('page') === '1';
    const body = corpo ? JSON.parse(corpo) : {};
    if (l !== LOJA) { res.writeHead(404); return res.end('{}'); }
    if (recurso === 'products' && sub === 'variants') {
      const v = daLoja(Number(vid));
      if (req.method === 'PUT') {
        if (loja.falharEstoque > 0) { loja.falharEstoque -= 1; return json({ description: 'fora do ar' }, 503); }
        v.stock = body.stock;
      }
      return json(v);
    }
    if (recurso === 'products' && pid) {
      const p = loja.produtos.find((x) => String(x.id) === pid);
      if (req.method === 'PUT' && body.name) p.name = body.name;
      return json(p);
    }
    if (recurso === 'products') return json(primeira ? loja.produtos : []);
    if (recurso === 'categories') return json(primeira ? [TENIS, BONES] : []);
    if (recurso === 'orders') return json(primeira ? loja.pedidos : []);
    return json([]);
    });
  });
  await new Promise((ok) => nuvem.listen(0, '127.0.0.1', ok));
  s = await subirServidor({
    NUVEMSHOP_STORE_ID: LOJA, NUVEMSHOP_ACCESS_TOKEN: 'token-de-teste',
    NUVEMSHOP_API_BASE: `http://127.0.0.1:${nuvem.address().port}`,
  });
  assert.equal((await s.pedir('POST', '/api/sync', { corpo: {} })).status, 200);
  await lerPedidos();   // primeira leitura: marca o início da baixa automática
});
after(() => { s?.parar(); nuvem?.close(); });

const lerPedidos = () => s.pedir('POST', '/api/import-customers', { corpo: { days: 90 } });
const resumo = async () => (await s.pedir('GET', '/api/catalog/summary')).json;
const aqui = (nsId) => s.banco().prepare('SELECT * FROM variants WHERE nuvemshop_variant_id = ?').get(String(nsId));
const lembretes = () => s.banco().prepare("SELECT title FROM reminders WHERE kind = 'encomenda' ORDER BY id").all().map((r) => r.title);

test('marcar a categoria: o estoque passa a contar só o que está na loja', async () => {
  assert.equal((await resumo()).real.units, 4);
  const tenis = (await s.pedir('GET', '/api/catalog?category=T%C3%AAnis&modo=proprio')).json;
  const r = await s.pedir('POST', '/api/encomenda/marcar', { corpo: { product_ids: tenis.map((p) => p.id) } });
  assert.equal(r.json.marcados, 1);
  const depois = await resumo();
  assert.equal(depois.real.units, 1);          // só o boné
  assert.equal(depois.encomenda.units, 3);     // a grade do tênis no site
});

test('conferir: tocar no número que está na loja', async () => {
  const r = await s.pedir('POST', '/api/encomenda/maos', { corpo: { itens: [
    { variant_id: aqui(1001).id, on_hand: 1 },
    { variant_id: aqui(2001).id, on_hand: 5 },   // boné é estoque próprio: não se mexe aqui
  ] } });
  assert.deepEqual([r.json.salvos, r.json.ignorados], [1, 1]);
  assert.equal((await resumo()).real.units, 2);
  const enc = (await s.pedir('GET', '/api/encomenda')).json;
  assert.equal(enc.resumo.pares_na_loja, 1);
  assert.deepEqual(enc.produtos[0].variants.map((v) => v.on_hand), [1, 0, 0]);
});

test('venda do site: o par da loja sai; o que não estava vira "pegar no fornecedor"', async () => {
  loja.pedidos.push(pedido(1, new Date().toISOString(), [1001, 1003]));
  daLoja(1001).stock = 0; daLoja(1003).stock = 0;   // a loja baixou a grade
  await lerPedidos();
  assert.equal(aqui(1001).on_hand, 0);
  assert.deepEqual(lembretes(), ['Pegar no fornecedor: Tênis Gucci 40']);
  // E os números vendidos voltam para o site, para não perder a próxima venda.
  assert.equal(daLoja(1001).stock, 1);
  assert.equal(daLoja(1003).stock, 1);
  assert.equal(aqui(1001).stock, 1);
  const itens = s.banco().prepare("SELECT encomenda FROM sale_items i JOIN sales s ON s.id = i.sale_id WHERE s.code = 'SITE-1' ORDER BY i.id").all();
  assert.deepEqual(itens.map((i) => i.encomenda), [0, 1]);
  await lerPedidos();                                // ler de novo não baixa de novo
  assert.equal(lembretes().length, 1);
});

test('pedido cancelado: o par volta para a loja', async () => {
  loja.pedidos[0].status = 'cancelled';
  await lerPedidos();
  assert.equal(aqui(1001).on_hand, 1);
  assert.equal(s.banco().prepare("SELECT estoque_baixado FROM sales WHERE code = 'SITE-1'").get().estoque_baixado, 2);
});

test('pedido antigo relido não mexe na loja de hoje', async () => {
  loja.pedidos.push(pedido(2, new Date(Date.now() - 30 * 864e5).toISOString(), [1001]));
  await lerPedidos();
  assert.equal(aqui(1001).on_hand, 1);
  assert.equal(lembretes().length, 1);
});

test('loja fora do ar: o número volta na rodada seguinte, mesmo editando o produto no meio', async () => {
  loja.pedidos.push(pedido(4, new Date().toISOString(), [1002]));
  daLoja(1002).stock = 0;
  loja.falharEstoque = 1;
  await lerPedidos();
  assert.equal(daLoja(1002).stock, 0);
  assert.equal(aqui(1002).repor_site, 1);
  // Editar o nome agora (o 39 aparece zerado aqui) não pode cancelar a volta.
  const p = aqui(1002).product_id;
  const vs = s.banco().prepare('SELECT * FROM variants WHERE product_id = ? ORDER BY id').all(p);
  const r = await s.pedir('PUT', `/api/catalog/${p}`, { corpo: { name: 'Tênis Gucci Novo', on_demand: 1,
    variants: vs.map((v) => ({ id: v.id, variant_name: v.variant_name, price: v.price, cost: v.cost, stock: v.stock, on_hand: v.on_hand })) } });
  assert.equal(r.status, 200);
  assert.equal(aqui(1002).grade_alvo, 1);
  await lerPedidos();
  assert.equal(daLoja(1002).stock, 1);
  assert.equal(aqui(1002).repor_site, 0);
});

test('número tirado do site pelo painel não volta sozinho', async () => {
  daLoja(1003).stock = 0;                            // você tirou o 40 na Nuvemshop
  await s.pedir('POST', '/api/sync', { corpo: {} });
  await lerPedidos();
  assert.equal(daLoja(1003).stock, 0);
});

test('estoque próprio vendido no site: o número daqui é relido da loja', async () => {
  loja.pedidos.push(pedido(3, new Date().toISOString(), [2001]));
  daLoja(2001).stock = 0;
  await lerPedidos();
  assert.equal(aqui(2001).stock, 0);
  assert.equal(aqui(2001).on_hand, 0);
});
