// Saúde da máquina: dá para ver de longe se está faltando memória e o que
// veio antes de um travamento — a máquina da Oracle tem só 1 GB.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { subirServidor } from './servidor.js';

const SENHA = 'senha-do-dono';
let s, dono, chave;
const cookieDe = (r, nome) => r.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith(nome + '=') && c.length > nome.length + 1);
before(async () => {
  s = await subirServidor({ APP_PASSWORD: SENHA, SAUDE_A_CADA_MS: '150' });
  dono = cookieDe(await s.pedir('POST', '/api/login', { corpo: { password: SENHA } }), 'vn_auth');
  chave = (await s.pedir('POST', '/api/agente/chave', { headers: { Cookie: dono } })).json.chave;
});
after(() => s?.parar());

test('memória, swap e disco de agora, e as amostras guardadas', async () => {
  await new Promise((ok) => setTimeout(ok, 600));
  const r = await s.pedir('GET', '/api/sistema', { headers: { Cookie: dono } });
  assert.equal(r.status, 200);
  const a = r.json.agora;
  assert.ok(a.memoria_mb.total > 0 && a.memoria_mb.disponivel >= 0);
  assert.ok(a.sistema_mb.rss > 0);
  assert.ok('swap_mb' in a && 'disco' in a);
  assert.ok(r.json.amostras.length >= 2, 'guardou amostras');
  assert.ok(r.json.amostras.every((x) => x.rss > 0 && x.mem_disp >= 0));
});

test('o agente lê (só leitura); sem login, não', async () => {
  assert.equal((await s.pedir('GET', '/api/sistema', { headers: { Authorization: `Bearer ${chave}` } })).status, 200);
  assert.equal((await s.pedir('GET', '/api/sistema')).status, 401);
});
