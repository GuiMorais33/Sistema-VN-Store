// Compra: o que vendeu e acabou vira sugestão; o pedido ao fornecedor tira
// da sugestão até chegar; a entrada fecha o pedido, põe o frete dentro do
// custo da peça e mostra quanto da compra já vendeu.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { subirServidor } from './servidor.js';

let s, V, pedido;
const api = async (metodo, caminho, corpo) => {
  const r = await s.pedir(metodo, caminho, { corpo });
  if (r.status >= 400) throw Object.assign(new Error(`${metodo} ${caminho} → ${r.status}: ${r.bytes}`), { status: r.status });
  return r.json;
};
const custo = (id) => s.banco().prepare('SELECT cost FROM variants WHERE id = ?').get(id).cost;
const sugestaoDe = (r, vid) => r.produtos.flatMap((p) => p.tamanhos).find((t) => t.variant_id === vid)?.sugestao || 0;

before(async () => {
  s = await subirServidor();   // modo demonstração
  const prods = await api('GET', '/api/products');
  const achar = (nome, tam) => prods.find((v) => v.product_name.startsWith(nome) && v.variant_name === tam);
  V = { bermG: achar('Bermuda', 'G'), camP: achar('Camiseta', 'P') };
  // A bermuda G tem 2 e as 2 saem: acabou.
  await api('POST', '/api/sales', { items: [{ variant_id: V.bermG.id, qty: V.bermG.stock }], payment_method: 'Pix' });
});
after(() => s?.parar());

test('vendeu e acabou: entra na reposição, com a sugestão do que saiu', async () => {
  const r = await api('GET', '/api/repor?dias=30');
  assert.equal(sugestaoDe(r, V.bermG.id), V.bermG.stock);
  // O que vendeu mas ainda tem de sobra não aparece.
  assert.ok(!r.produtos.some((p) => p.nome.startsWith('Corrente')));
});

test('pedido ao fornecedor tira da sugestão; cancelar devolve', async () => {
  const c = await api('POST', '/api/pedidos', { supplier_name: 'Fornecedor Bermudas', items: [{ variant_id: V.bermG.id, qty: 2 }] });
  assert.match(c.pedido.code, /^PC-/);
  assert.equal(sugestaoDe(await api('GET', '/api/repor'), V.bermG.id), 0);
  await api('PATCH', `/api/pedidos/${c.pedido.id}`, { status: 'cancelado' });
  assert.equal(sugestaoDe(await api('GET', '/api/repor'), V.bermG.id), 2);
  pedido = (await api('POST', '/api/pedidos', { supplier_name: 'Fornecedor Bermudas', items: [{ variant_id: V.bermG.id, qty: 2 }] })).pedido;
  assert.equal((await api('GET', '/api/pedidos?status=aberto')).length, 1);
});

test('a entrada fecha o pedido e o frete vai para o custo de cada peça', async () => {
  // Itens: 2 × 50 + 1 × 30 = 130; frete 20 dividido pelo valor de cada item.
  const r = await api('POST', '/api/purchases', { supplier_name: 'Fornecedor Bermudas', pedido_id: pedido.id, freight: 20,
    items: [{ variant_id: V.bermG.id, qty: 2, unit_cost: 50 }, { variant_id: V.camP.id, qty: 1, unit_cost: 30 }] });
  assert.equal(r.total, 150);
  assert.equal(r.pedido, pedido.code);
  assert.equal(custo(V.bermG.id), 57.69);   // 50 + (20 × 100/130) ÷ 2
  assert.equal(custo(V.camP.id), 34.62);    // 30 + (20 × 30/130)
  assert.equal((await api('GET', `/api/pedidos/${pedido.id}`)).status, 'chegou');
  assert.equal((await api('GET', '/api/pedidos?status=aberto')).length, 0);
  // Agora o produto tem fornecedor: a próxima reposição já vem no grupo dele.
  await api('POST', '/api/sales', { items: [{ variant_id: V.bermG.id, qty: 2 }], payment_method: 'Pix' });
  const rep = await api('GET', '/api/repor');
  assert.equal(rep.produtos.find((p) => p.tamanhos.some((t) => t.variant_id === V.bermG.id)).fornecedor.nome, 'Fornecedor Bermudas');
});

test('giro: a entrada mostra quanto dela já vendeu', async () => {
  const h = await api('GET', '/api/purchases?days=30');
  const e = h.compras[0];
  assert.equal(e.items_count, 3);
  assert.equal(e.vendidas, 2);   // as 2 bermudas vendidas depois que chegaram; a camiseta não
});
