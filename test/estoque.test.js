// Estoque entre o balcão e o site: a venda de um nunca pode desfazer a
// do outro. Sobe o servidor de verdade (banco temporário) contra uma
// Nuvemshop de mentira, que guarda o estoque "da loja" em memória.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOJA = '123';

// ---- A Nuvemshop de mentira ----
const loja = {
  produto: {
    id: 100, name: { pt: 'Camiseta' }, description: { pt: '' }, published: true,
    categories: [], images: [],
    variants: [{ id: 1001, values: [{ pt: 'M' }], price: '89.90', sku: '', stock: 5, stock_management: true }],
  },
  falharEstoque: 0,           // quantos PUT de variação seguidos devolvem erro
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
          if (loja.falharEstoque > 0) { loja.falharEstoque -= 1; return json(503, { description: 'fora do ar' }); }
          variante().stock = body.stock;
          return json(200, variante());
        }
      }
    }
    if (['categories', 'orders', 'checkouts', 'customers'].includes(recurso) && req.method === 'GET') return json(200, []);
    return json(404, { description: `${req.method} ${url.pathname}` });
  });
}

const portaLivre = () => new Promise((ok) => {
  const s = net.createServer().listen(0, () => { const { port } = s.address(); s.close(() => ok(port)); });
});

let servidor, nuvem, base, banco, pasta, saida = '';
const api = async (metodo, caminho, corpo) => {
  const r = await fetch(base + caminho, {
    method: metodo, headers: { 'Content-Type': 'application/json' },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const d = await r.json();
  if (!r.ok) throw new Error(`${metodo} ${caminho} → ${r.status}: ${JSON.stringify(d)}\n${saida}`);
  return d;
};
const aqui = () => banco.prepare(`SELECT v.id, v.stock, v.on_hand, v.ns_delta, v.ns_fixar, v.product_id
  FROM variants v WHERE v.nuvemshop_variant_id = '1001'`).get();
const venderNoBalcao = (qty = 1) => api('POST', '/api/sales', { items: [{ variant_id: aqui().id, qty }], payment_method: 'pix' });
const venderNoSite = () => { variante().stock -= 1; };

before(async () => {
  nuvem = http.createServer(mock);
  await new Promise((ok) => nuvem.listen(0, '127.0.0.1', ok));
  pasta = fs.mkdtempSync(join(os.tmpdir(), 'vn-estoque-'));
  const porta = await portaLivre();
  base = `http://127.0.0.1:${porta}`;
  servidor = spawn(process.execPath, ['server/index.js'], {
    cwd: RAIZ,
    env: {
      ...process.env, PORT: String(porta), DB_FILE: join(pasta, 'teste.db'),
      NUVEMSHOP_STORE_ID: LOJA, NUVEMSHOP_ACCESS_TOKEN: 'token-de-teste',
      NUVEMSHOP_API_BASE: `http://127.0.0.1:${nuvem.address().port}`,
      APP_PASSWORD: '', SYNC_MINUTES: '60',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  servidor.stdout.on('data', (d) => { saida += d; });
  servidor.stderr.on('data', (d) => { saida += d; });
  for (let i = 0; ; i += 1) {
    try { if ((await fetch(base + '/api/health')).ok) break; } catch (_) { /* ainda subindo */ }
    if (i > 100) throw new Error('servidor não subiu:\n' + saida);
    await new Promise((ok) => setTimeout(ok, 50));
  }
  await api('POST', '/api/sync', {});
  banco = new Database(join(pasta, 'teste.db'), { readonly: true });
  assert.equal(aqui().stock, 5);
});

after(() => {
  banco?.close();
  servidor?.kill();
  nuvem?.close();
  if (pasta) fs.rmSync(pasta, { recursive: true, force: true });
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
