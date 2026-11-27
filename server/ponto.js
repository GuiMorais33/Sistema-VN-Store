// ============================================================
//  Ponto da equipe.
//
//  Para que serve: saber a que horas cada um chegou e saiu, e quantos dias
//  trabalhou — o freelancer recebe por dia (diária), então é daqui que sai
//  quanto pagar.
//
//  Como funciona:
//   - a pessoa abre /ponto (no computador da loja ou no celular), toca no
//     nome, digita o PIN dela (o mesmo da Equipe) e marca ENTRADA ou SAÍDA.
//     Não precisa entrar no sistema: o PIN só marca o ponto.
//   - a hora é a do servidor, não a do aparelho: ninguém adianta o relógio
//     do celular para "chegar mais cedo".
//   - cada marcação guarda ONDE foi feita: no aparelho da loja (o dono marca
//     o computador da loja uma vez), na internet da loja (o celular no
//     Wi-Fi da loja) ou fora. Não trava ninguém — só mostra ao dono.
//   - o dono corrige (esqueceu de marcar, marcou errado) e cada correção
//     fica à vista: marcação lançada pelo dono aparece como tal, e a apagada
//     continua lá, riscada, com o motivo.
//   - diária: dia com entrada vale a diária da pessoa; o dono pode mudar o
//     valor de um dia (meia diária, um extra). "Pagar" lança a despesa
//     "Diárias" no financeiro e marca os dias como pagos — não paga duas vezes.
// ============================================================
import crypto from 'node:crypto';
import db, { getSetting, setSetting, categoryId } from './db.js';
import { diaLocal, inicioDoDia } from './fuso.js';

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
const now = () => new Date().toISOString();
const TIPOS = ['entrada', 'saida'];
const ehDia = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
const ehHora = (h) => /^([01]\d|2[0-3]):[0-5]\d$/.test(h || '');
const pad = (n) => String(n).padStart(2, '0');
const horaDe = (iso) => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
// Minutos desde a meia-noite (fuso da loja) do dia da marcação.
const minutosNoDia = (iso, dia) => Math.round((new Date(iso).getTime() - new Date(inicioDoDia(dia)).getTime()) / 60e3);
const somaDias = (dia, n) => diaLocal(new Date(new Date(inicioDoDia(dia)).getTime() + n * 864e5 + 12 * 3600e3));
// Quanto tempo atrás o "a pagar" olha: dia trabalhado mais velho que isso
// e não pago é esquecido (o sistema não cobra para sempre).
const A_PAGAR_DIAS = 120;

// O dia de trabalho de uma pessoa, a partir das marcações (sem as apagadas):
// chegada, saída, horas (entrada → saída, quantas vezes tiver — o almoço
// fora conta como uma saída e uma entrada), se ficou sem saída, o atraso
// e o valor do dia.
export function montarDia(m, dia, marcas, ajuste, hoje) {
  const validas = marcas.filter((x) => !x.apagado_em).sort((a, b) => a.quando.localeCompare(b.quando) || a.id - b.id);
  let aberta = null, minutos = 0;
  for (const x of validas) {
    if (x.tipo === 'entrada') { if (!aberta) aberta = x; }
    else if (aberta) { minutos += (new Date(x.quando) - new Date(aberta.quando)) / 60e3; aberta = null; }
  }
  const entradas = validas.filter((x) => x.tipo === 'entrada');
  const saidas = validas.filter((x) => x.tipo === 'saida');
  const chegada = entradas[0] || null;
  let atraso = null;
  if (chegada && ehHora(m.chega_as)) {
    const [h, mi] = m.chega_as.split(':').map(Number);
    const dif = minutosNoDia(chegada.quando, dia) - (h * 60 + mi);
    if (dif > 5) atraso = dif;   // até 5 minutos é chegar na hora
  }
  const trabalhou = entradas.length > 0;
  const padrao = trabalhou ? money(m.diaria) : 0;
  const valor = ajuste && ajuste.valor != null ? money(ajuste.valor) : padrao;
  return {
    dia,
    marcas: marcas.sort((a, b) => a.quando.localeCompare(b.quando) || a.id - b.id).map((x) => ({
      id: x.id, tipo: x.tipo, quando: x.quando, hora: horaDe(x.quando), onde: x.onde, por_dono: Boolean(x.por_dono),
      obs: x.obs || null, apagado_em: x.apagado_em || null, apagado_motivo: x.apagado_motivo || null })),
    chegada: chegada ? horaDe(chegada.quando) : null,
    saida: saidas.length ? horaDe(saidas[saidas.length - 1].quando) : null,
    horas: Math.round((minutos / 60) * 100) / 100,
    // Entrou e não saiu: hoje, está trabalhando; outro dia, esqueceu a saída.
    aberto: Boolean(aberta), trabalhando: Boolean(aberta) && dia === hoje,
    atraso,
    // Marcou fora do aparelho e da internet da loja (o dono confere).
    fora: validas.some((x) => x.onde === 'fora'),
    valor, valor_padrao: padrao, valor_mudado: Boolean(ajuste && ajuste.valor != null), obs: ajuste ? ajuste.obs || null : null,
    pago: Boolean(ajuste && ajuste.pagamento_id), pagamento_id: ajuste ? ajuste.pagamento_id || null : null,
    valor_pago: ajuste && ajuste.pagamento_id ? money(ajuste.valor_pago) : null,
  };
}

export function registrarPonto(app, { hashPin, readCookies, segredo, pin, quemFez }) {
  // ---- Aparelho e internet da loja ----
  const assinar = (id) => crypto.createHmac('sha256', segredo).update(`aparelho:${id}`).digest('hex');
  function aparelhoDaLoja(req) {
    const [id, sig] = String(readCookies(req).vn_aparelho || '').split('.');
    if (!id || !sig) return false;
    const certo = assinar(id);
    return certo.length === sig.length && crypto.timingSafeEqual(Buffer.from(certo), Buffer.from(sig));
  }
  // A internet de onde veio o pedido, guardada só como um código (não o
  // endereço): dá para saber se é a mesma da loja sem guardar o endereço.
  const redeDe = (req) => crypto.createHash('sha256').update(`${segredo}:rede:${req.ip || ''}`).digest('hex').slice(0, 32);
  const redesDaLoja = () => { try { return JSON.parse(getSetting('ponto_redes_loja') || '{}'); } catch (_) { return {}; } };
  function anotarRede(req) {
    const r = redesDaLoja();
    r[redeDe(req)] = now();
    // A internet da loja muda de endereço de vez em quando: guarda as do
    // último mês, no máximo 10.
    const limite = Date.now() - 30 * 864e5;
    const ficam = Object.entries(r).filter(([, q]) => new Date(q).getTime() >= limite).sort((a, b) => b[1].localeCompare(a[1])).slice(0, 10);
    setSetting('ponto_redes_loja', JSON.stringify(Object.fromEntries(ficam)));
  }
  function ondeFoi(req) {
    if (aparelhoDaLoja(req)) { anotarRede(req); return 'aparelho'; }
    const visto = redesDaLoja()[redeDe(req)];
    return visto && Date.now() - new Date(visto).getTime() < 30 * 864e5 ? 'rede' : 'fora';
  }

  // ---- Quem bate ponto: quem está na equipe e tem PIN ----
  const pessoas = () => db.prepare('SELECT id, name FROM team_members WHERE active = 1 AND pin_hash IS NOT NULL ORDER BY name').all();
  // Primeiro nome; se dois têm o mesmo, vai a inicial do sobrenome junto.
  function rotulos(lista) {
    const prim = (n) => String(n).trim().split(/\s+/)[0];
    const conta = {};
    for (const m of lista) conta[prim(m.name)] = (conta[prim(m.name)] || 0) + 1;
    return lista.map((m) => {
      const partes = String(m.name).trim().split(/\s+/);
      return { id: m.id, nome: conta[partes[0]] > 1 && partes[1] ? `${partes[0]} ${partes[1][0]}.` : partes[0] };
    });
  }
  app.get('/api/ponto/pessoas', (req, res) => {
    const loja = aparelhoDaLoja(req);
    if (loja) anotarRede(req);
    res.json({ pessoas: rotulos(pessoas()), aparelho_da_loja: loja, agora: now() });
  });

  // ---- Marcar (com o PIN) ----
  function conferirPin(req, res) {
    const b = req.body || {};
    const id = Number(b.id);
    if (pin.travado(id)) { res.status(429).json({ error: 'Muitas tentativas. Espere 5 minutos ou peça ao dono.' }); return null; }
    const m = db.prepare('SELECT id, name, pin_hash, chega_as, diaria FROM team_members WHERE id = ? AND active = 1').get(id);
    if (!m || !m.pin_hash || hashPin(m.id, String(b.pin || '').trim()) !== m.pin_hash) {
      pin.errou(id);
      res.status(401).json({ error: 'PIN errado.' });
      return null;
    }
    pin.certo(id);
    return m;
  }
  const marcasDoDia = (mid, dia) => db.prepare(`SELECT id, tipo, quando, onde, por_dono FROM ponto
    WHERE member_id = ? AND dia = ? AND apagado_em IS NULL ORDER BY quando, id`).all(mid, dia);
  // Entrou → a próxima é a saída; saiu (ou nada hoje) → a próxima é a entrada.
  const proximo = (marcas) => (marcas.length && marcas[marcas.length - 1].tipo === 'entrada' ? 'saida' : 'entrada');
  const doDia = (m) => {
    const marcas = marcasDoDia(m.id, diaLocal());
    return { hoje: marcas.map((x) => ({ tipo: x.tipo, hora: horaDe(x.quando) })), proximo: proximo(marcas) };
  };
  app.post('/api/ponto/entrar', (req, res) => {
    const m = conferirPin(req, res);
    if (!m) return;
    res.json({ id: m.id, nome: String(m.name).trim().split(/\s+/)[0], ...doDia(m) });
  });
  app.post('/api/ponto/marcar', (req, res) => {
    const m = conferirPin(req, res);
    if (!m) return;
    const tipo = (req.body || {}).tipo;
    if (!TIPOS.includes(tipo)) return res.status(400).json({ error: 'Escolha entrada ou saída.' });
    const dia = diaLocal(), marcas = marcasDoDia(m.id, dia), certo = proximo(marcas);
    // Dois toques seguidos não viram duas entradas: a ordem é sempre
    // entrada, saída, entrada…
    if (tipo !== certo) {
      const ult = marcas[marcas.length - 1];
      return res.status(409).json({ error: tipo === 'entrada' ? `Você já marcou a entrada às ${horaDe(ult.quando)}. A próxima é a saída.`
        : 'A entrada de hoje ainda não foi marcada. Marque a entrada primeiro.', ...doDia(m) });
    }
    const quando = now();
    db.prepare(`INSERT INTO ponto (member_id, tipo, quando, dia, onde, por_dono, created_at) VALUES (?,?,?,?,?,0,?)`)
      .run(m.id, tipo, quando, dia, ondeFoi(req), quando);
    res.json({ ok: true, tipo, hora: horaDe(quando), nome: String(m.name).trim().split(/\s+/)[0], ...doDia(m) });
  });

  // ================= DO DONO =================
  // O ponto do período, pessoa por pessoa, dia por dia; o que está a pagar
  // de diária (de todos os dias ainda não pagos, não só do período); e
  // quem está na loja agora.
  app.get('/api/ponto', (req, res) => {
    const hoje = diaLocal();
    let ate = ehDia(req.query.ate) ? req.query.ate : hoje;
    let de = ehDia(req.query.de) ? req.query.de : somaDias(hoje, -((new Date(inicioDoDia(hoje)).getDay() + 6) % 7));   // segunda desta semana
    if (de > ate) [de, ate] = [ate, de];
    if (de < somaDias(ate, -400)) de = somaDias(ate, -400);
    const desdePagar = somaDias(hoje, -A_PAGAR_DIAS);
    const inicio = de < desdePagar ? de : desdePagar;
    const membros = db.prepare(`SELECT id, name, role, diaria, chega_as, active, pin_hash IS NOT NULL tem_pin FROM team_members
      WHERE (active = 1 AND pin_hash IS NOT NULL) OR id IN (SELECT DISTINCT member_id FROM ponto WHERE dia >= ?)
      ORDER BY active DESC, name`).all(inicio);
    const todasMarcas = db.prepare('SELECT * FROM ponto WHERE member_id = ? AND dia >= ? AND dia <= ? ORDER BY quando, id');
    const ajustes = db.prepare('SELECT * FROM ponto_dias WHERE member_id = ? AND dia >= ?');
    const pags = db.prepare('SELECT * FROM ponto_pagamentos WHERE member_id = ? ORDER BY id DESC LIMIT 5');
    const saida = membros.map((m) => {
      const porDia = new Map();
      for (const x of todasMarcas.all(m.id, inicio, hoje > ate ? hoje : ate)) {
        if (!porDia.has(x.dia)) porDia.set(x.dia, []);
        porDia.get(x.dia).push(x);
      }
      const aj = new Map(ajustes.all(m.id, inicio).map((a) => [a.dia, a]));
      // Dia com valor mudado pelo dono mas sem marcação (pagou um dia sem
      // ponto, por exemplo) também aparece.
      for (const d of aj.keys()) if (!porDia.has(d) && aj.get(d).valor != null) porDia.set(d, []);
      const dias = [...porDia.keys()].sort().map((d) => montarDia(m, d, porDia.get(d), aj.get(d), hoje));
      const doPeriodo = dias.filter((d) => d.dia >= de && d.dia <= ate).reverse();
      const trabalhados = doPeriodo.filter((d) => d.chegada || d.valor_mudado);
      const aPagar = dias.filter((d) => d.dia >= desdePagar && !d.pago && d.valor > 0 && !d.trabalhando);
      const hojeDia = dias.find((d) => d.dia === hoje) || null;
      return {
        id: m.id, nome: m.name, funcao: m.role, diaria: money(m.diaria), chega_as: m.chega_as || null,
        ativo: Boolean(m.active), tem_pin: Boolean(m.tem_pin),
        hoje: hojeDia,
        dias: doPeriodo,
        resumo: {
          dias: trabalhados.length,
          horas: Math.round(doPeriodo.reduce((t, d) => t + d.horas, 0) * 100) / 100,
          atrasos: doPeriodo.filter((d) => d.atraso).length,
          sem_saida: doPeriodo.filter((d) => d.aberto && !d.trabalhando).length,
          fora: doPeriodo.filter((d) => d.fora).length,
          valor: money(doPeriodo.reduce((t, d) => t + d.valor, 0)),
          pago: money(doPeriodo.filter((d) => d.pago).reduce((t, d) => t + d.valor_pago, 0)),
        },
        a_pagar: { valor: money(aPagar.reduce((t, d) => t + d.valor, 0)), dias: aPagar.map((d) => d.dia),
          sem_saida: aPagar.filter((d) => d.aberto).length },
        pagamentos: pags.all(m.id),
      };
    });
    res.json({ de, ate, hoje, aparelho_da_loja: aparelhoDaLoja(req), pessoas: saida });
  });

  // O dono marca o computador (ou tablet) da loja: o que for marcado nele
  // aparece como "no aparelho da loja", e a internet dele vira a da loja.
  app.post('/api/ponto/aparelho', (req, res) => {
    const loja = (req.body || {}).loja !== false;
    if (loja) {
      const id = crypto.randomBytes(9).toString('hex');
      res.setHeader('Set-Cookie', `vn_aparelho=${id}.${assinar(id)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 400}`);
      // A internet de agora já é a da loja.
      const r = redesDaLoja(); r[redeDe(req)] = now(); setSetting('ponto_redes_loja', JSON.stringify(r));
    } else {
      res.setHeader('Set-Cookie', 'vn_aparelho=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    }
    res.json({ ok: true, aparelho_da_loja: loja });
  });

  // Esqueceu de marcar: o dono lança a hora (fica marcado "lançado pelo dono").
  app.post('/api/ponto/manual', (req, res) => {
    const b = req.body || {};
    const m = db.prepare('SELECT id FROM team_members WHERE id = ?').get(Number(b.member_id));
    if (!m) return res.status(404).json({ error: 'Pessoa não encontrada.' });
    if (!TIPOS.includes(b.tipo)) return res.status(400).json({ error: 'Escolha entrada ou saída.' });
    if (!ehDia(b.dia) || !ehHora(b.hora)) return res.status(400).json({ error: 'Informe o dia e a hora (ex.: 09:30).' });
    if (b.dia > diaLocal()) return res.status(400).json({ error: 'Não dá para marcar um dia que ainda não chegou.' });
    const [h, mi] = b.hora.split(':').map(Number);
    const quando = new Date(new Date(inicioDoDia(b.dia)).getTime() + (h * 60 + mi) * 60e3).toISOString();
    if (quando > now()) return res.status(400).json({ error: 'Essa hora ainda não chegou.' });
    const obs = String(b.obs || '').trim().slice(0, 200) || `lançado por ${quemFez(req)}`;
    const id = db.prepare(`INSERT INTO ponto (member_id, tipo, quando, dia, onde, por_dono, obs, created_at) VALUES (?,?,?,?, 'dono', 1, ?, ?)`)
      .run(m.id, b.tipo, quando, b.dia, obs, now()).lastInsertRowid;
    res.json({ ok: true, id });
  });

  // Apagar uma marcação errada: some das contas, mas continua à vista
  // (riscada, com o motivo).
  app.post('/api/ponto/:id/apagar', (req, res) => {
    const x = db.prepare('SELECT * FROM ponto WHERE id = ?').get(req.params.id);
    if (!x) return res.status(404).json({ error: 'Marcação não encontrada.' });
    if (x.apagado_em) return res.json({ ok: true, ja_estava: true });
    const pago = db.prepare('SELECT pagamento_id FROM ponto_dias WHERE member_id = ? AND dia = ?').get(x.member_id, x.dia);
    if (pago && pago.pagamento_id) return res.status(400).json({ error: 'Este dia já foi pago. Desfaça o pagamento antes de mexer nas marcações dele.' });
    const motivo = String((req.body || {}).motivo || '').trim().slice(0, 200);
    db.prepare('UPDATE ponto SET apagado_em = ?, apagado_motivo = ? WHERE id = ?').run(now(), `${motivo || 'sem motivo'} · ${quemFez(req)}`, x.id);
    res.json({ ok: true });
  });

  // O valor de um dia (meia diária, um extra, ou zero). Vazio = volta a ser
  // a diária da pessoa.
  app.post('/api/ponto/dia', (req, res) => {
    const b = req.body || {};
    const m = db.prepare('SELECT id FROM team_members WHERE id = ?').get(Number(b.member_id));
    if (!m) return res.status(404).json({ error: 'Pessoa não encontrada.' });
    if (!ehDia(b.dia)) return res.status(400).json({ error: 'Dia inválido.' });
    const bruto = b.valor === '' || b.valor == null ? null : Number(String(b.valor).replace(',', '.'));
    if (bruto != null && !(Number.isFinite(bruto) && bruto >= 0)) return res.status(400).json({ error: 'Valor inválido.' });
    const ex = db.prepare('SELECT * FROM ponto_dias WHERE member_id = ? AND dia = ?').get(m.id, b.dia);
    if (ex && ex.pagamento_id) return res.status(400).json({ error: 'Este dia já foi pago. Desfaça o pagamento para mudar o valor.' });
    db.prepare(`INSERT INTO ponto_dias (member_id, dia, valor, obs) VALUES (?,?,?,?)
      ON CONFLICT(member_id, dia) DO UPDATE SET valor = excluded.valor, obs = excluded.obs`)
      .run(m.id, b.dia, bruto == null ? null : money(bruto), String(b.obs || '').trim().slice(0, 200) || null);
    res.json({ ok: true });
  });

  // Pagar as diárias: os dias escolhidos (ainda não pagos) viram uma
  // despesa "Diárias" no financeiro, com o valor de cada dia guardado.
  app.post('/api/ponto/pagar', (req, res) => {
    const b = req.body || {};
    const m = db.prepare('SELECT * FROM team_members WHERE id = ?').get(Number(b.member_id));
    if (!m) return res.status(404).json({ error: 'Pessoa não encontrada.' });
    const pedidos = [...new Set((Array.isArray(b.dias) ? b.dias : []).filter(ehDia))].sort();
    if (!pedidos.length) return res.status(400).json({ error: 'Escolha os dias a pagar.' });
    const hoje = diaLocal();
    const dias = [];
    for (const d of pedidos) {
      const aj = db.prepare('SELECT * FROM ponto_dias WHERE member_id = ? AND dia = ?').get(m.id, d);
      if (aj && aj.pagamento_id) continue;   // já pago: não paga de novo
      const marcas = db.prepare('SELECT * FROM ponto WHERE member_id = ? AND dia = ?').all(m.id, d);
      const x = montarDia(m, d, marcas, aj, hoje);
      if (x.valor > 0) dias.push(x);
    }
    if (!dias.length) return res.status(400).json({ error: 'Esses dias já estão pagos ou não têm valor a pagar.' });
    const valor = money(dias.reduce((t, d) => t + d.valor, 0));
    const de = dias[0].dia, ate = dias[dias.length - 1].dia;
    const br = (d) => d.split('-').reverse().slice(0, 2).join('/');
    const ts = now();
    const id = db.transaction(() => {
      const e = db.prepare(`INSERT INTO financial_entries (type, category, category_id, description, amount, ref, paid, paid_at, created_at)
        VALUES ('despesa','Diárias',?,?,?,?,1,?,?)`).run(categoryId('Diárias', 'despesa'),
        `Diárias ${m.name} · ${dias.length} ${dias.length === 1 ? 'dia' : 'dias'} (${de === ate ? br(de) : `${br(de)} a ${br(ate)}`})`,
        valor, `DIARIAS-${m.id}-${de}-${ate}`, ts, ts).lastInsertRowid;
      const pid = db.prepare(`INSERT INTO ponto_pagamentos (member_id, de, ate, dias, valor, entry_id, created_at) VALUES (?,?,?,?,?,?,?)`)
        .run(m.id, de, ate, dias.length, valor, e, ts).lastInsertRowid;
      const marca = db.prepare(`INSERT INTO ponto_dias (member_id, dia, pagamento_id, valor_pago) VALUES (?,?,?,?)
        ON CONFLICT(member_id, dia) DO UPDATE SET pagamento_id = excluded.pagamento_id, valor_pago = excluded.valor_pago`);
      for (const d of dias) marca.run(m.id, d.dia, pid, d.valor);
      return pid;
    })();
    res.json({ ok: true, id, valor, dias: dias.length, de, ate });
  });

  // Desfazer um pagamento lançado errado: a despesa some e os dias voltam
  // a ficar a pagar.
  app.delete('/api/ponto/pagamentos/:id', (req, res) => {
    const p = db.prepare('SELECT * FROM ponto_pagamentos WHERE id = ?').get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Pagamento não encontrado.' });
    db.transaction(() => {
      if (p.entry_id) db.prepare('DELETE FROM financial_entries WHERE id = ?').run(p.entry_id);
      db.prepare('UPDATE ponto_dias SET pagamento_id = NULL, valor_pago = NULL WHERE pagamento_id = ?').run(p.id);
      db.prepare('DELETE FROM ponto_pagamentos WHERE id = ?').run(p.id);
    })();
    res.json({ ok: true });
  });
}
