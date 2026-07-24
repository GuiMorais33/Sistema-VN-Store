// Navegação lateral compartilhada — injetada em todas as páginas.
(function () {
  const items = [
    { href: '/',          ico: '🏠', label: 'Início',     match: (p) => p === '/' },
    { href: '/pdv',       ico: '🛒', label: 'PDV',        match: (p) => p.startsWith('/pdv') },
    { href: '/produtos',  ico: '📦', label: 'Estoque',    match: (p) => p.startsWith('/produtos') || p.startsWith('/estoque') },
    { href: '/clientes',  ico: '👥', label: 'Clientes',   match: (p) => p.startsWith('/clientes') },
    { href: '/financeiro',ico: '💰', label: 'Financeiro', match: (p) => p.startsWith('/financeiro') },
    { href: '/agentes',   ico: '🐊', label: 'Agentes',    match: (p) => p.startsWith('/agentes') },
  ];
  const path = location.pathname;
  const side = document.createElement('aside');
  side.className = 'sidebar';
  side.innerHTML =
    `<a class="nav-brand" href="/"><span class="badge"><img src="/logo.webp" alt="VN Store"></span><span class="nav-word">VN<br>Store</span></a>` +
    `<nav class="nav-list">` +
    items.map((it) => `<a class="nav-item${it.match(path) ? ' active' : ''}" href="${it.href}"><span class="ico">${it.ico}</span><span class="lbl">${it.label}</span></a>`).join('') +
    `</nav>` +
    `<div class="nav-foot"><span id="navStatus" class="pill demo"><span class="dot"></span>…</span><span id="navClock" class="nav-clock">--:--</span><a href="#" id="navLogout" class="nav-clock" style="text-decoration:none;color:var(--ink-faint)">Sair</a></div>`;
  document.body.insertAdjacentElement('afterbegin', side);

  // Relógio
  const clk = side.querySelector('#navClock');
  const pad = (n) => String(n).padStart(2, '0');
  const tick = () => { const d = new Date(); clk.textContent = pad(d.getHours()) + ':' + pad(d.getMinutes()); };
  tick(); setInterval(tick, 1000);

  // Sair
  const lo = side.querySelector('#navLogout');
  if (lo) lo.addEventListener('click', async (e) => { e.preventDefault(); try { await fetch('/api/logout', { method: 'POST' }); } catch (_) {} location.href = '/login'; });

  // Status ao vivo / demo
  fetch('/api/health').then((r) => r.json()).then((h) => {
    const p = side.querySelector('#navStatus');
    if (h.mode === 'live') { p.className = 'pill live'; p.innerHTML = '<span class="dot"></span>Ao vivo'; }
    else { p.className = 'pill demo'; p.innerHTML = '<span class="dot"></span>Demo'; }
  }).catch(() => {});
})();
