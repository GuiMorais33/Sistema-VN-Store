// Navegação lateral compartilhada — injetada em todas as páginas.
// "Que dia é hoje?" no relógio do aparelho. toISOString() é sempre UTC:
// usado para isso, depois das 21h ele já respondia o dia seguinte.
window.diaLocal = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
window.mesLocal = (d = new Date()) => window.diaLocal(d).slice(0, 7);

// Lucro e margem só valem com custo cadastrado. "cob" é quanto do vendido
// tem custo (0 a 1; null = não há peças para medir). Sem custo, a margem
// sairia 100% — as telas mostram "—" e pedem o custo.
window.semCusto = (cob) => cob != null && cob < 0.05;
window.avisoCusto = (cob) => (cob == null || cob >= 0.95 ? ''
  : window.semCusto(cob) ? 'custos não preenchidos' : `${Math.round((1 - cob) * 100)}% das vendas sem custo`);

(function () {
  const grupos = [
    { titulo: 'Operação', itens: [
      { href: '/',           ico: 'inicio',     label: 'Início',     match: (p) => p === '/' || p.startsWith('/lembretes') },
      { href: '/pdv',        ico: 'pdv',        label: 'PDV',        match: (p) => p.startsWith('/pdv') },
      { href: '/produtos',   ico: 'estoque',    label: 'Estoque',    match: (p) => p.startsWith('/produtos') || p.startsWith('/estoque') || p.startsWith('/compras') },
      { href: '/clientes',   ico: 'clientes',   label: 'Clientes',   match: (p) => p.startsWith('/clientes') || p.startsWith('/crm') || p.startsWith('/funil') },
    ] },
    { titulo: 'Gestão', itens: [
      { href: '/negocio',    ico: 'grafico',    label: 'Negócio',    match: (p) => p.startsWith('/negocio') },
      { href: '/financeiro', ico: 'financeiro', label: 'Financeiro', match: (p) => p.startsWith('/financeiro') || p.startsWith('/relatorios') },
      { href: '/equipe',     ico: 'clientes',   label: 'Equipe',     match: (p) => p.startsWith('/equipe') },
      { href: '/agentes',    ico: 'agentes',    label: 'Agentes',    match: (p) => p.startsWith('/agentes') },
      { href: '/conectar',   ico: 'conectar',   label: 'Conectar',   match: (p) => p.startsWith('/conectar') },
      { href: '/ajuda',      ico: 'conversa',   label: 'Como usar',  match: (p) => p.startsWith('/ajuda') || p.startsWith('/como-usar') },
    ] },
  ];

  const path = location.pathname;
  // No celular a barra de cima cabe 5 + "Mais"; o resto vai para o painel.
  const NO_CELULAR = ['/', '/pdv', '/produtos', '/clientes', '/financeiro'];
  const item = (it) => `<a class="nav-item${it.match(path) ? ' active' : ''}${NO_CELULAR.includes(it.href) ? '' : ' so-pc'}" href="${it.href}">`
    + ICO(it.ico, 19) + `<span>${it.label}</span></a>`;
  const extras = grupos.flatMap((g) => g.itens).filter((it) => !NO_CELULAR.includes(it.href));

  const side = document.createElement('aside');
  side.className = 'sidebar';
  side.innerHTML =
    `<a class="nav-brand" href="/"><span class="badge"><img src="/logo.webp" alt=""></span>`
    + `<span class="wordmark">VN<br>Store</span></a>`
    + grupos.map((g) => `<div class="nav-sec label">${g.titulo}</div>`
        + `<nav class="nav-list">${g.itens.map(item).join('')}</nav>`).join('')
    + `<button type="button" class="nav-item nav-mais${extras.some((it) => it.match(path)) ? ' active' : ''}" id="navMais">`
    +   ICO('mais', 19) + '<span>Mais</span></button>'
    + `<div class="nav-foot">`
    +   `<span id="navStatus" class="pill"><span class="dot"></span>…</span>`
    +   `<div class="nav-meta">`
    +     `<span id="navClock" class="nav-clock">--:--</span>`
    +     `<a href="#" id="navLogout" class="nav-exit">${ICO('sair', 15)}<span>Sair</span></a>`
    +   `</div>`
    + `</div>`;
  document.body.insertAdjacentElement('afterbegin', side);

  // Painel do "Mais" (só no celular).
  const painel = document.createElement('nav');
  painel.className = 'nav-painel';
  painel.hidden = true;
  painel.innerHTML = extras.map((it) => `<a class="${it.match(path) ? 'active' : ''}" href="${it.href}">${ICO(it.ico, 18)}<span>${it.label}</span></a>`).join('')
    + `<a href="#" id="navSair2">${ICO('sair', 18)}<span>Sair</span></a>`;
  document.body.appendChild(painel);
  side.querySelector('#navMais').addEventListener('click', () => {
    painel.style.top = side.getBoundingClientRect().bottom + 'px';
    painel.hidden = !painel.hidden;
  });
  document.addEventListener('click', (e) => {
    if (!painel.hidden && !e.target.closest('.nav-painel') && !e.target.closest('#navMais')) painel.hidden = true;
  });
  painel.querySelector('#navSair2').addEventListener('click', async (e) => {
    e.preventDefault();
    try { await fetch('/api/logout', { method: 'POST' }); } catch (_) {}
    location.href = '/login';
  });

  // Relógio
  const clk = side.querySelector('#navClock');
  const pad = (n) => String(n).padStart(2, '0');
  const tick = () => { const d = new Date(); clk.textContent = pad(d.getHours()) + ':' + pad(d.getMinutes()); };
  tick(); setInterval(tick, 1000);

  // Sair
  side.querySelector('#navLogout').addEventListener('click', async (e) => {
    e.preventDefault();
    try { await fetch('/api/logout', { method: 'POST' }); } catch (_) {}
    location.href = '/login';
  });

  // Luz na borda do cartão sob o mouse (o desenho está no theme.css).
  let aceso = null;
  document.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    const c = e.target.closest?.('.card,.kpi');
    if (c !== aceso) { aceso?.classList.remove('luz'); aceso = c; c?.classList.add('luz'); }
    if (!c) return;
    const r = c.getBoundingClientRect();
    c.style.setProperty('--mx', (e.clientX - r.left) + 'px');
    c.style.setProperty('--my', (e.clientY - r.top) + 'px');
  }, { passive: true });
  document.addEventListener('pointerleave', () => { aceso?.classList.remove('luz'); aceso = null; });

  // Estado da conexão
  fetch('/api/health').then((r) => r.json()).then((h) => {
    const p = side.querySelector('#navStatus');
    if (h.mode === 'live') { p.className = 'pill live'; p.innerHTML = '<span class="dot"></span>Ao vivo'; }
    else { p.className = 'pill demo'; p.innerHTML = '<span class="dot"></span>Demonstração'; }
  }).catch(() => {});
})();
