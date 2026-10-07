// O que muda direto no painel da Nuvemshop (repôs peça, esgotou, apagou,
// cadastrou produto novo) tem que chegar aqui — antes, só a venda do site
// era relida, e o estoque daqui ficava dias atrás do da loja.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { subirServidor } from './servidor.js';

const LOJA = '123';
const produto = (id, nome, estoque, publicado = true) => ({
  id, name: { pt: nome }, description: { pt: '' }, published: publicado, categories: [], images: [],
  variants: [{ id: id * 10 + 1, values: [{ pt: 'M' }], price: '100.00', sku: '', stock: estoque, stock_management: true }],
});
const loja = { produtos: [produto(100, 'Conjunto Adidas', 2), produto(200, 'Boné Antigo', 1)], demora: 0 };
const acharVar = (vid) => loja.produtos.flatMap((p) => p.variants).find((v) => String(v.id) === String(vid));

let nuvem, s;
const estoque = (nome) => s.banco().prepare('SELECT v.stock FROM variants v JOIN products p ON p.id = v.product_id WHERE p.name = ?').get(nome)?.stock;
const reler = async (corpo = {}) => {
  const r = await s.pedir('POST', '/api/sync', { corpo });
  assert.equal(r.status, 200, String(r.bytes));
  return r.json;
};

before(async () => {
  nuvem = http.createServer((req, res) => {
    let corpo = '';
    req.on('data', (c) => { corpo += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const [, recurso, pid, sub, vid] = url.pathname.split('/').filter(Boolean);
      const json = (d) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };
      if (recurso === 'products' && !pid) {
        // A foto da loja é tirada na hora do pedido; a resposta pode demorar.
        const foto = JSON.parse(JSON.stringify(url.searchParams.get('page') === '1' ? loja.produtos : []));
        return setTimeout(() => json(foto), loja.demora);
      }
      if (recurso === 'products' && sub === 'variants') {
        const v = acharVar(vid);
        if (req.method === 'PUT') v.stock = JSON.parse(corpo).stock;
        return json(v);
      }
      json([]);
    });
  });
  await new Promise((ok) => nuvem.listen(0, '127.0.0.1', ok));
  s = await subirServidor({ NUVEMSHOP_STORE_ID: LOJA, NUVEMSHOP_ACCESS_TOKEN: 'token-de-teste',
    NUVEMSHOP_API_BASE: `http://127.0.0.1:${nuvem.address().port}`, PRIMEIRA_RODADA_MS: '200' });
  // Sem ninguém clicar em nada: a primeira volta do motor lê tudo sozinha.
  for (let i = 0; i < 50 && !(await s.pedir('GET', '/api/connection')).json.automatico.clientes.ultima; i++) {
    await new Promise((ok) => setTimeout(ok, 100));
  }
});
after(() => { s?.parar(); nuvem?.close(); });

test('ligou: estoque, pedidos, clientes e a permissão de gravar rodam sozinhos', async () => {
  const a = (await s.pedir('GET', '/api/connection')).json;
  assert.ok(a.automatico.estoque.ultima);
  assert.ok(a.automatico.pedidos.ultima);
  assert.ok(a.automatico.clientes.ultima);
  assert.equal(a.automatico.pedidos.erro, null);
  assert.equal(a.escrita.ok, true);
  assert.equal(estoque('Conjunto Adidas'), 2);   // o produto chegou sem o botão
});

test('repôs peça pelo painel da loja: o número daqui sobe', async () => {
  assert.equal(estoque('Conjunto Adidas'), 2);
  loja.produtos[0].variants[0].stock = 7;
  await reler();
  assert.equal(estoque('Conjunto Adidas'), 7);
});

test('esgotou na loja: aqui também zera (antes ficava o número velho)', async () => {
  loja.produtos[0].variants[0].stock = 0;
  await reler();   // filtros padrão: "só com estoque" vale só para produto novo
  assert.equal(estoque('Conjunto Adidas'), 0);
  loja.produtos[0].variants[0].stock = 7;
  await reler();
});

test('produto novo entra; novo esgotado não; apagado na loja zera aqui', async () => {
  loja.produtos = [loja.produtos[0], produto(300, 'Jaqueta Nova', 3), produto(400, 'Velho Esgotado', 0)];
  const r = await reler();
  assert.equal(estoque('Jaqueta Nova'), 3);
  assert.equal(estoque('Velho Esgotado'), undefined);
  assert.equal(estoque('Boné Antigo'), 0);
  assert.equal(r.zeradas, 1);
});

test('o Início mostra quando o estoque foi conferido com a loja', async () => {
  const op = (await s.pedir('GET', '/api/operacao')).json;
  assert.ok(op.estoque_relido_em);
});

test('venda no meio da leitura: o número velho da loja não desfaz a venda aqui', async () => {
  loja.produtos[0].variants[0].stock = 7;
  await reler();
  const vid = s.banco().prepare("SELECT v.id FROM variants v JOIN products p ON p.id = v.product_id WHERE p.name = 'Conjunto Adidas'").get().id;
  loja.demora = 700;
  const leitura = reler();   // a loja "fotografa" 7 e demora para responder
  await new Promise((ok) => setTimeout(ok, 150));
  const venda = await s.pedir('POST', '/api/sales', { corpo: { items: [{ variant_id: vid, qty: 1 }], payment_method: 'Pix' } });
  assert.equal(venda.status, 200);
  await leitura;
  loja.demora = 0;
  assert.equal(acharVar(1001).stock, 6);          // a loja recebeu a venda
  assert.equal(estoque('Conjunto Adidas'), 6);    // e aqui não voltou para 7
  await reler();
  assert.equal(estoque('Conjunto Adidas'), 6);    // na rodada seguinte, tudo igual
});
