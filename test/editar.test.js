// Venda lançada se corrige: peças, preços, desconto, pagamento, cliente —
// com o estoque da Nuvemshop acompanhando pela diferença e o dinheiro no
// dia da venda. E o preço promocional da loja (Black Friday) vem para o PDV.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { subirServidor } from './servidor.js';

const loja = {
  produtos: [
    { id: 100, nome: 'Camiseta Nike', preco: '99.90', promo: '79.90', estoque: 6 },
    { id: 200, nome: 'Boné Lacoste', preco: '59.90', promo: null, estoque: 4 },
  ],
  pedidos: [{ id: 7001, number: 7001, created_at: new Date().toISOString(), status: 'open', payment_status: 'paid',
    shipping_status: 'unpacked', total: '59.90', gateway: 'pix', storefront: 'store', customer: { id: 55, name: 'Cliente do site' },
    products: [{ product_id: 200, variant_id: 2001, quantity: 1, price: '59.90', name: 'Boné Lacoste' }] }],
};
const comoLoja = (p) => ({ id: p.id, name: { pt: p.nome }, description: { pt: '' }, published: true, categories: [], images: [],
  variants: [{ id: p.id * 10 + 1, values: [], price: p.preco, promotional_price: p.promo, sku: '', stock: p.estoque, stock_management: true }] });
const naLoja = (id) => loja.produtos.find((p) => p.id === id);

let srv, s;
before(async () => {
  srv = http.createServer((req, res) => {
    let corpo = '';
    req.on('data', (c) => { corpo += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const [, recurso, pid, sub] = url.pathname.split('/').filter(Boolean);
      const json = (d) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };
      const pg1 = url.searchParams.get('page') === '1';
      const p = pid && loja.produtos.find((x) => String(x.id) === pid);
      if (recurso === 'products' && !pid) return json(pg1 ? loja.produtos.map(comoLoja) : []);
      if (recurso === 'products' && p && sub === 'variants') {
        if (req.method === 'PUT') p.estoque = JSON.parse(corpo).stock;
        return json(comoLoja(p).variants[0]);
      }
      if (recurso === 'products' && p) return json(comoLoja(p));
      if (recurso === 'orders') return json(pg1 ? loja.pedidos : []);
      return json([]);
    });
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  s = await subirServidor({ NUVEMSHOP_STORE_ID: '123', NUVEMSHOP_ACCESS_TOKEN: 'x',
    NUVEMSHOP_API_BASE: `http://127.0.0.1:${srv.address().port}` });
  await s.pedir('POST', '/api/sync', { corpo: {} });
});
after(() => { s?.parar(); srv?.close(); });

const vid = (nsId) => s.banco().prepare('SELECT id FROM variants WHERE nuvemshop_variant_id = ?').get(String(nsId)).id;
const venda = (code) => s.banco().prepare('SELECT * FROM sales WHERE code = ?').get(code);
const itens = (code) => s.banco().prepare('SELECT variant_id, qty, unit_price FROM sale_items WHERE sale_id = ? ORDER BY id').all(venda(code).id);
const entradas = (code) => s.banco().prepare("SELECT * FROM financial_entries WHERE ref = ? AND type = 'receita'").all(code);
const vender = async (corpo) => { const r = await s.pedir('POST', '/api/sales', { corpo }); assert.equal(r.status, 200, String(r.bytes)); return r.json; };
const editar = (code, corpo) => s.pedir('PUT', `/api/sales/${venda(code).id}`, { corpo });

test('o preço promocional da loja vem e é o que o PDV cobra', async () => {
  const v = (await s.pedir('GET', '/api/products?q=camiseta')).json[0];
  assert.equal(v.price, 99.9);
  assert.equal(v.preco_promo, 79.9);
  const r = await vender({ items: [{ variant_id: vid(1001), qty: 1 }], payment_method: 'Pix' });
  assert.equal(r.total, 79.9);
  // Preço digitado no carrinho vale mais que o da loja.
  const r2 = await vender({ items: [{ variant_id: vid(1001), qty: 1, unit_price: 70 }], payment_method: 'Pix' });
  assert.equal(r2.total, 70);
  // A promoção acabou no painel da loja: volta o preço cheio.
  naLoja(100).promo = null;
  await s.pedir('POST', '/api/sync', { corpo: {} });
  const r3 = await vender({ items: [{ variant_id: vid(1001), qty: 1 }], payment_method: 'Pix' });
  assert.equal(r3.total, 99.9);
  naLoja(100).promo = '79.90';
  await s.pedir('POST', '/api/sync', { corpo: {} });
});

test('corrige peças, preço, desconto e forma: estoque pela diferença, dinheiro no dia da venda', async () => {
  const camisetaAntes = naLoja(100).estoque, boneAntes = naLoja(200).estoque;
  const r = await vender({ items: [{ variant_id: vid(1001), qty: 2 }], payment_method: 'Pix', data: diaDaLoja(-2) });
  assert.equal(naLoja(100).estoque, camisetaAntes - 2);
  const e = await editar(r.code, { items: [{ variant_id: vid(1001), qty: 1 }, { variant_id: vid(2001), qty: 1, unit_price: 50 }],
    discount: 10, payment_method: 'Crédito' });
  assert.equal(e.status, 200, String(e.bytes));
  // Estoque: uma camiseta volta, um boné sai — na Nuvemshop também.
  assert.equal(naLoja(100).estoque, camisetaAntes - 1);
  assert.equal(naLoja(200).estoque, boneAntes - 1);
  // A venda: 79,90 + 50 − 10 = 119,90.
  const v = venda(r.code);
  assert.equal(v.total, 119.9);
  assert.equal(v.payment_method, 'Crédito');
  assert.deepEqual(itens(r.code).map((i) => [i.qty, i.unit_price]), [[1, 79.9], [1, 50]]);
  // O dinheiro: a mesma entrada, com o total novo, a forma nova e no dia da venda.
  const ent = entradas(r.code);
  assert.equal(ent.length, 1);
  assert.equal(ent[0].amount, 119.9);
  assert.equal(ent[0].forma, 'Crédito');
  assert.equal(ent[0].created_at, v.created_at);
  assert.equal(diaLoja(v.created_at), diaDaLoja(-2));
});

test('virou fiado: o dinheiro sai do caixa; pago de novo: volta, no dia da venda', async () => {
  const r = await vender({ items: [{ variant_id: vid(2001), qty: 1 }], payment_method: 'Pix' });
  assert.equal((await editar(r.code, { payment_status: 'pendente' })).status, 200);
  assert.equal(entradas(r.code).length, 0);
  assert.equal(venda(r.code).payment_status, 'pendente');
  assert.equal((await editar(r.code, { payment_status: 'pago', payment_method: 'Dinheiro' })).status, 200);
  const ent = entradas(r.code);
  assert.equal(ent.length, 1);
  assert.equal(ent[0].created_at, venda(r.code).created_at);
  assert.equal(ent[0].forma, 'Dinheiro');
});

test('cliente e vendedor se trocam; estoque que não tem, não deixa', async () => {
  const r = await vender({ items: [{ variant_id: vid(2001), qty: 1 }], payment_method: 'Pix' });
  assert.equal((await editar(r.code, { new_customer: { name: 'Maria Souza' } })).status, 200);
  assert.equal(venda(r.code).customer_name, 'Maria Souza');
  const antes = naLoja(200).estoque;
  const muito = await editar(r.code, { items: [{ variant_id: vid(2001), qty: 99 }] });
  assert.equal(muito.status, 409);
  assert.equal(naLoja(200).estoque, antes);
  assert.equal(itens(r.code)[0].qty, 1);
});

test('venda com troca: peças não mudam, cliente e forma sim; cancelada não se edita', async () => {
  const r = await vender({ items: [{ variant_id: vid(1001), qty: 1 }], payment_method: 'Pix' });
  const item = s.banco().prepare('SELECT id FROM sale_items WHERE sale_id = ?').get(venda(r.code).id).id;
  await s.pedir('POST', `/api/sales/${venda(r.code).id}/troca`, { corpo: { devolver: [{ item_id: item, qty: 1 }],
    levar: [{ variant_id: vid(2001), qty: 1 }], forma: 'Pix' } });
  assert.equal((await editar(r.code, { items: [{ variant_id: vid(2001), qty: 2 }] })).status, 400);
  assert.equal((await editar(r.code, { payment_method: 'Débito', new_customer: { name: 'João' } })).status, 200);
  assert.equal(venda(r.code).customer_name, 'João');
  await s.pedir('POST', `/api/sales/${venda(r.code).id}/cancelar`, { corpo: { motivo: 'teste' } });
  assert.equal((await editar(r.code, { payment_method: 'Pix' })).status, 400);
});

test('pedido do site: peças e preços se corrigem na loja; o cliente daqui fica', async () => {
  await s.pedir('POST', '/api/import-customers', { corpo: { days: 5 } });
  const site = venda('SITE-7001');
  assert.ok(site);
  assert.equal((await s.pedir('PUT', `/api/sales/${site.id}`, { corpo: { discount: 5 } })).status, 400);
  const c = await s.pedir('POST', `/api/sales/${site.id}/cliente`, { corpo: { new_customer: { name: 'Ana Pereira' } } });
  assert.equal(c.status, 200);
  await s.pedir('POST', '/api/import-customers', { corpo: { days: 5 } });   // a loja relê o pedido
  const depois = venda('SITE-7001');
  assert.equal(depois.customer_id, c.json.customer_id);
  assert.equal(depois.customer_name, 'Ana Pereira');
});

// Datas no fuso da loja.
function diaDaLoja(deslocDias) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(Date.now() + deslocDias * 864e5));
}
function diaLoja(iso) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(iso)); }
