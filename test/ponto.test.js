// Ponto da equipe: cada pessoa marca entrada e saída com o PIN dela (sem
// entrar no sistema), o dono vê a que horas chegou, quantas horas ficou,
// quantos dias trabalhou e quanto pagar de diária — e paga, sem pagar o
// mesmo dia duas vezes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { subirServidor } from './servidor.js';

const SENHA = 'senha-do-dono';
let s, dono, ana, bia;
const cookieDe = (r, nome) => r.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith(nome + '=') && c.length > nome.length + 1);
const comoDono = (m, c, corpo) => s.pedir(m, c, { corpo, headers: { Cookie: dono } });
const semLogin = (m, c, corpo, headers = {}) => s.pedir(m, c, { corpo, headers });
const dia = (desloc = 0) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(Date.now() + desloc * 864e5));
const pontoDe = async (id, de = dia(-7), ate = dia()) => (await comoDono('GET', `/api/ponto?de=${de}&ate=${ate}`)).json.pessoas.find((p) => p.id === id);

before(async () => {
  s = await subirServidor({ APP_PASSWORD: SENHA });
  dono = cookieDe(await s.pedir('POST', '/api/login', { corpo: { password: SENHA } }), 'vn_auth');
  // Ana é freelancer (não vende): diária de 120, chega às 9h.
  ana = (await comoDono('POST', '/api/team', { name: 'Ana Souza', vende: false, pin: '2468', diaria: '120', chega_as: '09:00' })).json.membro;
  bia = (await comoDono('POST', '/api/team', { name: 'Bia Lima', pin: '1357' })).json.membro;
  await comoDono('POST', '/api/team', { name: 'Caio Sem Pin' });
});
after(() => s?.parar());

test('a tela do ponto abre sem login e mostra só quem tem PIN', async () => {
  const r = await semLogin('GET', '/api/ponto/pessoas');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.pessoas.map((p) => p.nome), ['Ana', 'Bia']);
  assert.equal((await semLogin('GET', '/ponto')).status, 200);
  assert.equal(ana.diaria, 120);
  assert.equal(ana.chega_as, '09:00');
});

test('marca entrada e saída com o PIN; a ordem não se embaralha', async () => {
  assert.equal((await semLogin('POST', '/api/ponto/entrar', { id: ana.id, pin: '0000' })).status, 401);
  const e = await semLogin('POST', '/api/ponto/entrar', { id: ana.id, pin: '2468' });
  assert.equal(e.status, 200);
  assert.equal(e.json.proximo, 'entrada');
  // Saída antes da entrada: não.
  assert.equal((await semLogin('POST', '/api/ponto/marcar', { id: ana.id, pin: '2468', tipo: 'saida' })).status, 409);
  const m = await semLogin('POST', '/api/ponto/marcar', { id: ana.id, pin: '2468', tipo: 'entrada' });
  assert.equal(m.status, 200, String(m.bytes));
  assert.equal(m.json.proximo, 'saida');
  assert.match(m.json.hora, /^\d{2}:\d{2}$/);
  // Tocou duas vezes: não vira duas entradas.
  const dup = await semLogin('POST', '/api/ponto/marcar', { id: ana.id, pin: '2468', tipo: 'entrada' });
  assert.equal(dup.status, 409);
  assert.match(dup.json.error, /já marcou a entrada/);
  // PIN de outra pessoa não marca por ela.
  assert.equal((await semLogin('POST', '/api/ponto/marcar', { id: ana.id, pin: '1357', tipo: 'saida' })).status, 401);
  // Hoje: está trabalhando (entrou, não saiu) — ainda não vai para o "a pagar".
  const p = await pontoDe(ana.id);
  assert.equal(p.hoje.trabalhando, true);
  assert.equal(p.a_pagar.valor, 0);
  assert.equal(p.hoje.marcas[0].onde, 'fora');   // nenhum aparelho da loja marcado ainda
  const sai = await semLogin('POST', '/api/ponto/marcar', { id: ana.id, pin: '2468', tipo: 'saida' });
  assert.equal(sai.status, 200);
  assert.equal(sai.json.hoje.length, 2);
});

test('o dono lança o dia que ela esqueceu: horas, atraso e diária', async () => {
  const ontem = dia(-1);
  for (const [tipo, hora] of [['entrada', '09:30'], ['saida', '12:00'], ['entrada', '13:00'], ['saida', '18:00']]) {
    const r = await comoDono('POST', '/api/ponto/manual', { member_id: ana.id, dia: ontem, tipo, hora });
    assert.equal(r.status, 200, String(r.bytes));
  }
  const p = await pontoDe(ana.id);
  const d = p.dias.find((x) => x.dia === ontem);
  assert.equal(d.chegada, '09:30');
  assert.equal(d.saida, '18:00');
  assert.equal(d.horas, 7.5);          // 2h30 + 5h (o almoço não conta)
  assert.equal(d.atraso, 30);          // chega às 9h
  assert.equal(d.valor, 120);
  assert.ok(d.marcas.every((m) => m.por_dono && m.onde === 'dono'));
  assert.equal(p.resumo.dias, 2);
  assert.equal(p.a_pagar.valor, 240);  // ontem + hoje
  // Dia que não chegou não se marca.
  assert.equal((await comoDono('POST', '/api/ponto/manual', { member_id: ana.id, dia: dia(1), tipo: 'entrada', hora: '09:00' })).status, 400);
});

test('meia diária, marcação apagada com motivo, e pagar sem pagar duas vezes', async () => {
  const ontem = dia(-1);
  assert.equal((await comoDono('POST', '/api/ponto/dia', { member_id: ana.id, dia: dia(), valor: '60', obs: 'meio período' })).status, 200);
  let p = await pontoDe(ana.id);
  assert.equal(p.a_pagar.valor, 180);
  // Apaga uma marcação de ontem (a saída do almoço): continua à vista.
  const almoco = p.dias.find((x) => x.dia === ontem).marcas.find((m) => m.hora === '12:00');
  assert.equal((await comoDono('POST', `/api/ponto/${almoco.id}/apagar`, { motivo: 'marcou errado' })).status, 200);
  p = await pontoDe(ana.id);
  const d = p.dias.find((x) => x.dia === ontem);
  assert.equal(d.marcas.length, 4);
  assert.match(d.marcas.find((m) => m.id === almoco.id).apagado_motivo, /marcou errado/);
  assert.equal(d.horas, 8.5);          // 9:30 → 18:00 sem a saída do almoço (a 2ª entrada é ignorada)

  const pag = await comoDono('POST', '/api/ponto/pagar', { member_id: ana.id, dias: p.a_pagar.dias });
  assert.equal(pag.status, 200, String(pag.bytes));
  assert.equal(pag.json.valor, 180);
  assert.equal(pag.json.dias, 2);
  const fin = (await comoDono('GET', '/api/financial?period=all')).json.entries.find((e) => e.category === 'Diárias');
  assert.equal(fin.amount, 180);
  assert.match(fin.description, /Ana Souza · 2 dias/);
  p = await pontoDe(ana.id);
  assert.equal(p.a_pagar.valor, 0);
  assert.equal(p.resumo.pago, 180);
  // Pagar de novo os mesmos dias: não.
  assert.equal((await comoDono('POST', '/api/ponto/pagar', { member_id: ana.id, dias: [ontem, dia()] })).status, 400);
  // Dia pago não muda de valor nem perde marcação sem desfazer o pagamento.
  assert.equal((await comoDono('POST', '/api/ponto/dia', { member_id: ana.id, dia: ontem, valor: '10' })).status, 400);
  // Desfazer: a despesa some e os dias voltam a pagar.
  assert.equal((await comoDono('DELETE', `/api/ponto/pagamentos/${pag.json.id}`)).status, 200);
  assert.ok(!(await comoDono('GET', '/api/financial?period=all')).json.entries.some((e) => e.category === 'Diárias'));
  assert.equal((await pontoDe(ana.id)).a_pagar.valor, 180);
});

test('aparelho da loja: o que é marcado nele (e na internet dele) aparece como da loja', async () => {
  const r = await comoDono('POST', '/api/ponto/aparelho', { loja: true });
  const aparelho = cookieDe(r, 'vn_aparelho');
  assert.ok(aparelho);
  assert.equal((await semLogin('GET', '/api/ponto/pessoas', null, { Cookie: aparelho })).json.aparelho_da_loja, true);
  await semLogin('POST', '/api/ponto/marcar', { id: bia.id, pin: '1357', tipo: 'entrada' }, { Cookie: aparelho });
  // Outro aparelho na mesma internet (o celular no Wi-Fi da loja).
  await semLogin('POST', '/api/ponto/marcar', { id: bia.id, pin: '1357', tipo: 'saida' });
  const p = await pontoDe(bia.id);
  assert.deepEqual(p.hoje.marcas.map((m) => m.onde), ['aparelho', 'rede']);
  assert.equal(p.diaria, 0);
  assert.equal(p.a_pagar.valor, 0);    // sem diária: o ponto só conta as horas
  // Assinatura falsa não vale.
  assert.equal((await semLogin('GET', '/api/ponto/pessoas', null, { Cookie: 'vn_aparelho=abc.def' })).json.aparelho_da_loja, false);
});

test('o relatório é só do dono; PIN errado 5 vezes trava', async () => {
  assert.equal((await semLogin('GET', '/api/ponto')).status, 401);
  assert.equal((await semLogin('POST', '/api/ponto/pagar', { member_id: ana.id, dias: [dia()] })).status, 401);
  const vend = cookieDe(await s.pedir('POST', '/api/login/vendedor', { corpo: { id: bia.id, pin: '1357' } }), 'vn_vend');
  assert.equal((await s.pedir('GET', '/api/ponto', { headers: { Cookie: vend } })).status, 403);
  // O vendedor logado também bate o ponto pela tela de sempre.
  assert.equal((await s.pedir('POST', '/api/ponto/entrar', { corpo: { id: bia.id, pin: '1357' }, headers: { Cookie: vend } })).status, 200);
  for (let i = 0; i < 5; i++) await semLogin('POST', '/api/ponto/entrar', { id: ana.id, pin: '9999' });
  assert.equal((await semLogin('POST', '/api/ponto/entrar', { id: ana.id, pin: '2468' })).status, 429);
});
