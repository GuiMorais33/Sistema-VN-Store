// Custos: a lista vem por produto (todos os tamanhos juntos), do que mais
// vendeu para o que menos vendeu, e diz por quantos começar — com milhares
// de peças sem custo, o dono precisa saber onde o lucro fica certo primeiro.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { subirServidor } from './servidor.js';

let s;
const api = async (metodo, caminho, corpo) => {
  const r = await s.pedir(metodo, caminho, { corpo });
  if (r.status >= 400) throw new Error(`${metodo} ${caminho} → ${r.status}: ${r.bytes}`);
  return r.json;
};

before(async () => {
  s = await subirServidor();   // modo demonstração: catálogo de exemplo, já com custo
  // Começa como a loja real: nenhum custo preenchido.
  const todas = (await api('GET', '/api/custos?tudo=1')).variantes;
  await api('POST', '/api/custos', { itens: todas.map((v) => ({ variant_id: v.id, cost: 0 })) });
  const prods = await api('GET', '/api/products');
  const achar = (nome, tam) => prods.find((v) => v.product_name.startsWith(nome) && v.variant_name === tam);
  // A camiseta vende bem mais que o boné.
  await api('POST', '/api/sales', { items: [{ variant_id: achar('Camiseta', 'M').id, qty: 6 },
    { variant_id: achar('Boné', 'Único').id, qty: 1 }], payment_method: 'Pix' });
});
after(() => s?.parar());

test('o que mais vendeu vem primeiro, com os tamanhos juntos', async () => {
  const c = await api('GET', '/api/custos?falta=1');
  const ids = c.variantes.map((v) => v.product_id);
  assert.match(c.variantes[0].product_name, /^Camiseta/);
  // Cada produto aparece num bloco só — nunca um tamanho perdido lá embaixo.
  const blocos = ids.filter((id, i) => id !== ids[i - 1]);
  assert.equal(blocos.length, new Set(ids).size);
  assert.ok(c.variantes.filter((v) => v.product_id === ids[0]).length > 1);
});

test('diz por quantos produtos começar e conta produtos, não tamanhos', async () => {
  const antes = (await api('GET', '/api/custos?falta=1')).resumo;
  assert.equal(antes.primeiros_80, 1);            // só a camiseta já é mais de 80%
  assert.ok(antes.sem_custo > antes.produtos_sem_custo);

  // Preencher o produto inteiro (todos os tamanhos) tira ele da conta.
  const camiseta = (await api('GET', '/api/custos?falta=1')).variantes.filter((v) => v.product_name.startsWith('Camiseta'));
  await api('POST', '/api/custos', { itens: camiseta.map((v) => ({ variant_id: v.id, cost: 40 })) });
  const depois = (await api('GET', '/api/custos?falta=1')).resumo;
  assert.equal(depois.produtos_sem_custo, antes.produtos_sem_custo - 1);
  assert.equal(depois.primeiros_80, 1);            // agora só falta o boné entre os vendidos
  assert.equal(depois.vendido_sem_custo, 129.9);
});
