// Pedidos do site: as peças entram junto (e o sistema passa a saber o que
// vende), produto esgotado vem da loja para a venda ter a quem somar, o
// custo cadastrado depois preenche as vendas que ficaram sem, o "acabando"
// olha o produto que vende de novo, e as filas só mostram o que é atual.
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
// O que a loja tem. "escondido" some da lista até o teste mostrar.
const loja = {
  produtos: [
    produto(100, 'Tênis Que Vende', 1001, 2),      // vendeu 2 e tem 2: acabando
    produto(200, 'Boné Parado', 2001, 2),          // tem 2 mas não vende: não é urgente
    produto(300, 'Camiseta Cheia', 3001, 10),      // vende mas tem bastante
    produto(800, 'Jaqueta Esgotada', 8001, 0),     // esgotou: a leitura do catálogo não traz
    produto(900, 'Moletom Que Volta', 9001, 1),    // some da loja e volta depois
  ],
  escondido: new Set(['900']),
};
const pedido = (id, quando, pago, envio, itens) => ({
  id, number: id, created_at: quando, status: 'open',
  payment_status: pago ? 'paid' : 'pending', shipping_status: envio,
  total: String(itens.reduce((s, [, q, p]) => s + q * p, 0)), gateway: 'pix',
  customer: { id: 9, name: 'Cliente Teste', email: 'cliente@teste.com' },
  products: itens.map(([vid, quantity, price]) => ({
    product_id: Math.floor(vid / 10), variant_id: vid, quantity, price: String(price), name: `Peça ${vid}` })),
});
const pedidos = [
  pedido(1, diasAtras(2), true, 'unpacked', [[1001, 2, 300], [3001, 2, 100]]),   // atual, por embalar
  pedido(2, diasAtras(60), true, 'unpacked', [[3001, 1, 100]]),                   // velho: fora da fila
  pedido(3, diasAtras(1), false, 'unpacked', [[3001, 1, 200]]),                   // pix de ontem
  pedido(4, diasAtras(20), false, 'unpacked', [[3001, 1, 150]]),                  // pix abandonado
  pedido(5, diasAtras(3), true, 'delivered', [[9001, 1, 80], [9911, 1, 90]]),     // 991 foi apagado da loja
  pedido(6, diasAtras(4), true, 'delivered', [[8001, 1, 250]]),                   // produto esgotado
];

let nuvem, s;
const lerPedidos = () => s.pedir('POST', '/api/import-customers', { corpo: { days: 90 } });
before(async () => {
  nuvem = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const [l, recurso] = url.pathname.split('/').filter(Boolean);
    const json = (d) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };
    const primeira = url.searchParams.get('page') === '1';
    if (l !== LOJA) { res.writeHead(404); return res.end('{}'); }
    if (recurso === 'products') return json(primeira ? loja.produtos.filter((p) => !loja.escondido.has(String(p.id))) : []);
    if (recurso === 'orders') return json(primeira ? pedidos : []);
    return json([]);   // categorias, clientes, carrinhos
  });
  await new Promise((ok) => nuvem.listen(0, '127.0.0.1', ok));
  s = await subirServidor({
    NUVEMSHOP_STORE_ID: LOJA, NUVEMSHOP_ACCESS_TOKEN: 'token-de-teste',
    NUVEMSHOP_API_BASE: `http://127.0.0.1:${nuvem.address().port}`,
  });
  assert.equal((await s.pedir('POST', '/api/sync', { corpo: {} })).status, 200);
  assert.equal((await lerPedidos()).status, 200);
});
after(() => { s?.parar(); nuvem?.close(); });

const varianteDaLoja = (nsId) => s.banco().prepare('SELECT * FROM variants WHERE nuvemshop_variant_id = ?').get(String(nsId));
const variante = (nsId) => varianteDaLoja(nsId).id;
const venda = (code) => s.banco().prepare('SELECT * FROM sales WHERE code = ?').get(code);
const itensDa = (code) => s.banco().prepare('SELECT * FROM sale_items WHERE sale_id = ? ORDER BY id').all(venda(code).id);

test('o pedido do site chega com as peças, ligadas às variações daqui', async () => {
  const itens = itensDa('SITE-1');
  assert.deepEqual(itens.map((i) => [i.variant_id, i.qty, i.unit_price]), [[variante(1001), 2, 300], [variante(3001), 2, 100]]);
  // Ler a loja de novo não duplica.
  await lerPedidos();
  assert.equal(itensDa('SITE-1').length, 2);
  const rel = (await s.pedir('GET', '/api/relatorios?days=90')).json;
  assert.equal(rel.totais.pecas, 8);   // pedidos pagos 1, 2, 5 e 6; pix pendente não conta
});

test('produto esgotado vem da loja e a venda soma nele', async () => {
  const jaqueta = varianteDaLoja(8001);
  assert.ok(jaqueta, 'a Jaqueta Esgotada foi trazida da loja');
  assert.equal(jaqueta.stock, 0);
  assert.equal(itensDa('SITE-6')[0].variant_id, jaqueta.id);
  // Produto apagado da loja fica sem variação, mas com a sua linha no relatório.
  const rel = (await s.pedir('GET', '/api/relatorios?days=90')).json;
  assert.ok(rel.produtos.some((p) => p.produto === 'Jaqueta Esgotada'));
  assert.ok(rel.produtos.some((p) => p.produto === 'Peça 9911'));
});

test('peça que entrou solta se liga quando o produto aparece', async () => {
  assert.deepEqual(itensDa('SITE-5').map((i) => i.variant_id), [null, null]);
  loja.escondido.clear();
  await s.pedir('POST', '/api/sync', { corpo: {} });   // o Moletom volta ao catálogo
  await lerPedidos();
  assert.deepEqual(itensDa('SITE-5').map((i) => i.variant_id), [variante(9001), null]);
  const ids = itensDa('SITE-5').map((i) => i.id);
  await lerPedidos();                                    // nada novo: não refaz
  assert.deepEqual(itensDa('SITE-5').map((i) => i.id), ids);
});

test('"acabando" é o produto que vendeu de novo e tem pouca peça', async () => {
  const d = (await s.pedir('GET', '/api/dashboard')).json;
  assert.deepEqual(d.low_stock_list.map((p) => p.product_name), ['Tênis Que Vende']);
  const cat = (await s.pedir('GET', '/api/catalog')).json;
  const acabando = cat.filter((p) => p.acabando).map((p) => p.name);
  assert.deepEqual(acabando, ['Tênis Que Vende']);   // a Jaqueta vendeu só 1
});

test('as filas mostram só o que é atual', async () => {
  const { filas } = (await s.pedir('GET', '/api/operacao')).json;
  assert.equal(filas.por_embalar.n, 1);      // o de 60 dias não entra
  assert.equal(filas.aguardando_pix.n, 1);   // o de 20 dias é pagamento abandonado
  const lista = (await s.pedir('GET', '/api/operacao/por_embalar')).json;
  assert.deepEqual(lista.map((p) => p.code), ['SITE-1']);
});

test('custo cadastrado depois preenche as vendas que ficaram sem', async () => {
  assert.equal(venda('SITE-1').margin, 800);   // sem custo: tudo parece lucro
  const r = await s.pedir('POST', '/api/custos', { corpo: { itens: [{ variant_id: variante(1001), cost: 120 }] } });
  assert.equal(r.json.vendas_com_custo, 1);
  assert.equal(venda('SITE-1').cost_total, 240);
  assert.equal(venda('SITE-1').margin, 560);

  // Mudar o custo de novo não reescreve o passado.
  await s.pedir('POST', '/api/custos', { corpo: { itens: [{ variant_id: variante(1001), cost: 150 }] } });
  assert.equal(venda('SITE-1').margin, 560);
  // E ler a loja de novo não apaga o custo da venda.
  await lerPedidos();
  assert.equal(venda('SITE-1').margin, 560);
});
