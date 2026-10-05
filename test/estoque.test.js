// Estoque entre o balcão e o site: a venda de um nunca pode desfazer a
// do outro. Sobe o servidor de verdade (banco temporário) contra uma
// Nuvemshop de mentira, que guarda o estoque "da loja" em memória.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { subirServidor } from './servidor.js';

const LOJA = '123';

// ---- A Nuvemshop de mentira ----
const loja = {
  produto: {
    id: 100, name: { pt: 'Camiseta' }, description: { pt: '' }, published: true,
    categories: [], images: [],
    variants: [{ id: 1001, values: [{ pt: 'M' }], price: '89.90', sku: '', stock: 5, stock_management: true }],
  },
  falharEstoque: 0,           // quantos PUT de variação seguidos devolvem erro
  statusFalha: 503,           // 503 = fora do ar · 403 = app sem permissão de escrita
  aplicaEstoqueNoProduto: true, // o PUT do produto mexe no estoque das variações?
};
const variante = () => loja.produto.variants[0];

function mock(req, res) {
  let corpo = '';
  req.on('data', (c) => { corpo += c; });
  req.on('end', () => {
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    const url = new URL(req.url, 'http://x');
    const partes = url.pathname.split('/').filter(Boolean);   // [123, products, 100, variants, 1001]
    if (partes[0] !== LOJA) return json(404, { description: 'loja' });
    const [, recurso, pid, sub, vid] = partes;
    const body = corpo ? JSON.parse(corpo) : {};
    const p = loja.produto;

    if (recurso === 'products' && !pid && req.method === 'GET') return json(200, url.searchParams.get('page') === '1' ? [p] : []);
    if (recurso === 'products' && String(p.id) === pid) {
      if (!sub && req.method === 'GET') return json(200, p);
      if (!sub && req.method === 'PUT') {
        if (body.name) p.name = body.name;
        if (loja.aplicaEstoqueNoProduto && Array.isArray(body.variants)) {
          body.variants.forEach((bv, i) => { if (p.variants[i] && bv.stock != null) p.variants[i].stock = bv.stock; });
        }
        return json(200, p);
      }
      if (sub === 'variants' && String(variante().id) === vid) {
        if (req.method === 'GET') return json(200, variante());
        if (req.method === 'PUT') {
          if (loja.falharEstoque > 0) { loja.falharEstoque -= 1; return json(loja.statusFalha, { description: 'recusado' }); }
          variante().stock = body.stock;
          return json(200, variante());
        }
      }
    }
    if (['categories', 'orders', 'checkouts', 'customers'].includes(recurso) && req.method === 'GET') return json(200, []);
    return json(404, { description: `${req.method} ${url.pathname}` });
  });
}

let servidor, nuvem;
const api = async (metodo, caminho, corpo) => {
  const r = await servidor.pedir(metodo, caminho, { corpo });
  if (r.status >= 400) throw new Error(`${metodo} ${caminho} → ${r.status}: ${r.bytes}\n${servidor.saida()}`);
  return r.json;
};
const aqui = () => servidor.banco().prepare(`SELECT v.id, v.stock, v.on_hand, v.ns_delta, v.ns_fixar, v.product_id
  FROM variants v WHERE v.nuvemshop_variant_id = '1001'`).get();
const venderNoBalcao = (qty = 1) => api('POST', '/api/sales', { items: [{ variant_id: aqui().id, qty }], payment_method: 'pix' });
const venderNoSite = () => { variante().stock -= 1; };

before(async () => {
  nuvem = http.createServer(mock);
  await new Promise((ok) => nuvem.listen(0, '127.0.0.1', ok));
  servidor = await subirServidor({
    NUVEMSHOP_STORE_ID: LOJA, NUVEMSHOP_ACCESS_TOKEN: 'token-de-teste',
    NUVEMSHOP_API_BASE: `http://127.0.0.1:${nuvem.address().port}`,
  });
  await api('POST', '/api/sync', {});
  assert.equal(aqui().stock, 5);
});

after(() => {
  servidor?.parar();
  nuvem?.close();
});

test('venda no balcão parte do estoque da loja, não do número velho daqui', async () => {
  venderNoSite();                       // loja 4, aqui ainda 5
  const r = await venderNoBalcao();
  assert.equal(r.stock_synced, true);
  assert.equal(variante().stock, 3);    // antes da correção: voltava para 4
  assert.equal(aqui().stock, 3);
  assert.equal(aqui().ns_delta, 0);
});

test('loja fora do ar: a baixa fica na fila e sobe depois', async () => {
  venderNoSite();                       // loja 2, aqui 3
  loja.falharEstoque = 1;
  const r = await venderNoBalcao();
  assert.equal(r.stock_synced, false);
  assert.equal(r.stock_na_fila, true);
  assert.equal(variante().stock, 2);
  assert.equal(aqui().ns_delta, -1);

  await api('POST', '/api/sync', {});   // sobe a fila e depois lê a loja
  assert.equal(variante().stock, 1);
  assert.equal(aqui().stock, 1);
  assert.equal(aqui().ns_delta, 0);
});

test('entrada de mercadoria soma ao estoque da loja', async () => {
  venderNoSite();                       // loja 0, aqui 1
  await api('POST', '/api/purchases', { items: [{ variant_id: aqui().id, qty: 5, unit_cost: 40 }] });
  assert.equal(variante().stock, 5);    // antes da correção: 6
  assert.equal(aqui().stock, 5);
});

test('editar o produto sem mexer no estoque não devolve a venda do site', async () => {
  venderNoSite();                       // loja 4, aqui 5
  const v = aqui();
  const r = await api('PUT', `/api/catalog/${v.product_id}`, {
    name: 'Camiseta Nova',
    variants: [{ id: v.id, variant_name: 'M', price: 89.9, cost: 40, stock: v.stock }],
  });
  assert.equal(r.sync.ok, true);
  assert.equal(loja.produto.name.pt, 'Camiseta Nova');
  assert.equal(variante().stock, 4);    // antes da correção: voltava para 5
  assert.equal(aqui().stock, 4);
});

test('estoque digitado à mão vale na loja como está', async () => {
  loja.aplicaEstoqueNoProduto = false;  // mesmo se a loja ignorar o estoque no PUT do produto
  const v = aqui();
  await api('PUT', `/api/catalog/${v.product_id}`, {
    variants: [{ id: v.id, variant_name: 'M', price: 89.9, cost: 40, stock: 7 }],
  });
  assert.equal(variante().stock, 7);
  assert.equal(aqui().stock, 7);
  assert.equal(aqui().ns_fixar, 0);
});

test('app sem permissão de escrita: o sistema percebe e avisa', async () => {
  loja.statusFalha = 403; loja.falharEstoque = 1;
  await venderNoBalcao();
  const con = await api('GET', '/api/connection');
  assert.equal(con.escrita.ok, false);
  assert.match(con.escrita.erro, /permissão/);
  assert.equal((await api('GET', '/api/dashboard')).loja_escrita.ok, false);
  // Quando volta a funcionar (permissão corrigida), o aviso some.
  loja.statusFalha = 503;
  await venderNoBalcao();
  assert.equal((await api('GET', '/api/connection')).escrita.ok, true);
});
