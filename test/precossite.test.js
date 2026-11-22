// Black Friday: a promoção do menu "Promoções" da Nuvemshop não vem pela
// API, mas o site mostra o preço com o desconto. O sistema lê o site como um
// cliente e o PDV cobra o mesmo preço.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { subirServidor } from './servidor.js';

// A loja (API) e o site (o que o cliente vê).
const loja = [
  { id: 100, nome: 'Camiseta Amiri', preco: '200.00', estoque: 5 },
  { id: 200, nome: 'Boné Lacoste', preco: '100.00', estoque: 3 },
  { id: 300, nome: 'Bermuda Nike', preco: '150.00', estoque: 2 },
];
const site = { 1001: 150, 2001: 100, 3001: 120, falhar: 0 };   // preço que o site mostra agora (o "de" é o da loja)
const varSite = (p) => ({ product_id: p.id, id: p.id * 10 + 1, price_number: site[p.id * 10 + 1], option0: 'U',
  compare_at_price_number: site[p.id * 10 + 1] < Number(p.preco) ? Number(p.preco) : null,
  discount_percentage_number: Math.round((1 - site[p.id * 10 + 1] / Number(p.preco)) * 100) });
// Página 1 com aspas simples; página 2 com &quot; (os dois jeitos da loja);
// da 3 em diante, a loja repete a última.
const pagina = (n) => {
  if (n === 1) return `<html><div class="item" data-variants='${JSON.stringify([varSite(loja[0]), { ...varSite(loja[0]), id: 9999 }])}'></div></html>`;
  const json = JSON.stringify([varSite(loja[1])]).replace(/"/g, '&quot;');
  const json2 = JSON.stringify([varSite(loja[2])]).replace(/"/g, '&quot;');
  return `<div data-variants="${json}"></div><div data-variants="${json2}"></div>`;
};
const comoLoja = (p) => ({ id: p.id, name: { pt: p.nome }, description: { pt: '' }, published: true, categories: [], images: [],
  variants: [{ id: p.id * 10 + 1, values: [], price: p.preco, promotional_price: null, sku: '', stock: p.estoque, stock_management: true }] });

let api, web, s, pedidosDoSite = 0;
before(async () => {
  api = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const [, recurso, pid] = url.pathname.split('/').filter(Boolean);
    const json = (d) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };
    if (recurso === 'products' && !pid) return json(url.searchParams.get('page') === '1' ? loja.map(comoLoja) : []);
    if (recurso === 'products' && pid) return json(comoLoja(loja.find((p) => String(p.id) === pid)).variants[0]);
    return json([]);
  });
  web = http.createServer((req, res) => {
    pedidosDoSite += 1;
    const m = /^\/produtos\/(?:page\/(\d+)\/)?$/.exec(req.url);
    if (!m) { res.writeHead(404); return res.end(); }
    const n = Number(m[1] || 1);
    if (site.falhar && n >= site.falhar) { res.writeHead(500); return res.end('fora'); }
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(pagina(Math.min(n, 2)));
  });
  await new Promise((ok) => api.listen(0, '127.0.0.1', ok));
  await new Promise((ok) => web.listen(0, '127.0.0.1', ok));
  s = await subirServidor({ NUVEMSHOP_STORE_ID: '123', NUVEMSHOP_ACCESS_TOKEN: 'x',
    NUVEMSHOP_API_BASE: `http://127.0.0.1:${api.address().port}`, SITE_URL: `http://127.0.0.1:${web.address().port}`,
    PRECOS_SITE_ESPERA_MS: '0' });
  await s.pedir('POST', '/api/sync', { corpo: {} });
});
after(() => { s?.parar(); api?.close(); web?.close(); });

const vid = (ns) => s.banco().prepare('SELECT id FROM variants WHERE nuvemshop_variant_id = ?').get(String(ns)).id;
const precoSite = (ns) => s.banco().prepare('SELECT preco_site FROM variants WHERE nuvemshop_variant_id = ?').get(String(ns)).preco_site;
const ler = async () => { const r = await s.pedir('POST', '/api/precos-site/ler'); assert.equal(r.status, 200, String(r.bytes)); return r.json; };

test('lê o site como um cliente: guarda o preço com desconto, para no fim', async () => {
  const antes = pedidosDoSite;
  const r = await ler();
  assert.equal(r.com_desconto, 2);              // camiseta e bermuda; o boné está sem desconto
  assert.equal(r.completo, true);
  assert.ok(pedidosDoSite - antes <= 4, 'parou quando a página só repetia');
  assert.equal(precoSite(1001), 150);
  assert.equal(precoSite(3001), 120);
  assert.equal(precoSite(2001), null);
});

test('o PDV cobra o preço do site', async () => {
  const v = (await s.pedir('GET', '/api/products?q=amiri')).json[0];
  assert.equal(v.preco_site, 150);
  const venda = await s.pedir('POST', '/api/sales', { corpo: { items: [{ variant_id: vid(1001), qty: 1 }, { variant_id: vid(2001), qty: 1 }], payment_method: 'Pix' } });
  assert.equal(venda.status, 200, String(venda.bytes));
  assert.equal(venda.json.total, 250);          // 150 (promoção) + 100 (cheio)
});

test('o site caiu no meio: a promoção de antes fica (não tira de todo mundo)', async () => {
  site.falhar = 2;
  const r = await ler();
  site.falhar = 0;
  assert.equal(r.completo, false);
  assert.equal(precoSite(3001), 120);           // não apareceu nesta leitura, mas fica
});

test('a promoção acabou no site: volta o preço cheio', async () => {
  site[1001] = 200; site[3001] = 150;
  await ler();
  assert.equal(precoSite(1001), null);
  assert.equal(precoSite(3001), null);
  const venda = await s.pedir('POST', '/api/sales', { corpo: { items: [{ variant_id: vid(1001), qty: 1 }], payment_method: 'Pix' } });
  assert.equal(venda.json.total, 200);
});

test('a tela Conectar mostra a leitura dos preços do site', async () => {
  const p = (await s.pedir('GET', '/api/connection')).json.automatico.precos_site;
  assert.ok(p.ultima);
  assert.equal(p.erro, null);
  assert.equal(p.a_cada_min, 30);
});
