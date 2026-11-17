// No Financeiro, cada movimentação de venda mostra o cliente (e de onde
// veio, quem vendeu): a mesma venda se reconhece no PDV, no site e aqui —
// inclusive troca, cancelamento e recebimento de fiado, que são da mesma venda.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { subirServidor } from './servidor.js';

let s, v;
before(async () => {
  s = await subirServidor();
  v = (await s.pedir('GET', '/api/products')).json.filter((x) => x.stock_management).sort((a, b) => b.stock - a.stock)[0];
});
after(() => s?.parar());

const mov = async () => (await s.pedir('GET', '/api/financial?period=month')).json.entries;

test('a entrada da venda traz o cliente, a origem e a forma', async () => {
  const r = await s.pedir('POST', '/api/sales', { corpo: { items: [{ variant_id: v.id, qty: 1 }], payment_method: 'Pix',
    canal: 'whatsapp', new_customer: { name: 'Maria Souza' } } });
  assert.equal(r.status, 200, String(r.bytes));
  const e = (await mov()).find((x) => x.ref === r.json.code);
  assert.equal(e.cliente, 'Maria Souza');
  assert.equal(e.venda_onde, 'whatsapp');
  assert.equal(e.forma, 'Pix');
  assert.ok(e.venda_id);
});

test('cancelamento e recebimento de fiado: o mesmo cliente da venda', async () => {
  const fiado = await s.pedir('POST', '/api/sales', { corpo: { items: [{ variant_id: v.id, qty: 1 }], payment_status: 'pendente',
    new_customer: { name: 'João Fiado' } } });
  const id = s.banco().prepare('SELECT id FROM sales WHERE code = ?').get(fiado.json.code).id;
  await s.pedir('POST', `/api/sales/${id}/settle`, { corpo: { payment_method: 'Dinheiro' } });
  await s.pedir('POST', `/api/sales/${id}/cancelar`, { corpo: { motivo: 'teste', forma: 'Dinheiro' } });
  const daVenda = (await mov()).filter((x) => x.ref === fiado.json.code);
  assert.equal(daVenda.length, 2);   // recebimento e estorno
  assert.ok(daVenda.every((x) => x.cliente === 'João Fiado'));
});

test('despesa não é venda: sem cliente', async () => {
  await s.pedir('POST', '/api/financial/entry', { corpo: { type: 'despesa', category: 'Aluguel', description: 'Aluguel', amount: 100 } });
  const e = (await mov()).find((x) => x.description === 'Aluguel');
  assert.ok(e);
  assert.equal(e.venda_id, null);
  assert.equal(e.cliente, null);
});
