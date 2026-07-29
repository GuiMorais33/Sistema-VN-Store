// ============================================================
//  Ícones — line-art 24×24, traço 1.75, herda a cor do texto.
//  Um só estilo em todo o sistema (nada de emoji na interface).
// ============================================================
(function () {
  const P = {
    inicio: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9.5V20a1 1 0 0 0 1 1H10v-6h4v6h3.5a1 1 0 0 0 1-1V9.5"/>',
    pdv: '<path d="M3 4h2l2.4 11.2a1.5 1.5 0 0 0 1.5 1.2h8.2a1.5 1.5 0 0 0 1.5-1.2L20.5 8H6"/><circle cx="9.5" cy="20" r="1.4"/><circle cx="17.5" cy="20" r="1.4"/>',
    estoque: '<path d="m12 3 8 4.2v9.6L12 21l-8-4.2V7.2z"/><path d="m4 7.2 8 4.2 8-4.2"/><path d="M12 11.4V21"/>',
    clientes: '<circle cx="9" cy="8" r="3.2"/><path d="M2.8 20a6.2 6.2 0 0 1 12.4 0"/><path d="M16.5 5.2a3.2 3.2 0 0 1 0 5.9"/><path d="M18 14.4a6.2 6.2 0 0 1 3.2 5.6"/>',
    financeiro: '<path d="M3 8.5A2.5 2.5 0 0 1 5.5 6H18a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3z"/><path d="M3 8.5V7a2 2 0 0 1 2-2h11"/><circle cx="16.5" cy="12.5" r="1.3"/>',
    agentes: '<rect x="4" y="7.5" width="16" height="12" rx="3"/><path d="M12 7.5V4"/><circle cx="12" cy="3" r="1.2"/><path d="M9 12.5v1.5M15 12.5v1.5"/><path d="M9.5 16.5h5"/>',
    conectar: '<path d="M9 3v5M15 3v5"/><path d="M6.5 8h11v3.5a5.5 5.5 0 0 1-11 0z"/><path d="M12 17v4"/>',
    busca: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
    mais: '<path d="M12 5v14M5 12h14"/>',
    ok: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    alerta: '<path d="M12 4.5 2.8 20h18.4z"/><path d="M12 10v4"/><circle cx="12" cy="17" r=".8" fill="currentColor" stroke="none"/>',
    relogio: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    subiu: '<path d="m4 16 5.5-5.5 3.5 3.5L20 7.5"/><path d="M15 7.5h5v5"/>',
    desceu: '<path d="m4 8 5.5 5.5 3.5-3.5L20 16.5"/><path d="M15 16.5h5v-5"/>',
    etiqueta: '<path d="M3.5 11.2V5.5a2 2 0 0 1 2-2h5.7a2 2 0 0 1 1.4.6l7.4 7.4a2 2 0 0 1 0 2.8l-5.7 5.7a2 2 0 0 1-2.8 0L4.1 12.6a2 2 0 0 1-.6-1.4z"/><circle cx="8" cy="8" r="1.4"/>',
    entrega: '<path d="M3 7.5a1.5 1.5 0 0 1 1.5-1.5H14v10H3z"/><path d="M14 9.5h3.6a2 2 0 0 1 1.7 1l1.7 2.9V16H14z"/><circle cx="7" cy="18" r="1.8"/><circle cx="17.5" cy="18" r="1.8"/>',
    conversa: '<path d="M20.5 12c0 4.1-3.8 7.4-8.5 7.4-1 0-2-.15-2.9-.43L4 20.5l1.6-3.7A6.9 6.9 0 0 1 3.5 12C3.5 7.9 7.3 4.6 12 4.6s8.5 3.3 8.5 7.4z"/>',
    megafone: '<path d="M4 10v4a2 2 0 0 0 2 2h1.5l9-5.5v6.5"/><path d="M16.5 5.5 7.5 10H6a2 2 0 0 0-2 2"/><path d="M16.5 5.5V17"/><path d="M19.5 9.5a3 3 0 0 1 0 5"/>',
    recibo: '<path d="M6 3.5h12v17l-2.4-1.6-2.4 1.6-2.4-1.6L8.4 20.5 6 18.9z"/><path d="M9.5 8h5M9.5 12h5"/>',
    grafico: '<path d="M4 20V4"/><path d="M4 20h16"/><rect x="7.5" y="12" width="3" height="5" rx="1"/><rect x="12.5" y="8" width="3" height="9" rx="1"/><rect x="17" y="14" width="3" height="3" rx="1"/>',
    sair: '<path d="M14 4.5H6.5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2H14"/><path d="M17.5 12H10"/><path d="m15 9 3 3-3 3"/>',
    sync: '<path d="M20 12a8 8 0 0 1-13.7 5.6L4 15.5"/><path d="M4 12a8 8 0 0 1 13.7-5.6L20 8.5"/><path d="M4 20v-4.5h4.5M20 4v4.5h-4.5"/>',
    caixa_vazia: '<path d="M3.5 8.5h17v10a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path d="M2.5 8.5 5 4h14l2.5 4.5"/><path d="M12 4v4.5"/><path d="M9.5 13h5"/>',
  };
  window.ICO = function (name, size) {
    const d = P[name];
    if (!d) return '';
    const s = size || 20;
    return `<svg class="ico" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  };
})();
