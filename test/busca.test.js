// Busca do jeito que as pessoas digitam: com ou sem acento, maiúscula ou
// minúscula. Na loja real, "TÊNIS" não achava nenhum dos 146 tênis.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { subirServidor } from './servidor.js';

let s;
const get = async (c) => (await s.pedir('GET', c)).json;
before(async () => {
  s = await subirServidor();   // modo demonstração: tem o "Boné Branco Aba Curva"
  await s.pedir('POST', '/api/customers', { corpo: { name: 'José Ávila' } });
});
after(() => s?.parar());

for (const q of ['BONE', 'bone', 'Boné', 'BONÉ', 'boné branco']) {
  test(`"${q}" acha o boné no Estoque, no PDV e nos Custos`, async () => {
    const e = encodeURIComponent(q);
    assert.ok((await get(`/api/catalog?q=${e}`)).some((p) => p.name.startsWith('Boné')), 'Estoque');
    assert.ok((await get(`/api/products?q=${e}`)).some((v) => v.product_name.startsWith('Boné')), 'PDV');
    assert.ok((await get(`/api/custos?tudo=1&q=${e}`)).variantes.some((v) => v.product_name.startsWith('Boné')), 'Custos');
  });
}

test('categoria também conta: buscar a categoria acha os produtos dela', async () => {
  const cat = (await get('/api/catalog')).find((p) => p.name.startsWith('Boné')).category;
  assert.ok(cat);
  const r = await get(`/api/catalog?q=${encodeURIComponent(cat.toUpperCase())}`);
  assert.ok(r.some((p) => p.name.startsWith('Boné')));
});

test('cliente com acento acha digitando sem acento', async () => {
  const r = await get('/api/customers?q=jose%20avila');
  assert.ok(r.some((c) => c.name === 'José Ávila'));
});
