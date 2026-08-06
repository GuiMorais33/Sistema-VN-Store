// Navegação lateral compartilhada — injetada em todas as páginas.
(function () {
  const grupos = [
    { titulo: 'Operação', itens: [
      { href: '/',           ico: 'inicio',     label: 'Início',     match: (p) => p === '/' },
      { href: '/pdv',        ico: 'pdv',        label: 'PDV',        match: (p) => p.startsWith('/pdv') },
      { href: '/produtos',   ico: 'estoque',    label: 'Estoque',    match: (p) => p.startsWith('/produtos') || p.startsWith('/estoque') },
      { href: '/clientes',   ico: 'clientes',   label: 'Clientes',   match: (p) => p.startsWith('/clientes') },
      { href: '/compras',    ico: 'caixa_vazia',label: 'Compras',    match: (p) => p.startsWith('/compras') },
      { href: '/lembretes',  ico: 'sino',       label: 'Lembretes',  match: (p) => p.startsWith('/lembretes') },
    ] },
    { titulo: 'Gestão', itens: [
      { href: '/financeiro', ico: 'financeiro', label: 'Financeiro', match: (p) => p.startsWith('/financeiro') },
      { href: '/equipe',     ico: 'clientes',   label: 'Equipe',     match: (p) => p.startsWith('/equipe') },
      { href: '/relatorios', ico: 'grafico',    label: 'Relatórios', match: (p) => p.startsWith('/relatorios') },
      { href: '/agentes',    ico: 'agentes',    label: 'Agentes',    match: (p) => p.startsWith('/agentes') },
      { href: '/conectar',   ico: 'conectar',   label: 'Conectar',   match: (p) => p.startsWith('/conectar') },
      { href: '/ajuda',      ico: 'conversa',   label: 'Como usar',  match: (p) => p.startsWith('/ajuda') || p.startsWith('/como-usar') },
    ] },
  ];

  const path = location.pathname;
  const item = (it) => `<a class="nav-item${it.match(path) ? ' active' : ''}" href="${it.href}">`
    + ICO(it.ico, 19) + `<span>${it.label}</span></a>`;

  const side = document.createElement('aside');
  side.className = 'sidebar';
  side.innerHTML =
    `<a class="nav-brand" href="/"><span class="badge"><img src="/logo.webp" alt=""></span>`
    + `<span class="wordmark">VN<br>Store</span></a>`
    + grupos.map((g) => `<div class="nav-sec label">${g.titulo}</div>`
        + `<nav class="nav-list">${g.itens.map(item).join('')}</nav>`).join('')
    + `<div class="nav-foot">`
    +   `<span id="navStatus" class="pill"><span class="dot"></span>…</span>`
    +   `<div class="nav-meta">`
    +     `<span id="navClock" class="nav-clock">--:--</span>`
    +     `<a href="#" id="navLogout" class="nav-exit">${ICO('sair', 15)}<span>Sair</span></a>`
    +   `</div>`
    + `</div>`;
  document.body.insertAdjacentElement('afterbegin', side);

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

  // Estado da conexão
  fetch('/api/health').then((r) => r.json()).then((h) => {
    const p = side.querySelector('#navStatus');
    if (h.mode === 'live') { p.className = 'pill live'; p.innerHTML = '<span class="dot"></span>Ao vivo'; }
    else { p.className = 'pill demo'; p.innerHTML = '<span class="dot"></span>Demonstração'; }
  }).catch(() => {});
})();
