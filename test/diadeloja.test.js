// Um dia de loja inteiro, do jeito que vai acontecer quando o PDV daqui
// for o único: vendas no balcão, venda no site no meio, troca, cancelamento,
// mercadoria chegando, contagem à mão e a releitura automática. No fim, o
// estoque DA NUVEMSHOP tem que ser exatamente o que sobrou na loja — peça
// por peça — e o daqui igual ao dela, sem nada pendente na fila.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { subirServidor } from './servidor.js';

const LOJA = '123';
const nuvem = {
  produtos: [
    { id: 100, nome: 'Camiseta Preta', estoque: 10 },
    { id: 200, nome: 'Boné Branco', estoque: 5 },
    { id: 300, nome: 'Bermuda Jeans', estoque: 3 },
  ],
  pedidos: [],
};
const comoLoja = (p) => ({ id: p.id, name: { pt: p.nome }, description: { pt: '' }, published: true, categories: [], images: [],
  variants: [{ id: p.id * 10 + 1, values: [{ pt: 'M' }], price: '100.00', sku: '', stock: p.estoque, stock_management: true }] });
const naLoja = (nome) => nuvem.produtos.find((p) => p.nome === nome);

let srv, s;
before(async () => {
  srv = http.createServer((req, res) => {
    let corpo = '';
    req.on('data', (c) => { corpo += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const [, recurso, pid, sub] = url.pathname.split('/').filter(Boolean);
      const json = (code, d) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };
      const p = pid && nuvem.produtos.find((x) => String(x.id) === pid);
      const body = corpo ? JSON.parse(corpo) : {};
      if (recurso === 'products' && !pid) return json(200, url.searchParams.get('page') === '1' ? nuvem.produtos.map(comoLoja) : []);
      if (recurso === 'products' && p && !sub) {
        if (req.method === 'PUT' && Array.isArray(body.variants) && body.variants[0] && body.variants[0].stock != null) p.estoque = body.variants[0].stock;
        return json(200, comoLoja(p));
      }
      if (recurso === 'products' && p && sub === 'variants') {
        if (req.method === 'PUT') p.estoque = body.stock;
        return json(200, comoLoja(p).variants[0]);
      }
      if (recurso === 'orders') return json(200, url.searchParams.get('page') === '1' ? nuvem.pedidos : []);
      return json(200, []);
    });
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  s = await subirServidor({ NUVEMSHOP_STORE_ID: LOJA, NUVEMSHOP_ACCESS_TOKEN: 'x',
    NUVEMSHOP_API_BASE: `http://127.0.0.1:${srv.address().port}` });
  await s.pedir('POST', '/api/sync', { corpo: {} });
  // Como na loja de verdade: o sistema já lê os pedidos há tempos antes
  // deste dia começar (só pedido novo mexe no estoque daqui).
  await s.pedir('POST', '/api/import-customers', { corpo: { days: 30 } });
});
after(() => { s?.parar(); srv?.close(); });

const api = async (m, c, corpo) => {
  const r = await s.pedir(m, c, { corpo });
  assert.ok(r.status < 400, `${m} ${c} → ${r.status} ${r.bytes}`);
  return r.json;
};
const vid = (nome) => s.banco().prepare('SELECT v.id FROM variants v JOIN products p ON p.id = v.product_id WHERE p.name = ?').get(nome).id;
const pid = (nome) => s.banco().prepare('SELECT id FROM products WHERE name = ?').get(nome).id;
const aqui = (nome) => s.banco().prepare('SELECT stock FROM variants WHERE id = ?').get(vid(nome)).stock;
const vendaId = (code) => s.banco().prepare('SELECT id FROM sales WHERE code = ?').get(code).id;

test('um dia de loja: o estoque da Nuvemshop fecha peça por peça', async () => {
  // 1. Abre a loja: duas camisetas e um boné no balcão.
  const v1 = await api('POST', '/api/sales', { items: [{ variant_id: vid('Camiseta Preta'), qty: 2 }, { variant_id: vid('Boné Branco'), qty: 1 }], payment_method: 'Pix' });
  assert.equal(naLoja('Camiseta Preta').estoque, 8);
  assert.equal(naLoja('Boné Branco').estoque, 4);

  // 2. No meio da manhã, alguém compra uma camiseta pelo site (a Nuvemshop
  //    baixa sozinha) e o sistema lê o pedido.
  naLoja('Camiseta Preta').estoque -= 1;
  nuvem.pedidos.push({ id: 9001, number: 9001, created_at: new Date().toISOString(), status: 'open', payment_status: 'paid',
    shipping_status: 'unpacked', total: '100.00', gateway: 'pix', storefront: 'store', customer: { id: 77, name: 'Cliente Site' },
    products: [{ product_id: 100, variant_id: 1001, quantity: 1, price: '100.00', name: 'Camiseta Preta (M)' }] });
  await api('POST', '/api/import-customers', { days: 30 });
  assert.equal(aqui('Camiseta Preta'), 7);

  // 3. Mais uma camiseta no balcão: parte do número DA LOJA (7), não do daqui.
  const v2 = await api('POST', '/api/sales', { items: [{ variant_id: vid('Camiseta Preta'), qty: 1 }], payment_method: 'Dinheiro' });
  assert.equal(naLoja('Camiseta Preta').estoque, 6);

  // 4. O cliente da primeira venda volta: devolve o boné e leva uma bermuda.
  const det = await api('GET', `/api/vendas/${vendaId(v1.code)}`);
  const bone = det.itens.find((i) => i.variant_id === vid('Boné Branco'));
  await api('POST', `/api/sales/${vendaId(v1.code)}/troca`, { devolver: [{ item_id: bone.id, qty: 1 }],
    levar: [{ variant_id: vid('Bermuda Jeans'), qty: 1 }], forma: 'Pix' });
  assert.equal(naLoja('Boné Branco').estoque, 5);
  assert.equal(naLoja('Bermuda Jeans').estoque, 2);

  // 5. A venda das 11h foi lançada errado: cancela.
  await api('POST', `/api/sales/${vendaId(v2.code)}/cancelar`, { motivo: 'lançada errado', forma: 'Dinheiro' });
  assert.equal(naLoja('Camiseta Preta').estoque, 7);

  // 6. Chegam 3 bermudas do fornecedor.
  await api('POST', '/api/purchases', { supplier_name: 'Fornecedor', items: [{ variant_id: vid('Bermuda Jeans'), qty: 3, unit_cost: 50 }] });
  assert.equal(naLoja('Bermuda Jeans').estoque, 5);

  // 7. À tarde, conta as camisetas na prateleira: são 9 (achou duas no estoque).
  const prod = await api('GET', `/api/catalog/${pid('Camiseta Preta')}`);
  await api('PUT', `/api/catalog/${prod.id}`, { name: prod.name, variants: prod.variants.map((v) => ({ ...v, stock: 9 })) });
  assert.equal(naLoja('Camiseta Preta').estoque, 9);

  // 8. A releitura automática da loja roda: nada muda, porque já bate.
  await api('POST', '/api/sync', {});

  // Fechamento: a Nuvemshop tem exatamente o que sobrou, e o daqui é igual.
  const esperado = { 'Camiseta Preta': 9, 'Boné Branco': 5, 'Bermuda Jeans': 5 };
  for (const [nome, n] of Object.entries(esperado)) {
    assert.equal(naLoja(nome).estoque, n, `Nuvemshop: ${nome}`);
    assert.equal(aqui(nome), n, `sistema: ${nome}`);
  }
  const pendente = s.banco().prepare('SELECT COUNT(*) n FROM variants WHERE ns_delta <> 0 OR ns_fixar = 1').get().n;
  assert.equal(pendente, 0, 'nada esperando para subir');
});
