// Cancelar, trocar e devolver venda do PDV: estoque, caixa do dia, lucro
// e relatórios têm que fechar — inclusive quando tudo acontece no mesmo dia.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { subirServidor } from './servidor.js';

let s, V;
const api = async (metodo, caminho, corpo) => {
  const r = await s.pedir(metodo, caminho, { corpo });
  if (r.status >= 400) throw Object.assign(new Error(`${metodo} ${caminho} → ${r.status}: ${r.bytes}`), { status: r.status, json: r.json });
  return r.json;
};
const estoque = (id) => s.banco().prepare('SELECT stock FROM variants WHERE id = ?').get(id).stock;
const venda = (id) => s.banco().prepare('SELECT * FROM sales WHERE id = ?').get(id);

before(async () => {
  s = await subirServidor();   // modo demonstração: catálogo de exemplo
  const prods = await api('GET', '/api/products');
  const achar = (nome, tam) => prods.find((v) => v.product_name.startsWith(nome) && v.variant_name === tam);
  V = { camP: achar('Camiseta', 'P'), camM: achar('Camiseta', 'M'), bone: achar('Boné', 'Único'), berm: achar('Bermuda', 'M') };
});
after(() => s?.parar());

let A;
test('venda paga sem forma de pagamento não passa', async () => {
  await assert.rejects(api('POST', '/api/sales', { items: [{ variant_id: V.bone.id, qty: 1 }] }), (e) => e.status === 400);
});

test('troca: devolve uma peça, leva outra, paga a diferença', async () => {
  const antes = { camP: estoque(V.camP.id), bone: estoque(V.bone.id), berm: estoque(V.berm.id) };
  const r = await api('POST', '/api/sales', { items: [{ variant_id: V.camP.id, qty: 1 }, { variant_id: V.bone.id, qty: 1 }], payment_method: 'Pix' });
  A = s.banco().prepare('SELECT id FROM sales WHERE code = ?').get(r.code).id;
  const det = await api('GET', `/api/vendas/${A}`);
  const linhaCam = det.itens.find((i) => i.variant_id === V.camP.id);

  // Camiseta P (89,90) volta, Bermuda M (149,90) vai: cliente paga 60,00.
  const t = await api('POST', `/api/sales/${A}/troca`, {
    devolver: [{ item_id: linhaCam.id, qty: 1 }], levar: [{ variant_id: V.berm.id, qty: 1 }], forma: 'Dinheiro' });
  assert.equal(t.diferenca, 60);
  assert.equal(venda(A).total, money(89.9 + 129.9 + 60));
  assert.equal(estoque(V.camP.id), antes.camP);          // a camiseta voltou
  assert.equal(estoque(V.bone.id), antes.bone - 1);
  assert.equal(estoque(V.berm.id), antes.berm - 1);      // a bermuda saiu

  // Não dá para devolver a mesma peça duas vezes.
  await assert.rejects(api('POST', `/api/sales/${A}/troca`, { devolver: [{ item_id: linhaCam.id, qty: 1 }] }), (e) => e.status === 400);

  const rel = await api('GET', '/api/relatorios?days=7');
  assert.equal(rel.totais.pecas, 2);                     // boné + bermuda: a camiseta voltou
});

test('devolução sem levar nada: o dinheiro sai do caixa', async () => {
  const det = await api('GET', `/api/vendas/${A}`);
  const bone = det.itens.find((i) => i.variant_id === V.bone.id && i.qty > 0);
  const t = await api('POST', `/api/sales/${A}/troca`, { devolver: [{ item_id: bone.id, qty: 1 }], forma: 'Pix' });
  assert.equal(t.diferenca, -129.9);
  const c = await api('GET', '/api/caixa');
  const por = Object.fromEntries(c.por_forma.map((f) => [f.forma, f.total]));
  assert.deepEqual(por, { Pix: money(89.9 + 129.9 - 129.9), Dinheiro: 60 });
});

test('cancelar: tudo volta e o caixa do dia zera', async () => {
  const c = await api('POST', `/api/sales/${A}/cancelar`, { motivo: 'cliente desistiu' });
  assert.equal(c.estorno, venda(A).total);
  assert.equal(venda(A).payment_status, 'cancelado');
  assert.equal(estoque(V.berm.id), V.berm.stock);        // tudo como antes da venda
  assert.equal(estoque(V.bone.id), V.bone.stock);
  assert.equal(estoque(V.camP.id), V.camP.stock);
  const cx = await api('GET', '/api/caixa');
  assert.equal(cx.balcao, 0);
  const rel = await api('GET', '/api/relatorios?days=7');
  assert.equal(rel.totais.pecas, 0);
  const d = await api('GET', '/api/dashboard');
  assert.equal(d.orders_today, 0);
  // Cancelar de novo não estorna duas vezes.
  assert.equal((await api('POST', `/api/sales/${A}/cancelar`, {})).ja_estava, true);
});

test('fiado cancelado não mexe no caixa e sai do "a receber"', async () => {
  const r = await api('POST', '/api/sales', { items: [{ variant_id: V.camM.id, qty: 1 }], payment_status: 'pendente',
    new_customer: { name: 'Cliente Fiado' } });
  const id = s.banco().prepare('SELECT id FROM sales WHERE code = ?').get(r.code).id;
  assert.equal((await api('GET', '/api/dashboard')).receivable_count, 1);
  const c = await api('POST', `/api/sales/${id}/cancelar`, {});
  assert.equal(c.estorno, 0);
  assert.equal((await api('GET', '/api/dashboard')).receivable_count, 0);
  assert.equal((await api('GET', '/api/caixa')).balcao, 0);
});

function money(n) { return Math.round(n * 100) / 100; }
