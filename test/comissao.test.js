// A comissão segue o dinheiro: entra o que foi pago pelas vendas do
// vendedor no mês; fiado só quando o cliente paga; troca e cancelamento
// descontam no dia em que acontecem; pagar vira despesa no financeiro.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { subirServidor } from './servidor.js';

let s, ana, V, A, B;
const api = async (metodo, caminho, corpo, headers) => {
  const r = await s.pedir(metodo, caminho, { corpo, headers });
  if (r.status >= 400) throw Object.assign(new Error(`${metodo} ${caminho} → ${r.status}: ${r.bytes}`), { status: r.status });
  return r.json;
};
const comissao = async () => (await api('GET', '/api/comissoes')).pessoas.find((p) => p.id === ana.id);
const codigoParaId = (code) => s.banco().prepare('SELECT id FROM sales WHERE code = ?').get(code).id;

before(async () => {
  s = await subirServidor();   // modo demonstração
  ana = (await api('POST', '/api/team', { name: 'Ana', commission_pct: 10, pin: '2468' })).membro;
  const prods = await api('GET', '/api/products');
  const achar = (nome, tam) => prods.find((v) => v.product_name.startsWith(nome) && v.variant_name === tam);
  V = { cam: achar('Camiseta', 'P'), bone: achar('Boné', 'Único') };
});
after(() => s?.parar());

test('venda paga entra; fiado só quando o cliente paga', async () => {
  A = codigoParaId((await api('POST', '/api/sales', { items: [{ variant_id: V.cam.id, qty: 1 }], payment_method: 'Pix', seller_id: ana.id })).code);
  B = codigoParaId((await api('POST', '/api/sales', { items: [{ variant_id: V.bone.id, qty: 1 }], payment_status: 'pendente',
    seller_id: ana.id, new_customer: { name: 'Cliente Fiado' } })).code);
  let c = await comissao();
  assert.equal(c.base, 89.9);
  assert.equal(c.vendas, 2);
  await api('POST', `/api/sales/${B}/settle`, { payment_method: 'Pix' });
  c = await comissao();
  assert.equal(c.base, 219.8);
  assert.equal(c.devido, 21.98);
  assert.equal(c.a_pagar, 21.98);
});

test('pagar vira despesa "Comissões" e zera o que falta', async () => {
  const r = await api('POST', '/api/comissoes/pagar', { member_id: ana.id });
  assert.equal(r.pago, 21.98);
  assert.equal(r.comissao.a_pagar, 0);
  const fin = await api('GET', '/api/financial?period=month');
  assert.ok(fin.por_categoria_despesa.some((x) => x.label === 'Comissões' && x.total === 21.98));
  // Pagar de novo sem nada novo não deixa.
  await assert.rejects(api('POST', '/api/comissoes/pagar', { member_id: ana.id }), (e) => e.status === 400);
});

test('devolução depois do pagamento desconta — e aparece como pago a mais', async () => {
  const det = await api('GET', `/api/vendas/${A}`);
  await api('POST', `/api/sales/${A}/troca`, { devolver: [{ item_id: det.itens[0].id, qty: 1 }], forma: 'Pix' });
  const c = await comissao();
  assert.equal(c.base, 129.9);
  assert.equal(c.devido, 12.99);
  assert.equal(c.a_pagar, -8.99);
});

test('desfazer o pagamento tira a despesa e a comissão volta a ficar a pagar', async () => {
  const c0 = await comissao();
  await api('DELETE', `/api/comissoes/${c0.pagamentos[0].id}`);
  const c = await comissao();
  assert.equal(c.pago, 0);
  assert.equal(c.a_pagar, 12.99);
  const fin = await api('GET', '/api/financial?period=month');
  assert.ok(!fin.por_categoria_despesa.some((x) => x.label === 'Comissões'));
});

test('a Equipe e a página do vendedor mostram o mesmo número', async () => {
  const metas = await api('GET', '/api/metas');
  assert.equal(metas.pessoas.find((p) => p.id === ana.id).vendido, 129.9);
  const r = await s.pedir('POST', '/api/login/vendedor', { corpo: { id: ana.id, pin: '2468' } });
  const ck = r.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith('vn_vend=') && c.length > 8);
  const minhas = await api('GET', '/api/minhas', null, { Cookie: ck });
  assert.equal(minhas.nome, 'Ana');
  assert.equal(minhas.comissao.base, 129.9);
  assert.equal(minhas.ultimas.length, 2);
});

test('o sonho fecha a conta só com as vendas, sem atendimento anotado', async () => {
  await api('POST', '/api/sonhos', { member_id: ana.id, titulo: 'A moto', valor: 1000, comissao_pct: 10,
    prazo_meses: 10, ticket_manual: 100 });
  const p = (await api('GET', '/api/sonhos')).pessoas.find((x) => x.id === ana.id);
  assert.equal(p.conta.modo, 'vendas');
  assert.equal(p.conta.faturar, 10000);
  assert.equal(p.conta.vendas, 100);
  assert.equal(p.conta.vendas_mes, 10);
  // Conta a comissão do que entrou DEPOIS que o sonho foi escrito.
  assert.equal(p.sonho.ganho, 0);
  await api('POST', '/api/sales', { items: [{ variant_id: V.cam.id, qty: 1 }], payment_method: 'Pix', seller_id: ana.id });
  const depois = (await api('GET', '/api/sonhos')).pessoas.find((x) => x.id === ana.id);
  assert.equal(depois.sonho.ganho, 8.99);
});

test('venda lançada no nome errado: corrigir leva a comissão junto', async () => {
  const bruno = (await api('POST', '/api/team', { name: 'Bruno', commission_pct: 10 })).membro;
  const code = (await api('POST', '/api/sales', { items: [{ variant_id: V.bone.id, qty: 1 }], payment_method: 'Pix', seller_id: ana.id })).code;
  const antes = (await comissao()).base;
  await api('POST', `/api/sales/${codigoParaId(code)}/vendedor`, { seller_id: bruno.id });
  assert.equal((await comissao()).base, Math.round((antes - 129.9) * 100) / 100);
  const b = (await api('GET', '/api/comissoes')).pessoas.find((p) => p.id === bruno.id);
  assert.equal(b.base, 129.9);
  // Pedido do site não tem vendedor para trocar.
  await assert.rejects(api('POST', '/api/sales/999999/vendedor', { seller_id: bruno.id }), (e) => e.status === 404);
});

test('venda pela internet conta no vendido, mas não gera comissão; corrigir o canal muda', async () => {
  const c0 = await comissao();
  const code = (await api('POST', '/api/sales', { items: [{ variant_id: V.cam.id, qty: 1 }], payment_method: 'Pix',
    seller_id: ana.id, canal: 'whatsapp' })).code;
  let c = await comissao();
  assert.equal(c.vendido, Math.round((c0.vendido + 89.9) * 100) / 100);
  assert.equal(c.base, c0.base);              // comissão não mexe
  assert.equal(c.internet, Math.round((c0.internet + 89.9) * 100) / 100);
  // Era balcão, marcaram WhatsApp por engano: corrigindo, entra na comissão.
  await api('POST', `/api/sales/${codigoParaId(code)}/vendedor`, { canal: 'balcao' });
  c = await comissao();
  assert.equal(c.base, Math.round((c0.base + 89.9) * 100) / 100);
  assert.equal(s.banco().prepare('SELECT seller_id FROM sales WHERE code = ?').get(code).seller_id, ana.id);   // o vendedor fica
});
