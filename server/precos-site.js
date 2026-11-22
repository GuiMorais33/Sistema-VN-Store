// ============================================================
//  Preços do site (Black Friday e outras promoções do carrinho).
//
//  A promoção que o dono cria no menu "Promoções" da Nuvemshop (ex.: 25%
//  em camisetas) não fica gravada no produto, e a API não a entrega: a lista
//  de promoções da API só traz as que o próprio app criou. Mas o site mostra
//  o preço com o desconto para quem visita — cada produto da lista de
//  produtos traz, na própria página, o preço de agora, o "de" e a
//  porcentagem. Então o sistema lê o site como um cliente, página por
//  página, e guarda o preço de cada variação (variants.preco_site). O PDV
//  cobra o menor entre o cheio, o promocional do produto e o do site.
//
//  Conferido em novembro na loja de verdade: das 754 variações com estoque,
//  todas estavam no site, o "de" batia com o preço daqui em todas as que
//  tinham desconto, e nenhuma veio diferente.
// ============================================================
import db, { getSetting, setSetting } from './db.js';

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Os produtos de uma página da loja: o atributo data-variants de cada item
// (JSON, com aspas simples ou com as aspas em &quot;).
const ENTIDADES = { '&quot;': '"', '&#34;': '"', '&#39;': "'", '&apos;': "'", '&lt;': '<', '&gt;': '>', '&amp;': '&' };
const desfazer = (t) => t.replace(/&(quot|#34|#39|apos|lt|gt|amp);/g, (m) => ENTIDADES[m]);
export function extrair(html) {
  const out = [];
  for (const m of String(html).matchAll(/data-variants=(['"])(.*?)\1/gs)) {
    try {
      const lista = JSON.parse(desfazer(m[2]));
      if (Array.isArray(lista)) out.push(...lista.filter((v) => v && v.id != null && Number.isFinite(Number(v.price_number))));
    } catch (_) { /* item que não é produto */ }
  }
  return out;
}

const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));

// Lê a lista de produtos do site inteira (/produtos/, /produtos/page/2/…).
// Para quando a página vem sem produto ou só repete os que já vieram (a
// loja devolve a última página de novo depois do fim).
export async function lerSite(base, { maxPaginas = 200, esperaMs = 400, tempoMs = 30000 } = {}) {
  const precos = new Map();
  let paginas = 0, completo = false;
  for (let n = 1; n <= maxPaginas; n++) {
    const url = `${base.replace(/\/+$/, '')}/produtos/${n > 1 ? `page/${n}/` : ''}`;
    let html;
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (VN Store sistema; precos)' }, signal: AbortSignal.timeout(tempoMs) });
      if (!r.ok) throw new Error(`o site respondeu ${r.status}`);
      html = await r.text();
    } catch (err) {
      if (n === 1) throw new Error(`Não deu para abrir o site (${url}): ${err.message}`);
      break;   // parou no meio: fica o que deu para ler, sem apagar o resto
    }
    paginas = n;
    const itens = extrair(html);
    html = null;
    let novos = 0;
    for (const v of itens) {
      const id = String(v.id);
      if (precos.has(id)) continue;
      novos += 1;
      precos.set(id, {
        preco: money(v.price_number),
        de: v.compare_at_price_number != null ? money(v.compare_at_price_number) : null,
        pct: v.discount_percentage_number ?? null,
      });
    }
    if (!itens.length || !novos) { completo = true; break; }
    if (esperaMs) await espera(esperaMs);
  }
  return { precos, paginas, completo };
}

// Guarda o preço do site de cada variação daqui. Só vale se for MENOR que o
// preço daqui (é desconto); igual ou maior, fica vazio. Variação que não
// apareceu no site fica vazia — mas só quando a leitura foi até o fim e
// achou pelo menos metade do que achou da outra vez (o site caiu no meio:
// melhor manter a promoção de antes do que tirar de todo mundo).
export function gravar({ precos, completo }) {
  const antes = parseInt(getSetting('precos_site_n'), 10) || 0;
  const confiavel = completo && precos.size >= antes * 0.5;
  const todas = db.prepare('SELECT id, nuvemshop_variant_id, price FROM variants WHERE nuvemshop_variant_id IS NOT NULL').all();
  const upd = db.prepare('UPDATE variants SET preco_site = ? WHERE id = ?');
  let comDesconto = 0, achadas = 0;
  db.transaction(() => {
    for (const v of todas) {
      const s = precos.get(String(v.nuvemshop_variant_id));
      if (s) {
        achadas += 1;
        const desconto = s.preco > 0 && s.preco + 0.005 < v.price ? s.preco : null;
        if (desconto) comDesconto += 1;
        upd.run(desconto, v.id);
      } else if (confiavel) upd.run(null, v.id);
    }
  })();
  if (confiavel) setSetting('precos_site_n', String(precos.size));
  return { no_site: precos.size, achadas, com_desconto: comDesconto, completo: confiavel };
}
