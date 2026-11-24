// ============================================================
//  Financeiro → Vendas.
//
//  Todas as vendas (PDV e site) de um período, para abrir uma por uma e
//  analisar tudo: as peças, as contas (desconto, frete, custo, lucro,
//  comissão), o dinheiro que entrou no caixa por ela e se bate, o que mudou
//  no estoque e o histórico (quem editou o quê). Daqui também se corrige a
//  venda do PDV, se recebe o fiado, se cancela, e se marca "conferida".
//
//  Usa o que financeiro.html já tem: api, BRL, esc, vazio, kpi, nomeDe,
//  semAc, load (Caixa) e caixa (fechamento).
// ============================================================
(() => {
  const $ = (s) => document.querySelector(s);
  const V = { dados: null, lista: [], sel: new Set(), forma: '', mostrar: 300, aberta: null, edit: null, time: null, carregou: false };
  const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const soma = (arr, f) => r2(arr.reduce((t, x) => t + (Number(f(x)) || 0), 0));
  const json = (corpo) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo || {}) });

  // ---- Datas ----
  const SEMANA = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
  const p2 = (n) => String(n).padStart(2, '0');
  const hora = (d) => `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  const diaCurto = (d) => `${p2(d.getDate())}/${p2(d.getMonth() + 1)}`;
  const quando = (iso) => { if (!iso) return '—'; const d = new Date(iso); return `${SEMANA[d.getDay()]}, ${diaCurto(d)} · ${hora(d)}`; };
  const somaDias = (dia, n) => { const d = new Date(dia + 'T12:00:00'); d.setDate(d.getDate() + n); return diaLocal(d); };
  const PERIODOS = {
    hoje: () => [diaLocal(), diaLocal()],
    ontem: () => { const o = somaDias(diaLocal(), -1); return [o, o]; },
    7: () => [somaDias(diaLocal(), -6), diaLocal()],
    mes: () => [diaLocal().slice(0, 8) + '01', diaLocal()],
    mesant: () => { const fim = somaDias(diaLocal().slice(0, 8) + '01', -1); return [fim.slice(0, 8) + '01', fim]; },
  };

  // ---- Como cada venda aparece ----
  const origemDe = (v) => (v.channel === 'site' ? (v.origem === 'balcao' ? 'PDV Nuvemshop' : 'Site')
    : ({ whatsapp: 'WhatsApp', instagram: 'Instagram' }[v.canal] || 'Balcão'));
  const origemChave = (v) => (v.channel === 'site' ? (v.origem === 'balcao' ? 'pdvns' : 'site')
    : (v.canal === 'whatsapp' || v.canal === 'instagram' ? v.canal : 'balcao'));
  // O site manda a forma do jeito dele (pix, credit_card…): fica em português.
  const FORMA = { dinheiro: 'Espécie', cash: 'Espécie', pix: 'Pix', credit_card: 'Cartão de crédito', debit_card: 'Cartão de débito',
    boleto: 'Boleto', ticket: 'Boleto', wire_transfer: 'Transferência', offline: 'Combinado com a loja', other: 'Outra' };
  const formaNome = (f) => { const t = String(f || '').trim(); return t ? (FORMA[t.toLowerCase()] || t.charAt(0).toUpperCase() + t.slice(1)) : ''; };
  const formaDe = (v) => (v.fiado ? 'Fiado (a receber)' : (v.channel === 'site' ? 'Site · ' : '') + (formaNome(v.payment_method) || 'sem forma'));
  const situacao = (v) => (v.payment_status === 'cancelado' ? 'cancelada' : v.payment_status === 'pago' ? 'paga' : v.channel === 'site' ? 'esperando' : 'fiado');
  // Pix do site que não foi pago não tem o que conferir: nada entrou.
  const precisaConferir = (v) => situacao(v) !== 'esperando';
  // Quanto deveria ter entrado no caixa por esta venda: o total, se paga;
  // nada, se fiado, pix esperando ou cancelada (o estorno zera).
  const esperadoNoCaixa = (v) => (v.payment_status === 'pago' ? v.total : 0);
  const SIT = {
    conta: (v) => v.conta, paga: (v) => v.payment_status === 'pago', fiado: (v) => Boolean(v.fiado),
    esperando: (v) => situacao(v) === 'esperando', cancelada: (v) => v.payment_status === 'cancelado',
    nconf: (v) => precisaConferir(v) && !v.conferida_em, conf: (v) => Boolean(v.conferida_em),
    naobate: (v) => v.no_caixa != null && Math.abs(v.no_caixa - esperadoNoCaixa(v)) >= 0.01,
    troca: (v) => v.trocas > 0, editada: (v) => v.editada > 0, semcusto: (v) => v.conta && v.sem_custo, obs: (v) => Boolean(v.obs),
  };

  // ---- Carregar o período ----
  function marcarPeriodo(chave) {
    document.querySelectorAll('#vPer button').forEach((b) => b.classList.toggle('sel', b.dataset.r === chave));
  }
  async function carregar() {
    const de = $('#vDe').value, ate = $('#vAte').value;
    $('#vLista').innerHTML = '<div class="sk" style="height:58px"></div><div class="sk" style="height:58px"></div>';
    try { V.dados = await api(`/api/vendas/conferencia?de=${de}&ate=${ate}`); }
    catch (e) { $('#vLista').innerHTML = vazio('alerta', 'Não deu para carregar as vendas', e.message); return; }
    $('#vDe').value = V.dados.de; $('#vAte').value = V.dados.ate;
    $('#vAte').max = V.dados.hoje; $('#vDe').max = V.dados.hoje;
    // A seleção vale para o que está na tela; período novo, seleção nova.
    const ids = new Set(V.dados.vendas.map((v) => v.id));
    for (const id of [...V.sel]) if (!ids.has(id)) V.sel.delete(id);
    const vend = $('#vVend'), atual = vend.value;
    const nomes = [...new Set(V.dados.vendas.map((v) => v.seller_name).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
    vend.innerHTML = '<option value="">Todos os vendedores</option><option value="-">Sem vendedor (loja e site)</option>'
      + nomes.map((n) => `<option${n === atual ? ' selected' : ''}>${esc(n)}</option>`).join('');
    if (atual === '-') vend.value = '-';
    filtrar();
  }
  window.mostrarVendas = () => {
    if (V.carregou) return;
    V.carregou = true;
    const [de, ate] = PERIODOS.mes();
    $('#vDe').value = de; $('#vAte').value = ate;
    carregar();
  };

  // ---- Filtros, somas e a lista ----
  function filtrar() {
    if (!V.dados) return;
    const q = semAc($('#vBusca').value.trim());
    const org = $('#vOrigem').value, sit = $('#vSit').value, vend = $('#vVend').value;
    V.lista = V.dados.vendas.filter((v) => {
      if (org && origemChave(v) !== org) return false;
      if (V.forma && !(v.conta && formaDe(v) === V.forma)) return false;
      if (vend === '-' ? Boolean(v.seller_name) : vend && v.seller_name !== vend) return false;
      if (sit && !SIT[sit](v)) return false;
      if (q && !semAc([v.code, v.customer_name, v.seller_name, v.pecas, v.cupom, v.obs, formaDe(v), origemDe(v)].join(' ')).includes(q)) return false;
      return true;
    });
    V.mostrar = 300;
    resumo(); listar();
  }

  function resumo() {
    const cs = V.lista.filter((v) => v.conta);
    const fat = soma(cs, (v) => v.total), frete = soma(cs, (v) => v.frete), lucro = soma(cs, (v) => v.lucro);
    const pecas = soma(cs, (v) => v.items_count), desc = soma(cs, (v) => v.desconto);
    const semC = cs.filter((v) => v.sem_custo).length;
    const fi = V.lista.filter((v) => v.fiado), aReceber = soma(fi, (v) => v.total);
    const canc = V.lista.filter((v) => v.payment_status === 'cancelado');
    const base = fat - frete, margem = base > 0 ? Math.round((lucro / base) * 100) : 0;
    $('#vKpis').innerHTML = [
      kpi({ label: 'Vendas', ico: 'recibo', tone: 'brand', val: String(cs.length),
        sub: `${pecas} ${pl(pecas, 'peça')}${canc.length ? ` · ${canc.length} ${pl(canc.length, 'cancelada')} fora da conta` : ''}` }),
      kpi({ label: 'Faturamento', ico: 'subiu', tone: 'brand', val: BRL(fat), color: 'var(--ok)',
        sub: cs.length ? `ticket médio ${BRL(fat / cs.length)}${frete ? ` · ${BRL(frete)} de frete` : ''}` : 'nenhuma venda' }),
      cs.length && semC === cs.length
        ? kpi({ label: 'Lucro', ico: 'grafico', val: '—', sub: 'sem custo cadastrado — preencha em Estoque → Custos' })
        : kpi({ label: 'Lucro', ico: 'grafico', tone: lucro >= 0 ? 'brand' : 'crit', val: BRL(lucro),
          color: lucro >= 0 ? 'var(--brand-hi)' : 'var(--crit)',
          sub: `margem ${margem}%${semC ? ` · ${semC} ${pl(semC, 'venda')} sem custo (lucro real é menor)` : ' · já sem o frete e o custo'}` }),
      kpi({ label: 'Descontos dados', ico: 'etiqueta', tone: desc > 0 ? 'warn' : '', val: BRL(desc),
        sub: fat + desc > 0 ? `${Math.round((desc / (fat + desc)) * 100)}% do que seria sem desconto` : 'nenhum' }),
      kpi({ label: 'A receber', ico: 'relogio', tone: aReceber > 0 ? 'warn' : '', mod: aReceber > 0 ? 'is-warn' : '', val: BRL(aReceber),
        sub: fi.length ? `${fi.length} ${pl(fi.length, 'venda')} no fiado` : 'nenhum fiado' }),
    ].join('');

    // Por forma de pagamento: é o que se confere com o extrato do banco e
    // da maquininha. Tocar numa forma filtra a lista por ela.
    const formas = new Map();
    for (const v of V.dados.vendas.filter((x) => x.conta && listaSemForma(x))) {
      const f = formaDe(v), g = formas.get(f) || { n: 0, t: 0 };
      g.n += 1; g.t = r2(g.t + v.total); formas.set(f, g);
    }
    $('#vFormas').innerHTML = [...formas].sort((a, b) => b[1].t - a[1].t).map(([f, g]) =>
      `<button type="button" class="fchip${V.forma === f ? ' sel' : ''}" data-f="${esc(f)}">${esc(f)} <b>${BRL(g.t)}</b><small>${g.n}</small></button>`).join('');

    const prec = V.lista.filter(precisaConferir), conf = prec.filter((v) => v.conferida_em).length;
    const pct = prec.length ? Math.round((conf / prec.length) * 100) : 0;
    $('#vConf').innerHTML = prec.length
      ? `<b>${V.lista.length} ${pl(V.lista.length, 'venda')} na lista</b> · conferidas ${conf} de ${prec.length}
        <span class="barra"><i style="width:${pct}%"></i></span>${conf < prec.length ? `<a href="#" id="vFaltam">ver as ${prec.length - conf} que faltam</a>` : '<span style="color:var(--ok)">tudo conferido</span>'}`
      : `<b>${V.lista.length} ${pl(V.lista.length, 'venda')} na lista</b>`;
    const vf = $('#vFaltam');
    if (vf) vf.onclick = (e) => { e.preventDefault(); $('#vSit').value = 'nconf'; filtrar(); };
  }
  // As formas consideram os outros filtros, menos a própria forma.
  function listaSemForma(v) {
    const q = semAc($('#vBusca').value.trim());
    const org = $('#vOrigem').value, sit = $('#vSit').value, vend = $('#vVend').value;
    if (org && origemChave(v) !== org) return false;
    if (vend === '-' ? Boolean(v.seller_name) : vend && v.seller_name !== vend) return false;
    if (sit && !SIT[sit](v)) return false;
    if (q && !semAc([v.code, v.customer_name, v.seller_name, v.pecas, v.cupom, v.obs, formaDe(v), origemDe(v)].join(' ')).includes(q)) return false;
    return true;
  }

  function linhaDaLista(v) {
    const sit = situacao(v), tags = [];
    if (sit === 'cancelada') tags.push('<span class="tg crit">cancelada</span>');
    if (sit === 'fiado') tags.push('<span class="tg warn">fiado</span>');
    if (sit === 'esperando') tags.push('<span class="tg">aguardando pagamento</span>');
    if (v.trocas) tags.push(`<span class="tg info">${v.trocas} ${pl(v.trocas, 'troca')}</span>`);
    if (v.editada) tags.push('<span class="tg info">editada</span>');
    if (v.conta && v.sem_custo) tags.push('<span class="tg warn">sem custo</span>');
    if (v.cupom) tags.push(`<span class="tg">cupom ${esc(v.cupom)}</span>`);
    if (v.obs) tags.push(`<span class="tg" title="${esc(v.obs)}">obs</span>`);
    const d = new Date(v.created_at), cli = nomeDe(v.customer_name);
    const lucro = v.conta ? `<small class="${v.lucro < 0 ? 'neg' : 'pos'}">${v.sem_custo ? 'sem custo' : 'lucro ' + BRL(v.lucro)}</small>` : '';
    return `<div class="vr${sit === 'cancelada' ? ' canc' : ''}${sit === 'esperando' ? ' esperando' : ''}${V.sel.has(v.id) ? ' sel' : ''}" data-id="${v.id}">
      <input type="checkbox" data-ck="${v.id}"${V.sel.has(v.id) ? ' checked' : ''} aria-label="Selecionar ${esc(v.code)}">
      <div class="q"><b>${esc(v.code)}</b>${diaCurto(d)} · ${hora(d)}</div>
      <div class="who"><div class="cli">${cli ? esc(cli) : '<span style="color:var(--ink-3);font-weight:600">sem cliente</span>'}</div>
        <div class="sub">${esc(origemDe(v))}${v.seller_name ? ' · ' + esc(v.seller_name.split(' ')[0]) : ''} · ${v.items_count || 0} ${pl(v.items_count, 'peça')}${v.pecas ? ' · ' + esc(v.pecas) : ''}</div></div>
      <div class="fmw"><div class="fm">${esc(formaDe(v))}</div>${tags.length ? `<div class="tags">${tags.join('')}</div>` : ''}</div>
      <div class="vl">${BRL(v.total)}${lucro}</div>
      <span class="ck" title="${v.conferida_em ? 'Conferida' : 'Falta conferir'}">${v.conferida_em ? ICO('ok', 17) : (precisaConferir(v) ? '<i></i>' : '')}</span>
    </div>`;
  }
  function listar() {
    const box = $('#vLista');
    if (!V.lista.length) {
      const algum = V.dados && V.dados.vendas.length;
      box.innerHTML = vazio('recibo', algum ? 'Nenhuma venda com esses filtros' : 'Nenhuma venda neste período',
        algum ? 'Limpe a busca ou escolha outra situação.' : 'Escolha outro período.');
    } else {
      box.innerHTML = V.lista.slice(0, V.mostrar).map(linhaDaLista).join('')
        + (V.lista.length > V.mostrar ? `<button class="btn sm ghost vmais" id="vMais" type="button">Mostrar mais ${Math.min(300, V.lista.length - V.mostrar)} de ${V.lista.length - V.mostrar}</button>` : '');
      const mais = $('#vMais');
      if (mais) mais.onclick = () => { V.mostrar += 300; listar(); };
    }
    if (V.dados && V.dados.limite) box.insertAdjacentHTML('afterbegin', `<div class="chk warn">Período grande: aparecem as ${V.dados.limite} vendas mais recentes. Escolha um período menor para ver todas.</div>`);
    selecao();
  }
  function selecao() {
    const bar = $('#vSel');
    const sel = V.dados ? V.dados.vendas.filter((v) => V.sel.has(v.id)) : [];
    bar.hidden = !sel.length;
    if (!sel.length) return;
    const cs = sel.filter((v) => v.conta);
    $('#vSelN').innerHTML = `<b>${sel.length}</b> ${pl(sel.length, 'selecionada')} · total <b>${BRL(soma(cs, (v) => v.total))}</b>`
      + ` · lucro <b>${BRL(soma(cs, (v) => v.lucro))}</b> · ${soma(cs, (v) => v.items_count)} ${pl(soma(cs, (v) => v.items_count), 'peça')}`
      + (sel.length > cs.length ? ` · ${sel.length - cs.length} fora da conta (cancelada ou pix esperando)` : '');
  }

  $('#vLista').addEventListener('click', (e) => {
    const ck = e.target.closest('[data-ck]');
    if (ck) {
      const id = +ck.dataset.ck;
      if (ck.checked) V.sel.add(id); else V.sel.delete(id);
      ck.closest('.vr').classList.toggle('sel', ck.checked);
      selecao();
      return;
    }
    const r = e.target.closest('.vr');
    if (r) abrirVenda(+r.dataset.id);
  });
  $('#vFormas').addEventListener('click', (e) => {
    const b = e.target.closest('.fchip'); if (!b) return;
    V.forma = V.forma === b.dataset.f ? '' : b.dataset.f;
    filtrar();
  });
  $('#vPer').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    marcarPeriodo(b.dataset.r);
    const [de, ate] = PERIODOS[b.dataset.r]();
    $('#vDe').value = de; $('#vAte').value = ate;
    carregar();
  });
  for (const id of ['#vDe', '#vAte']) $(id).addEventListener('change', () => { marcarPeriodo(''); carregar(); });
  let bt;
  $('#vBusca').addEventListener('input', () => { clearTimeout(bt); bt = setTimeout(filtrar, 150); });
  for (const id of ['#vOrigem', '#vSit', '#vVend']) $(id).addEventListener('change', filtrar);
  $('#vTodas').onclick = () => {
    const todas = V.lista.every((v) => V.sel.has(v.id));
    for (const v of V.lista) { if (todas) V.sel.delete(v.id); else V.sel.add(v.id); }
    listar();
  };
  $('#vSelLimpa').onclick = () => { V.sel.clear(); listar(); };
  async function conferirEmLote(marcar) {
    const ids = [...V.sel];
    if (!ids.length) return;
    try {
      await api('/api/vendas/conferir', json({ ids, conferida: marcar }));
      V.sel.clear();
      await carregar();
    } catch (e) { alert(e.message); }
  }
  $('#vSelConf').onclick = () => conferirEmLote(true);
  $('#vSelDes').onclick = () => conferirEmLote(false);

  // Planilha (abre no Excel e no Google Planilhas): a lista como está na
  // tela, com os filtros. Ponto e vírgula e vírgula decimal, do jeito que o
  // Excel em português entende.
  $('#vCsv').onclick = () => {
    if (!V.lista.length) return alert('Nenhuma venda na lista.');
    const n = (x) => r2(x).toFixed(2).replace('.', ',');
    const c = (x) => { const t = String(x == null ? '' : x).replace(/\s+/g, ' ').trim(); return /[;"\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
    const linhas = [['Data', 'Hora', 'Código', 'Origem', 'Cliente', 'Vendedor', 'Forma', 'Situação', 'Peças', 'Itens',
      'Desconto', 'Frete', 'Total', 'Custo', 'Lucro', 'Conta como venda', 'Conferida', 'Observação']];
    for (const v of V.lista) {
      const d = new Date(v.created_at);
      linhas.push([diaLocal(d).split('-').reverse().join('/'), hora(d), v.code, origemDe(v), nomeDe(v.customer_name), v.seller_name || '',
        formaDe(v), situacao(v), v.items_count || 0, v.pecas || '', n(v.desconto), n(v.frete), n(v.total), n(v.cost_total), n(v.lucro),
        v.conta ? 'sim' : 'não', v.conferida_em ? 'sim' : 'não', v.obs || ''].map(c));
    }
    const blob = new Blob(['﻿' + linhas.map((l) => l.join(';')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `vendas-${V.dados.de}-a-${V.dados.ate}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  // ================= UMA VENDA =================
  const dlg = $('#dlgVenda');
  $('#dvFechar').onclick = () => dlg.close();
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  const posicao = () => (V.aberta ? V.lista.findIndex((v) => v.id === V.aberta.id) : -1);
  const irPara = (passo) => {
    const i = posicao();
    if (i < 0 || V.edit) return;
    const prox = V.lista[i + passo];
    if (prox) abrirVenda(prox.id);
  };
  $('#dvAnt').onclick = () => irPara(-1);
  $('#dvProx').onclick = () => irPara(1);
  document.addEventListener('keydown', (e) => {
    if (!dlg.open || V.edit || /INPUT|TEXTAREA|SELECT/.test(document.activeElement && document.activeElement.tagName)) return;
    if (e.key === 'ArrowLeft') irPara(-1);
    if (e.key === 'ArrowRight') irPara(1);
  });

  async function abrirVenda(id, aviso) {
    V.edit = null;
    if (!dlg.open) dlg.showModal();
    $('#dvCorpo').innerHTML = '<div class="sk" style="height:90px"></div><div class="sk" style="height:160px"></div>';
    try { V.aberta = await api('/api/vendas/' + id); }
    catch (e) { $('#dvCorpo').innerHTML = vazio('alerta', 'Não deu para abrir a venda', e.message); return; }
    pintarVenda(aviso);
  }
  window.abrirVendaFin = abrirVenda;

  function cabecalho() {
    const v = V.aberta, i = posicao();
    $('#dvCode').textContent = v.code;
    $('#dvPos').textContent = i >= 0 ? `${i + 1} de ${V.lista.length} na lista` : '';
    $('#dvAnt').disabled = i <= 0 || Boolean(V.edit);
    $('#dvProx').disabled = i < 0 || i >= V.lista.length - 1 || Boolean(V.edit);
  }

  function pintarVenda(aviso) {
    const v = V.aberta;
    cabecalho();
    const sit = situacao(v), pago = v.payment_status === 'pago';
    const cli = nomeDe(v.customer_name);
    const statusTxt = sit === 'cancelada' ? '<span class="tg crit">cancelada</span>' : sit === 'fiado' ? '<span class="tg warn">fiado — a receber</span>'
      : sit === 'esperando' ? '<span class="tg">aguardando pagamento no site</span>' : '<span class="tg ok">paga</span>';
    // Aberta pelo Caixa (fora da lista): sem "próxima".
    const pos = posicao(), prox = pos >= 0 ? V.lista[pos + 1] : null;
    $('#dvCorpo').innerHTML = `
      ${aviso ? `<div class="dv-aviso ${aviso.erro ? 'erro' : 'ok'}">${aviso.html}</div>` : ''}
      <div class="dv-resumo">
        <span>${statusTxt}</span>
        <span><b>${cli ? esc(cli) : 'Sem cliente'}</b></span>
        <span>${quando(v.created_at)}</span>
        <span>${esc(origemDe(v))}${v.seller_name ? ` · vendeu: <b>${esc(v.seller_name)}</b>` : ''}</span>
        <span>${esc(v.payment_status === 'pendente' && v.channel !== 'site' ? 'Fiado' : (v.channel === 'site' ? 'Site · ' : '') + (formaNome(v.payment_method) || 'sem forma'))}</span>
      </div>
      ${precisaConferir(v) ? `<div class="dv-acts">
        <button type="button" class="btn sm bconf${v.conferida_em ? ' on' : ''}" id="dvConf">${ICO('ok', 15)}${v.conferida_em ? `Conferida · ${quando(v.conferida_em)} — desmarcar` : 'Marcar como conferida'}</button>
        ${!v.conferida_em && prox ? '<button type="button" class="btn sm primary" id="dvConfProx">Conferida → próxima</button>' : ''}
      </div>` : ''}
      <div class="dvs"><h4>Peças <span>${v.items_count || 0} ${pl(v.items_count, 'peça')}</span></h4>
        ${(v.itens || []).map(linhaItem).join('') || '<div class="dnota">Pedido sem as peças registradas.</div>'}</div>
      <div class="dv-2">
        <div class="dvs"><h4>As contas</h4>${contas(v)}</div>
        <div class="dvs"><h4>Dinheiro no caixa</h4>${dinheiro(v)}</div>
      </div>
      ${v.channel === 'site' ? pedidoDaLoja(v) : ''}
      ${estoque(v)}
      <div class="dvs"><h4>Histórico</h4>${historico(v)}</div>
      <div class="dvs"><h4>Observação</h4>
        <textarea id="dvObs" rows="2" maxlength="500" placeholder="Anote o que precisar — ex.: metade no pix, metade em espécie">${esc(v.obs || '')}</textarea>
        <div class="dv-acts" style="margin-top:6px"><button type="button" class="btn sm" id="dvObsSalvar">Salvar observação</button></div></div>
      ${acoes(v)}`;
    ligarAcoes(v);
  }

  function linhaItem(i) {
    const img = i.image_url ? `<img src="${esc(i.image_url)}" alt="" loading="lazy" onerror="this.remove()">` : '';
    if (i.qty < 0) {
      return `<div class="di volta"><span class="th">${img}</span><div><div class="nm">↩ Voltou na troca: ${esc(i.name)}</div>
        <div class="mt">${-i.qty} × ${BRL(i.unit_price)}</div></div><div class="vv neg">− ${BRL(-i.line_total)}</div></div>`;
    }
    const cheio = i.preco_lista > i.unit_price + 0.005 ? ` · cheio hoje ${BRL(i.preco_lista)}` : '';
    const custo = i.unit_cost > 0 ? ` · custo ${BRL(i.unit_cost)}` : ' · <span class="aviso">sem custo</span>';
    const volt = i.pode_voltar != null && i.qty - i.pode_voltar > 0 ? ` · ${i.qty - i.pode_voltar} voltou` : '';
    return `<div class="di${i.troca_id ? ' nova' : ''}"><span class="th">${img}</span><div>
      <div class="nm">${i.troca_id ? 'Levou na troca: ' : ''}${esc(i.name)}</div>
      <div class="mt">${i.qty} × ${BRL(i.unit_price)}${cheio}${custo}${volt}${i.variant_id ? '' : ' · fora do catálogo'}${i.encomenda ? ` · ${i.encomenda} por encomenda` : ''}</div></div>
      <div class="vv">${BRL(i.line_total)}</div></div>`;
  }

  const dc = (rot, val, cls = '') => `<div class="dc ${cls}"><span>${rot}</span><span class="v">${val < 0 ? '− ' + BRL(-val) : BRL(val)}</span></div>`;
  function contas(v) {
    const it = v.itens || [];
    let h = '';
    if (v.channel === 'site') {
      const ns = v.ns;
      const pecas = ns && ns.pecas > 0 ? ns.pecas : soma(it.filter((i) => i.qty > 0), (i) => i.line_total);
      h += dc(`Peças (${v.items_count || 0})`, pecas);
      if (ns && ns.desconto > 0) {
        const det = [ns.cupons && ns.cupons.length ? 'cupom ' + esc(ns.cupons.join(', ')) : '', ns.desconto_pagamento > 0 ? 'desconto no pagamento' : ''].filter(Boolean).join(' · ');
        h += dc(`Desconto${det ? ' · ' + det : ''}`, -ns.desconto, 'neg');
      }
      if (ns && ns.frete_cliente > 0) h += dc(`Frete pago pelo cliente${ns.envio ? ' · ' + esc(ns.envio) : ''}`, ns.frete_cliente);
      const ajuste = r2(v.total - (pecas - (ns ? ns.desconto : 0) + (ns ? ns.frete_cliente : 0)));
      if (Math.abs(ajuste) >= 0.01) h += dc(ns ? 'Promoção ou ajuste da loja' : 'Frete, desconto ou ajuste do pedido', ajuste, ajuste < 0 ? 'neg' : '');
      h += dc('Total pago pelo cliente', v.total, 'tot');
      if (v.frete > 0) h += dc(ns.frete_loja > ns.frete_cliente ? `Frete que a loja paga${ns.frete_cliente ? '' : ' (frete grátis)'}` : 'Frete (vai para a transportadora)', -v.frete, 'neg');
      if (!ns) h += '<div class="dnota">Frete e desconto deste pedido chegam na próxima leitura da loja (pedidos dos últimos 45 dias).</div>';
    } else {
      const orig = it.filter((i) => i.qty > 0 && !i.troca_id), troca = it.filter((i) => i.troca_id);
      h += dc(`Peças (${soma(orig, (i) => i.qty)})`, soma(orig, (i) => i.line_total));
      if (troca.length) { const t = soma(troca, (i) => i.line_total); h += dc(`Trocas (${v.trocas.length})`, t, t < 0 ? 'neg' : ''); }
      if (v.discount > 0) h += dc(`Desconto${v.subtotal > 0 ? ` (${Math.round((v.discount / v.subtotal) * 100)}%)` : ''}`, -v.discount, 'neg');
      h += dc('Total da venda', v.total, 'tot');
    }
    if (v.payment_status === 'cancelado') return h + '<div class="chk info">Venda cancelada: não entra em faturamento, lucro, meta nem comissão.</div>';
    if (v.channel === 'site' && v.payment_status !== 'pago') return h + '<div class="chk info">Ainda não é venda: entra nas contas quando o site confirmar o pagamento.</div>';
    h += dc('Custo das peças', -v.cost_total, 'neg');
    const base = v.total - v.frete, margem = base > 0 ? Math.round((v.lucro / base) * 100) : 0;
    h += dc(`Lucro · margem ${margem}%`, v.lucro, 'lucro' + (v.lucro < 0 ? ' neg' : ''));
    if (v.sem_custo) h += '<div class="dnota"><span class="aviso">Tem peça sem custo cadastrado:</span> o lucro de verdade é menor que isso. Preencha em Estoque → Custos.</div>';
    const c = v.comissao || {};
    if (c.valor > 0) {
      h += dc(`Comissão de ${esc(String(c.nome || '').split(' ')[0])} (${c.pct}%)`, -c.valor, 'neg');
      h += dc('Sobra para a loja', r2(v.lucro - c.valor), 'lucro');
    } else if (c.pct > 0 && !c.porque) {
      // Balcão com vendedor e % cadastrada, mas nada entrou no caixa ainda.
      h += `<div class="dnota">Comissão de ${esc(String(c.nome || '').split(' ')[0])} (${c.pct}%): ${v.fiado ? 'entra quando o fiado for recebido' : 'nada entrou no caixa por esta venda'}.</div>`;
    } else if (c.porque) {
      h += `<div class="dnota">Comissão: nenhuma — ${esc(c.porque)}.</div>`;
    }
    return h;
  }

  function dinheiro(v) {
    const ent = v.entradas || [];
    let h = ent.length ? ent.map((e) => {
      const valor = e.type === 'despesa' ? -e.amount : e.amount;
      return `<div class="de"><div><div>${esc(e.description || e.category)}</div>
        <div class="s">${quando(e.created_at)}${e.forma ? ' · ' + esc(formaNome(e.forma)) : ''}</div></div>
        <div class="v ${valor < 0 ? 'out' : 'in'}">${valor < 0 ? '− ' + BRL(-valor) : '+ ' + BRL(valor)}</div></div>`;
    }).join('') : '<div class="dnota" style="margin-top:0">Nenhum dinheiro entrou ou saiu por esta venda.</div>';
    if (ent.length) h += dc('Entrou no caixa por esta venda', v.no_caixa, 'tot');
    const esperado = esperadoNoCaixa(v), dif = r2(v.no_caixa - esperado);
    if (v.payment_status === 'pendente') {
      h += v.channel === 'site'
        ? '<div class="chk info">Aguardando o pagamento no site: nada entrou ainda. Quando pagar, entra sozinho.</div>'
        : `<div class="chk warn">Fiado: nada entrou ainda. O cliente deve ${BRL(v.total)}.</div>`;
    } else if (Math.abs(dif) < 0.01) {
      h += v.payment_status === 'cancelado'
        ? `<div class="chk ok">${ICO('ok', 15)}<span>${ent.length ? 'Cancelada e estornada: o caixa ficou zerado por esta venda.' : 'Cancelada antes de entrar dinheiro.'}</span></div>`
        : `<div class="chk ok">${ICO('ok', 15)}<span>Bate: o caixa recebeu ${BRL(v.no_caixa)}, o total da venda.</span></div>`;
    } else if (v.payment_status === 'cancelado' && v.channel === 'site') {
      h += `<div class="chk crit">${ICO('alerta', 15)}<span>O pedido foi cancelado na loja, mas ${BRL(v.no_caixa)} continuam no caixa. Se o dinheiro voltou para o cliente, lance a saída em Caixa → Lançar.</span></div>`;
    } else {
      h += `<div class="chk crit">${ICO('alerta', 15)}<span>Não bate: o caixa recebeu ${BRL(v.no_caixa)} e ${v.payment_status === 'cancelado' ? 'a venda está cancelada (deveria ser zero)' : `a venda é de ${BRL(v.total)}`} — diferença de ${BRL(Math.abs(dif))}.</span></div>`;
    }
    return h;
  }

  function pedidoDaLoja(v) {
    const ns = v.ns || {};
    const envio = v.ns_shipping_type === 'retirada' ? 'retirada na loja' : 'envio';
    const ESTADO = { unpacked: 'a embalar', packed: 'embalado', unshipped: 'a enviar', shipped: 'enviado', delivered: 'entregue', unfulfilled: 'a enviar', fulfilled: 'enviado' };
    const linhas = [
      ['Número na Nuvemshop', esc(v.code.replace(/^SITE-/, '#'))],
      ['Pagamento', esc(formaNome(ns.pagamento || v.payment_method) || '—') + (v.ns_payment_status ? ` · ${esc(v.ns_payment_status)}` : '')],
      ['Entrega', esc(envio) + (ns.envio ? ' · ' + esc(ns.envio) : '') + (v.ns_shipping_status ? ' · ' + esc(ESTADO[v.ns_shipping_status] || v.ns_shipping_status) : '')],
      ns.rastreio ? ['Rastreio', esc(ns.rastreio)] : null,
      ns.cupons && ns.cupons.length ? ['Cupom', esc(ns.cupons.join(', '))] : null,
      ns.nota_cliente ? ['Recado do cliente', esc(ns.nota_cliente)] : null,
    ].filter(Boolean);
    return `<div class="dvs"><h4>Pedido na loja</h4>${linhas.map(([a, b]) => `<div class="dc"><span>${a}</span><span style="text-align:right">${b}</span></div>`).join('')}
      <div class="dnota">Peças, preços e pagamento do pedido do site se corrigem na Nuvemshop; o sistema acompanha sozinho. Aqui dá para ligar o cliente, anotar e conferir.</div></div>`;
  }

  function estoque(v) {
    const MOTIVO = { venda_pdv: 'venda', edicao_venda: 'edição da venda', troca: 'troca', cancelamento: 'cancelamento', venda_site: 'pedido do site (par da loja)', cancelado_site: 'pedido cancelado' };
    const m = v.estoque || [];
    const sync = v.channel === 'site' ? '' : v.synced_nuvemshop ? '<div class="dnota">Estoque enviado à Nuvemshop.</div>'
      : v.sync_note ? `<div class="dnota">Nuvemshop: ${esc(v.sync_note)}</div>` : '';
    if (!m.length && !sync) return '';
    return `<div class="dvs"><h4>Estoque</h4>${m.map((x) => `<div class="de"><div><div>${x.delta > 0 ? 'Voltou' : 'Saiu'}: ${esc(`${x.product_name || ''} ${x.variant_name || ''}`.trim() || 'peça')}</div>
      <div class="s">${quando(x.created_at)} · ${esc(MOTIVO[x.reason] || x.reason)}</div></div><div class="v ${x.delta > 0 ? 'in' : 'out'}">${x.delta > 0 ? '+' : '−'}${Math.abs(x.delta)}</div></div>`).join('')}${sync}</div>`;
  }

  function historico(v) {
    const cap = (t) => String(t || '').charAt(0).toUpperCase() + String(t || '').slice(1);
    const ev = [{ t: v.created_at, txt: v.channel === 'site' ? 'Pedido feito no site' : 'Venda lançada no PDV', quem: v.channel === 'site' ? '' : v.seller_name || '' }];
    for (const t of v.trocas || []) {
      ev.push({ t: t.created_at, quem: t.feito_por, txt: `Troca: voltou ${BRL(t.devolvido)}, levou ${BRL(t.levado)} · `
        + (t.diferenca > 0 ? `cliente pagou ${BRL(t.diferenca)}` : t.diferenca < 0 ? `devolvido ${BRL(-t.diferenca)}` : 'sem diferença')
        + (t.forma ? ` em ${t.forma}` : '') + (t.nota ? ` · ${t.nota}` : '') });
    }
    for (const x of v.historico || []) ev.push({ t: x.created_at, txt: cap(x.texto), quem: x.quem === 'sistema' ? '' : x.quem });
    if (v.cancelado_em) ev.push({ t: v.cancelado_em, txt: 'Cancelada' + (v.cancel_motivo ? ' · ' + v.cancel_motivo : '') });
    ev.sort((a, b) => String(a.t).localeCompare(String(b.t)));
    return `<div class="tl">${ev.map((e) => `<div><span class="t">${quando(e.t)}</span><span>${esc(e.txt)}${e.quem ? ` <span class="w">· ${esc(e.quem)}</span>` : ''}</span></div>`).join('')}</div>`;
  }

  function acoes(v) {
    const pdv = v.channel !== 'site', ativa = v.payment_status !== 'cancelado';
    let h = '<div class="dv-acts">';
    if (pdv && ativa) {
      h += `<button type="button" class="btn" id="dvEditar">${ICO('editar', 15)} Editar venda</button>`;
      if (v.payment_status === 'pendente') h += '<button type="button" class="btn" id="dvReceber">Receber fiado</button>';
      h += `<a class="btn ghost" href="/pdv?venda=${v.id}">Trocar ou devolver (no PDV)</a>`;
      h += '<button type="button" class="btn danger" id="dvCancelar">Cancelar venda</button>';
    }
    if (!pdv) h += '<button type="button" class="btn" id="dvCliente">Ligar a um cliente</button>';
    h += '</div><div id="dvBox"></div>';
    return h;
  }

  // Depois de mudar a venda: atualiza a lista (e o Caixa, se o dinheiro mudou).
  async function depoisDeMudar(aviso, dinheiroMudou) {
    if (V.carregou) await carregar();
    if (dinheiroMudou) { try { load(); caixa(); } catch (_) {} }
    await abrirVenda(V.aberta.id, aviso);
  }

  function ligarAcoes(v) {
    const conf = $('#dvConf');
    const marcar = async (seguir) => {
      try {
        await api('/api/vendas/conferir', json({ ids: [v.id], conferida: !v.conferida_em }));
        const i = posicao(), prox = i >= 0 ? V.lista[i + 1] : null;
        if (V.carregou) await carregar();
        if (seguir && prox) abrirVenda(prox.id); else abrirVenda(v.id);
      } catch (e) { alert(e.message); }
    };
    if (conf) conf.onclick = () => marcar(false);
    const cp = $('#dvConfProx');
    if (cp) cp.onclick = () => marcar(true);
    $('#dvObsSalvar').onclick = async () => {
      try { await api(`/api/sales/${v.id}/obs`, json({ obs: $('#dvObs').value })); await depoisDeMudar({ html: 'Observação salva.' }); }
      catch (e) { alert(e.message); }
    };
    const box = $('#dvBox');
    const ed = $('#dvEditar');
    if (ed) ed.onclick = () => iniciarEdicao();
    const rec = $('#dvReceber');
    if (rec) rec.onclick = () => {
      box.innerHTML = `<div class="dv-box"><b>Receber ${BRL(v.total)} de ${esc(nomeDe(v.customer_name) || 'quem comprou')}</b>
        <span class="dnota" style="margin:0">Entra no caixa de hoje, na forma escolhida.</span>
        <div class="linha"><select id="dvRecForma">${opcoesForma(v.payment_method)}</select>
        <button type="button" class="btn primary" id="dvRecOk">Confirmar recebimento</button>
        <button type="button" class="btn ghost" id="dvRecNao">Voltar</button></div></div>`;
      $('#dvRecNao').onclick = () => { box.innerHTML = ''; };
      $('#dvRecOk').onclick = async (e) => {
        e.target.disabled = true;
        try {
          await api(`/api/sales/${v.id}/settle`, json({ payment_method: $('#dvRecForma').value }));
          await depoisDeMudar({ html: `Fiado recebido: ${BRL(v.total)} entrou no caixa de hoje.` }, true);
        } catch (err) { alert(err.message); e.target.disabled = false; }
      };
    };
    const can = $('#dvCancelar');
    if (can) can.onclick = () => {
      const pago = v.payment_status === 'pago';
      box.innerHTML = `<div class="dv-box"><b style="color:var(--crit)">Cancelar ${esc(v.code)}?</b>
        <span class="dnota" style="margin:0">As peças voltam para o estoque (aqui e no site)${pago ? ` e ${BRL(v.total)} saem do caixa de hoje como estorno` : ''}. A venda sai de metas, comissão e relatórios. Não dá para desfazer.</span>
        <div class="linha"><input id="dvMotivo" placeholder="Motivo (opcional) — ex.: cliente desistiu">
        ${pago ? `<select id="dvCanForma" aria-label="Devolvido em">${opcoesForma(v.payment_method)}</select>` : ''}</div>
        <div class="linha"><button type="button" class="btn danger" id="dvCanOk">Confirmar cancelamento</button>
        <button type="button" class="btn ghost" id="dvCanNao">Voltar</button></div></div>`;
      $('#dvCanNao').onclick = () => { box.innerHTML = ''; };
      $('#dvCanOk').onclick = async (e) => {
        e.target.disabled = true;
        try {
          const r = await api(`/api/sales/${v.id}/cancelar`, json({ motivo: $('#dvMotivo').value, forma: $('#dvCanForma') ? $('#dvCanForma').value : undefined }));
          await depoisDeMudar({ html: `${esc(r.code)} cancelada. ${r.estorno ? `Estorno de ${BRL(r.estorno)} em ${esc(formaNome(r.forma))}. ` : ''}As peças voltaram para o estoque.` }, true);
        } catch (err) { alert(err.message); e.target.disabled = false; }
      };
    };
    const cl = $('#dvCliente');
    if (cl) cl.onclick = () => {
      box.innerHTML = `<div class="dv-box"><b>Cliente desta venda</b>
        <span class="dnota" style="margin:0">Liga o pedido a um cadastro daqui (a leitura da loja não desfaz).</span>
        <input id="dvCliQ" placeholder="Nome ou @instagram…" autocomplete="off"><div class="busca-res" id="dvCliRes"></div></div>`;
      buscaCliente($('#dvCliQ'), $('#dvCliRes'), async (corpo) => {
        try { await api(`/api/sales/${v.id}/cliente`, json(corpo)); await depoisDeMudar({ html: 'Cliente ligado à venda.' }); }
        catch (e) { alert(e.message); }
      });
      $('#dvCliQ').focus();
    };
  }

  const FORMAS_PDV = [['Pix', 'Pix'], ['Dinheiro', 'Espécie'], ['Crédito', 'Crédito'], ['Débito', 'Débito']];
  const opcoesForma = (atual) => {
    const lista = FORMAS_PDV.some(([f]) => f === atual) || !atual ? FORMAS_PDV : [...FORMAS_PDV, [atual, formaNome(atual)]];
    return lista.map(([f, t]) => `<option value="${esc(f)}"${f === atual ? ' selected' : ''}>${esc(t)}</option>`).join('');
  };
  function buscaCliente(input, res, escolher) {
    let t;
    input.oninput = () => {
      clearTimeout(t);
      t = setTimeout(async () => {
        const q = input.value.trim();
        if (!q) { res.innerHTML = ''; return; }
        let rows = [];
        try { rows = await api('/api/customers?q=' + encodeURIComponent(q)); } catch (_) {}
        res.innerHTML = rows.slice(0, 6).map((c) => `<button type="button" data-c="${c.id}" data-n="${esc(c.name)}"><span>${esc(c.name)}</span><small>${esc(c.instagram || c.phone || '')}</small></button>`).join('')
          + `<button type="button" data-novo="1"><span>+ Cadastrar “${esc(q)}”</span><small>cliente novo</small></button>`;
        res.querySelectorAll('button').forEach((b) => { b.onclick = () => escolher(b.dataset.novo ? { new_customer: { name: q } } : { customer_id: +b.dataset.c }, b.dataset.novo ? q : b.dataset.n); });
      }, 200);
    };
  }

  // ================= EDITAR A VENDA (PDV) =================
  // A venda inteira numa tela só: peças (quantidade, preço, tirar, pôr do
  // catálogo), desconto, pago ou fiado, forma, cliente, vendedor, onde e a
  // data. As contas mudam na hora; o estoque mexe só pela diferença (aqui
  // e na Nuvemshop) e o dinheiro fica no dia da venda. Mesma regra do PDV
  // (PUT /api/sales/:id).
  async function iniciarEdicao() {
    const v = V.aberta;
    if (!V.time) { try { V.time = (await api('/api/team')).membros || []; } catch (_) { V.time = []; } }
    const foraDoCatalogo = (v.itens || []).some((i) => !i.variant_id);
    const soDados = v.trocas.length > 0 || foraDoCatalogo;
    const linhas = new Map();
    if (!soDados) {
      for (const i of v.itens) {
        if (i.qty <= 0) continue;
        const l = linhas.get(i.variant_id) || { id: i.variant_id, nome: i.name, qty: 0, orig: 0, preco: i.unit_price, stock: i.stock || 0,
          sm: i.stock_management == null ? 1 : i.stock_management, od: Boolean(i.on_demand), custo: i.unit_cost || 0, lista: i.preco_lista };
        l.qty += i.qty; l.orig += i.qty; l.preco = i.unit_price;
        linhas.set(i.variant_id, l);
      }
    }
    V.edit = {
      soDados, trava: v.trocas.length ? 'Esta venda já teve troca: peças, preços, desconto e pago/fiado ficam como estão (a troca foi feita em cima deles).'
        : foraDoCatalogo ? 'Esta venda tem peça fora do catálogo: as peças não dá para mudar.' : '',
      linhas: [...linhas.values()], desconto: v.discount || 0, status: v.payment_status === 'pendente' ? 'pendente' : 'pago',
      forma: v.payment_method || '', cliente: v.customer_id ? { id: v.customer_id, nome: v.customer_name } : null, novoCliente: null,
      vend: v.seller_id ? String(v.seller_id) : '', canal: v.canal || 'balcao', data: diaLocal(new Date(v.created_at)),
    };
    pintarEdicao();
  }
  const limite = (l) => (l.od ? l.orig : l.sm ? l.orig + Math.max(0, l.stock) : Infinity);
  const precoV = (p) => Math.min(p.price, p.preco_promo > 0 ? p.preco_promo : Infinity, p.preco_site > 0 ? p.preco_site : Infinity);

  function pintarEdicao(erro) {
    const v = V.aberta, e = V.edit;
    cabecalho();
    const membros = (V.time || []).filter((m) => (m.active && m.vende) || String(m.id) === e.vend);
    if (e.vend && !membros.some((m) => String(m.id) === e.vend)) membros.push({ id: e.vend, name: v.seller_name || 'vendedor' });
    const min = somaDias(diaLocal(), -90);
    $('#dvCorpo').innerHTML = `
      <div class="dv-aviso info"><b style="color:var(--ink)">Editando ${esc(v.code)}</b> — mude o que precisar e toque em <b>Salvar alterações</b>. Nada muda antes disso.</div>
      ${erro ? `<div class="dv-aviso erro">${esc(erro)}</div>` : ''}
      <div class="dvs"><h4>Peças</h4>
        ${e.soDados ? `<div class="chk info">${esc(e.trava)}</div>` : `<div id="edLinhas"></div>
        <div style="margin-top:8px"><input id="edBusca" placeholder="Pôr outra peça: busque pelo nome, marca ou tamanho…" autocomplete="off">
        <div class="busca-res" id="edRes" style="margin-top:5px"></div></div>`}</div>
      <div class="dvs"><h4>Pagamento</h4><div class="ed-g">
        ${e.soDados ? '' : `<div class="field"><label>Desconto (R$)</label><input id="edDesc" type="number" min="0" step="0.01" inputmode="decimal" value="${e.desconto || ''}" placeholder="0,00"></div>
        <div class="field"><label>Situação</label><div class="segb" id="edSt">
          <button type="button" data-st="pago" class="${e.status === 'pago' ? 'sel' : ''}">Pago</button>
          <button type="button" data-st="pendente" class="warn${e.status === 'pendente' ? ' sel' : ''}">Fiado</button></div></div>`}
        <div class="field"><label>Forma</label><select id="edForma"><option value="">—</option>${opcoesForma(e.forma)}</select></div>
        <div class="field"><label>Data da venda</label><input id="edData" type="date" value="${e.data}" min="${min}" max="${diaLocal()}"></div>
      </div></div>
      <div class="dvs"><h4>Quem</h4><div class="ed-g">
        <div class="field"><label>Cliente</label><div id="edCli"></div></div>
        <div class="field"><label>Quem vendeu</label><select id="edVend"><option value="">Loja (sem comissão)</option>
          ${membros.map((m) => `<option value="${m.id}"${String(m.id) === e.vend ? ' selected' : ''}>${esc(m.name)}</option>`).join('')}</select></div>
        <div class="field"><label>Onde vendeu</label><select id="edCanal">
          ${[['balcao', 'Balcão (gera comissão)'], ['whatsapp', 'WhatsApp'], ['instagram', 'Instagram']].map(([k, t]) => `<option value="${k}"${e.canal === k ? ' selected' : ''}>${t}</option>`).join('')}</select></div>
      </div></div>
      <div class="dvs"><h4>Como fica</h4><div id="edConta"></div></div>
      <div class="dv-acts"><button type="button" class="btn primary" id="edSalvar">Salvar alterações</button>
        <button type="button" class="btn ghost" id="edSair">Sair sem salvar</button></div>`;
    if (!e.soDados) {
      pintarLinhas();
      $('#edDesc').oninput = () => { e.desconto = Math.max(0, parseFloat($('#edDesc').value) || 0); contaEdicao(); };
      $('#edSt').onclick = (ev) => { const b = ev.target.closest('button'); if (!b) return; e.status = b.dataset.st;
        $('#edSt').querySelectorAll('button').forEach((x) => x.classList.toggle('sel', x === b)); contaEdicao(); };
      let t;
      $('#edBusca').oninput = () => { clearTimeout(t); t = setTimeout(buscarPeca, 220); };
    }
    $('#edForma').onchange = () => { e.forma = $('#edForma').value; contaEdicao(); };
    $('#edData').onchange = () => { e.data = $('#edData').value || e.data; contaEdicao(); };
    $('#edVend').onchange = () => { e.vend = $('#edVend').value; };
    $('#edCanal').onchange = () => { e.canal = $('#edCanal').value; };
    pintarCliente();
    contaEdicao();
    $('#edSair').onclick = () => { V.edit = null; pintarVenda(); };
    $('#edSalvar').onclick = salvarEdicao;
  }

  function pintarLinhas() {
    const e = V.edit, box = $('#edLinhas');
    if (!e.linhas.length) { box.innerHTML = '<div class="chk warn">A venda ficou sem peças. Ponha uma peça — ou, para desfazer a venda inteira, saia e use Cancelar venda.</div>'; return; }
    box.innerHTML = e.linhas.map((l, k) => {
      const lim = limite(l);
      const nota = l.od ? 'sob encomenda: para mudar, use Trocar no PDV' : l.sm ? `tem mais ${Math.max(0, lim - l.qty)} no estoque` : 'sem controle de estoque';
      return `<div class="el" data-k="${k}"><div class="nmw"><div class="nm">${esc(l.nome)}</div>
        <div class="mt">${l.orig ? `era ${l.orig} × ${BRL(V.aberta.itens.find((i) => i.variant_id === l.id)?.unit_price ?? l.preco)}` : 'peça nova'} · ${nota}${l.lista > l.preco + 0.005 ? ` · cheio ${BRL(l.lista)}` : ''}</div></div>
        <span class="stp"><button type="button" data-d="-1"${l.od ? ' disabled' : ''} aria-label="menos">−</button><span>${l.qty}</span>
          <button type="button" data-d="1"${l.od || l.qty >= lim ? ' disabled' : ''} aria-label="mais">+</button></span>
        <input type="number" min="0" step="0.01" inputmode="decimal" data-preco value="${r2(l.preco).toFixed(2)}" aria-label="preço da peça">
        <span class="lt">${BRL(l.preco * l.qty)}</span>
        <button type="button" class="ib" data-x="1"${l.od ? ' disabled' : ''} aria-label="tirar">${ICO('lixeira', 15)}</button></div>`;
    }).join('');
    box.onclick = (ev) => {
      const row = ev.target.closest('.el'); if (!row) return;
      const l = e.linhas[+row.dataset.k];
      const b = ev.target.closest('button'); if (!b || b.disabled) return;
      if (b.dataset.x) e.linhas.splice(+row.dataset.k, 1);
      else l.qty = Math.max(0, Math.min(limite(l), l.qty + (+b.dataset.d)));
      e.linhas = e.linhas.filter((x) => x.qty > 0);
      pintarLinhas(); contaEdicao();
    };
    box.oninput = (ev) => {
      if (!ev.target.matches('[data-preco]')) return;
      const row = ev.target.closest('.el'), l = e.linhas[+row.dataset.k];
      l.preco = Math.max(0, parseFloat(ev.target.value) || 0);
      row.querySelector('.lt').textContent = BRL(l.preco * l.qty);
      contaEdicao();
    };
  }

  async function buscarPeca() {
    const q = $('#edBusca').value.trim(), res = $('#edRes'), e = V.edit;
    if (!q) { res.innerHTML = ''; return; }
    let rows = [];
    try { rows = await api('/api/products?q=' + encodeURIComponent(q)); } catch (_) {}
    if (q !== $('#edBusca').value.trim()) return;
    res.innerHTML = rows.slice(0, 8).map((p, k) => {
      const ja = e.linhas.find((l) => l.id === p.id);
      const tem = p.on_demand ? 0 : p.stock_management ? p.stock - (ja ? ja.qty - ja.orig : 0) : 99;
      const nao = p.on_demand ? 'sob encomenda: use o PDV' : tem <= 0 ? 'esgotado' : '';
      return `<button type="button" data-k="${k}"${nao ? ' disabled' : ''}><span>${esc(p.product_name)} ${esc(p.variant_name || '')}</span>
        <small>${nao || `${BRL(precoV(p))}${p.stock_management ? ` · ${tem} no estoque` : ''}`}</small></button>`;
    }).join('') || '<div class="dnota">Nada encontrado.</div>';
    res.querySelectorAll('button').forEach((b) => {
      b.onclick = () => {
        const p = rows[+b.dataset.k], ja = e.linhas.find((l) => l.id === p.id);
        if (ja) ja.qty = Math.min(limite(ja), ja.qty + 1);
        else e.linhas.push({ id: p.id, nome: `${p.product_name} ${p.variant_name || ''}`.trim(), qty: 1, orig: 0, preco: precoV(p),
          stock: p.stock || 0, sm: p.stock_management, od: Boolean(p.on_demand), custo: p.cost || 0, lista: p.price });
        $('#edBusca').value = ''; res.innerHTML = '';
        pintarLinhas(); contaEdicao();
      };
    });
  }

  function pintarCliente() {
    const e = V.edit, box = $('#edCli');
    const nome = e.novoCliente || (e.cliente && e.cliente.nome);
    box.innerHTML = `<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        <b style="font-size:13px">${nome ? esc(nome) + (e.novoCliente ? ' <span class="tg info">novo</span>' : '') : '<span style="color:var(--ink-3)">sem cliente</span>'}</b>
        <button type="button" class="btn sm ghost" id="edCliTroca">${nome ? 'Trocar' : 'Escolher'}</button>
        ${nome ? '<button type="button" class="btn sm ghost" id="edCliTira">Tirar</button>' : ''}</div>
      <div id="edCliBusca" hidden style="margin-top:6px"><input id="edCliQ" placeholder="Nome ou @instagram…" autocomplete="off"><div class="busca-res" id="edCliRes" style="margin-top:4px"></div></div>`;
    $('#edCliTroca').onclick = () => { $('#edCliBusca').hidden = false; $('#edCliQ').focus(); };
    const tira = $('#edCliTira');
    if (tira) tira.onclick = () => { e.cliente = null; e.novoCliente = null; pintarCliente(); };
    buscaCliente($('#edCliQ'), $('#edCliRes'), (corpo, nomeEscolhido) => {
      if (corpo.new_customer) { e.novoCliente = corpo.new_customer.name; e.cliente = null; }
      else { e.cliente = { id: corpo.customer_id, nome: nomeEscolhido }; e.novoCliente = null; }
      pintarCliente();
    });
  }

  function contaEdicao() {
    const v = V.aberta, e = V.edit, box = $('#edConta');
    if (!box) return;
    let h = '';
    let total = v.total;
    if (!e.soDados) {
      const sub = r2(e.linhas.reduce((t, l) => t + l.preco * l.qty, 0));
      total = r2(Math.max(0, sub - e.desconto));
      const custo = r2(e.linhas.reduce((t, l) => t + l.custo * l.qty, 0));
      h += dc('Peças', sub) + (e.desconto ? dc('Desconto', -e.desconto, 'neg') : '') + dc('Total novo', total, 'tot');
      h += dc('Custo das peças', -custo, 'neg') + dc('Lucro', r2(total - custo), 'lucro' + (total - custo < 0 ? ' neg' : ''));
      // O que acontece no estoque (só a diferença).
      const mov = [];
      const antes = new Map();
      for (const i of v.itens) if (i.qty > 0 && i.variant_id) antes.set(i.variant_id, { q: (antes.get(i.variant_id)?.q || 0) + i.qty, nome: i.name });
      const ids = new Set([...antes.keys(), ...e.linhas.map((l) => l.id)]);
      for (const id of ids) {
        const l = e.linhas.find((x) => x.id === id), a = antes.get(id);
        const d = (l ? l.qty : 0) - (a ? a.q : 0);
        if (d) mov.push(`${d > 0 ? 'Sai do estoque' : 'Volta para o estoque'}: ${Math.abs(d)} × ${esc(l ? l.nome : a.nome)}`);
      }
      if (mov.length) h += `<div class="dnota">${mov.join('<br>')} <br>(aqui e no site)</div>`;
    }
    // O que acontece com o dinheiro.
    const st = e.soDados ? (v.payment_status === 'pendente' ? 'pendente' : 'pago') : e.status;
    const eraPago = v.payment_status === 'pago', dia = e.data.split('-').reverse().join('/');
    let din = '';
    if (st === 'pago' && !e.forma) din = '<div class="chk warn">Escolha a forma de pagamento: é por ela que o caixa fecha.</div>';
    else if (st === 'pago' && !eraPago) din = `<div class="chk info">${BRL(total)} entram no caixa de ${dia} (o dia da venda), em ${esc(formaNome(e.forma))}.</div>`;
    else if (st === 'pendente' && eraPago) din = `<div class="chk warn">Vira fiado: ${BRL(v.total)} saem do caixa e o cliente passa a dever ${BRL(total)}.</div>`;
    else if (st === 'pago' && Math.abs(total - v.total) >= 0.01) din = `<div class="chk info">O caixa de ${dia} passa de ${BRL(v.total)} para ${BRL(total)} (${total > v.total ? '+' : '−'} ${BRL(Math.abs(total - v.total))}).</div>`;
    else if (st === 'pendente' && Math.abs(total - v.total) >= 0.01) din = `<div class="chk info">O cliente passa a dever ${BRL(total)} (era ${BRL(v.total)}).</div>`;
    box.innerHTML = h + din;
  }

  async function salvarEdicao() {
    const v = V.aberta, e = V.edit;
    if (!e.soDados && !e.linhas.length) return pintarEdicao('A venda precisa de pelo menos uma peça. Para desfazer a venda inteira, use Cancelar venda.');
    const st = e.soDados ? v.payment_status : e.status;
    if (st === 'pago' && !e.forma) return pintarEdicao('Escolha a forma de pagamento (Pix, Espécie, Crédito ou Débito).');
    const corpo = { payment_method: e.forma, canal: e.canal, data: e.data, seller_id: e.vend ? Number(e.vend) : null };
    if (e.novoCliente) corpo.new_customer = { name: e.novoCliente };
    else corpo.customer_id = e.cliente ? e.cliente.id : null;
    if (!e.soDados) {
      corpo.items = e.linhas.map((l) => ({ variant_id: l.id, qty: l.qty, unit_price: r2(l.preco) }));
      corpo.discount = r2(e.desconto);
      corpo.payment_status = e.status;
    }
    const b = $('#edSalvar'); b.disabled = true; b.textContent = 'Salvando…';
    try {
      const r = await api('/api/sales/' + v.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
      V.edit = null;
      const extra = [
        r.caixa_fechado ? '<b style="color:var(--warn)">O caixa desse dia já estava fechado:</b> confira o fechamento.' : '',
        r.stock_na_fila ? 'O estoque sobe para a Nuvemshop na próxima rodada.' : '',
        r.conflitos && r.conflitos.length ? `<b style="color:var(--warn)">A Nuvemshop já não tinha:</b> ${r.conflitos.map((c) => esc(c.nome || c)).join(', ')} — ficou um lembrete.` : '',
      ].filter(Boolean).join('<br>');
      await depoisDeMudar({ html: `Venda corrigida: ${BRL(r.total)} · ${r.payment_status === 'pendente' ? 'fiado' : 'pago'}.${extra ? '<br>' + extra : ''}` }, true);
    } catch (err) {
      b.disabled = false; b.textContent = 'Salvar alterações';
      const a = $('#dvCorpo').querySelector('.dv-aviso.erro');
      if (a) a.textContent = err.message; else $('#dvCorpo').insertAdjacentHTML('afterbegin', `<div class="dv-aviso erro">${esc(err.message)}</div>`);
      $('#dvCorpo').scrollTop = 0;
    }
  }

  // Abriu em /vendas ou /financeiro#vendas: já cai na aba Vendas.
  if (location.pathname.startsWith('/vendas') || location.hash === '#vendas') abrirAba('vendas');
  else if (location.hash === '#lucro') abrirAba('lucro');
})();
