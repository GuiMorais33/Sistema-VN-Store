// ============================================================
//  Busca de produtos que entende o jeito que a loja escreve.
//
//  Antes a busca procurava o texto inteiro, do jeito que foi digitado:
//  "boné lacoste" achava, "lacoste boné" não; "camiseta nike g" não achava
//  nada (o G está na variação, não no nome). No balcão ninguém digita o
//  nome exato do cadastro. Agora:
//   - cada palavra vale sozinha, em qualquer ordem, e pode estar no nome,
//     na marca, na categoria, no tamanho ou no SKU;
//   - basta o começo da palavra ("lac" acha Lacoste), sem acento, sem
//     maiúscula, singular ou plural;
//   - palavras da loja que querem dizer a mesma coisa (tênis/sneaker,
//     boné/cap, moletom/hoodie, bermuda/short…) e apelidos (LV, NB, AF1);
//   - um erro de digitação passa ("lacsote", "camieta");
//   - tamanho (P, M, G, 42, único) mostra só aquele tamanho;
//   - palavra que não existe em nenhum produto ("preta", quando a cor não
//     está no cadastro) é deixada de lado, e o PDV diz qual foi.
//  O que mais combina vem primeiro; empatou, o que mais vende.
// ============================================================
import db, { semAcento } from './db.js';

// Palavras que não dizem nada sozinhas ("tênis DE corrida", "tam 42").
const PARADAS = new Set(['de', 'da', 'do', 'das', 'dos', 'com', 'e', 'pra', 'para', 'o', 'a', 'os', 'as', 'um', 'uma',
  'no', 'na', 'em', 'x', 'tam', 'tamanho', 'numero', 'num', 'n', 'n°', 'nº', 'cor', 'modelo']);

// Palavra no singular, para "camisetas" achar "camiseta" (e vice-versa).
// Vale dos dois lados (o que foi digitado e o cadastro), então "tênis" e
// "jeans" continuam se achando.
const singular = (w) => (w.length > 3 && w.endsWith('s') && !/\d/.test(w) ? w.slice(0, -1) : w);

// Tamanho: só vale a palavra inteira ("g" não pode achar "Gucci").
const TAMANHO = /^(pp|p|m|g|gg|xg|xgg|eg|egg|exg|g\d|unico|\d{1,3})$/;
const UNICO = new Set(['unico', 'unica', 'uni', 'u', 'tu']);

const palavras = (t) => semAcento(t).replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
const normal = (w) => (UNICO.has(w) ? 'unico' : singular(w));

// Palavras que a loja usa para a mesma coisa. Tudo no mesmo grupo se acha.
const GRUPOS = [
  ['tenis', 'sneaker', 'sneakers'],
  ['bone', 'cap', 'aba'],
  ['camiseta', 'camisa', 'tshirt', 'blusa'],
  ['moletom', 'moleton', 'hoodie', 'blusa', 'casaco', 'agasalho', 'canguru'],
  ['jaqueta', 'jacket', 'casaco', 'corta', 'puffer', 'bobojaco'],
  ['bermuda', 'short', 'shorts'],
  ['calca', 'pants', 'jogger', 'jogador'],
  ['chinelo', 'slide', 'sandalia'],
  ['oculos', 'glasses'],
  ['conjunto', 'kit'],
  ['sueter', 'trico', 'tricot', 'cardigan'],
  ['cueca', 'boxer'],
  ['relogio', 'watch'],
  ['bag', 'bolsa', 'pochete', 'shoulder'],
  ['beachwear', 'praia', 'tactel'],
];
// Apelidos de marca e modelo → uma palavra que está no cadastro.
const APELIDOS = {
  lv: ['vuitton'], nb: ['balance'], rl: ['lauren'], ea7: ['armani'], ax: ['armani'], af1: ['force'], af: ['force'],
  cb: ['blanca'], nk: ['nike'], hb: ['boss'], fp: ['perry'], dg: ['dolce'], ck: ['klein'], rb: ['ban'], mq: ['mcqueen'],
};
const PARENTES = new Map();
for (const g of GRUPOS) {
  const n = g.map(normal);
  for (const w of n) {
    if (!PARENTES.has(w)) PARENTES.set(w, new Set());
    for (const x of n) if (x !== w) PARENTES.get(w).add(x);
  }
}
for (const [ap, alvo] of Object.entries(APELIDOS)) PARENTES.set(ap, new Set(alvo.map(normal)));

// Distância entre duas palavras contando troca de letra vizinha como um
// erro só ("lacsote" → "lacoste").
function distancia(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let menor = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      menor = Math.min(menor, d[i][j]);
    }
    if (menor > max) return max + 1;
  }
  return d[a.length][b.length];
}

// Quanto a palavra digitada combina com uma palavra do cadastro:
// 3 igual · 2 começo da palavra ou parente · 1,5 com um erro · 1 no meio
// ou com dois erros · 0 nada.
function combina(t, w) {
  if (t === w) return 3;
  if (TAMANHO.test(t) || /^\d+$/.test(t)) return 0;             // número e tamanho: só igual
  if (w.startsWith(t)) return 2;
  const p = PARENTES.get(t);
  if (p && (p.has(w) || [...p].some((x) => x.length >= 4 && w.startsWith(x)))) return 2;
  if (t.length >= 4 && w.includes(t)) return 1;
  if (t.length >= 4 && !/^\d+$/.test(w)) {
    const max = t.length >= 7 ? 2 : 1;
    const d = distancia(t, w, max);
    if (d <= max) return d <= 1 ? 1.5 : 1;   // "camieta": camiseta (1 erro) antes de camisa (2)
    if (w.length > t.length && distancia(t, w.slice(0, t.length), 1) <= 1) return 1;   // começou a digitar, com um erro
  }
  return 0;
}

// ---- Índice: o texto de cada produto e de cada variação ----
// Refeito quando o catálogo muda (produto novo, nome trocado, variação
// nova). A conferência é barata: duas contas no banco por busca.
let indice = null, chaveIndice = '';
function montarIndice() {
  const k = db.prepare(`SELECT (SELECT COUNT(*) FROM variants) || ':' || (SELECT COALESCE(MAX(id),0) FROM variants) || ':' ||
    (SELECT COUNT(*) FROM products) || ':' || (SELECT COALESCE(MAX(updated_at),'') FROM products) AS k`).get().k;
  if (indice && k === chaveIndice) return indice;
  const prods = new Map();
  const juntas = (ws) => ws.slice(0, -1).map((w, i) => w + ws[i + 1]);   // "air force" → "airforce"
  for (const p of db.prepare('SELECT id, name, brand, category, categories_all FROM products').all()) {
    const nome = palavras(p.name), marca = palavras(p.brand);
    // Nome, marca e categoria separados: o que está no NOME vale mais. A
    // marca no cadastro da loja às vezes está errada (boné Adidas marcado
    // como Lacoste) e não pode passar na frente do produto certo.
    prods.set(p.id, {
      id: p.id, nomeNorm: nome.join(' '), tipo: normal(nome[0] || ''),
      nome: [...new Set([...nome, ...juntas(nome)].map(normal))],
      marca: [...new Set([...marca, ...juntas(marca)].map(normal))],
      categorias: [...new Set([...palavras(p.category), ...palavras(p.categories_all)].map(normal))],
      variantes: [],
    });
  }
  for (const v of db.prepare('SELECT id, product_id, product_name, variant_name, sku FROM variants').all()) {
    let p = prods.get(v.product_id);
    if (!p) {   // variação sem produto: o nome vem dela
      const nome = palavras(v.product_name);
      p = { id: -v.id, nomeNorm: nome.join(' '), tipo: normal(nome[0] || ''), nome: [...new Set(nome.map(normal))], marca: [], categorias: [], variantes: [] };
      prods.set(p.id, p);
    }
    p.variantes.push({ id: v.id, palavras: [...new Set(palavras(v.variant_name).map(normal))], sku: semAcento(v.sku || '').trim() });
  }
  indice = [...prods.values()].filter((p) => p.variantes.length);
  chaveIndice = k;
  return indice;
}

// A melhor nota de uma palavra digitada numa lista de palavras do cadastro.
// Guarda o resultado por palavra: o catálogo repete muito ("camiseta",
// "nike"), e a mesma conta não precisa ser refeita milhares de vezes.
function notaEm(t, lista, memo) {
  let melhor = 0;
  for (const w of lista) {
    const k = t + '|' + w;
    let n = memo.get(k);
    if (n === undefined) { n = combina(t, w); memo.set(k, n); }
    if (n > melhor) { melhor = n; if (n === 3) break; }
  }
  return melhor;
}

// Procura. Devolve as variações que combinam, com a nota do produto, as
// palavras deixadas de lado e se é resultado "parecido" (nenhum produto
// tinha todas as palavras).
export function procurar(q) {
  // Só palavras "vazias" ("de", "com")? Então elas mesmas valem.
  const todas = palavras(q);
  const digitadas = (todas.some((w) => !PARADAS.has(w)) ? todas.filter((w) => !PARADAS.has(w)) : todas).map(normal);
  const termos = [...new Set(digitadas)];
  if (!termos.length) return { variantes: [], ignoradas: [], parecidos: false, termos };
  const memo = new Map();
  const frase = palavras(q).join(' ');
  // Duas palavras seguidas do que foi digitado, juntas no nome também
  // ("calça jeans" antes de "Calça Alfaiataria … Jeans").
  const pares = palavras(q).slice(0, -1).map((w, i, a) => w + ' ' + palavras(q)[i + 1]).filter((x) => x.length >= 5);
  const achados = [];
  const existe = new Set();   // palavras que combinam com algum produto
  for (const p of montarIndice()) {
    const notasP = termos.map((t) => Math.max(notaEm(t, p.nome, memo), notaEm(t, p.marca, memo) - 0.5,
      notaEm(t, p.categorias, memo) - 1, 0));
    const vars = p.variantes.map((v) => ({
      id: v.id,
      notas: termos.map((t, i) => Math.max(notasP[i], notaEm(t, v.palavras, memo), v.sku && v.sku === t ? 3 : 0)),
    }));
    termos.forEach((t, i) => { if (vars.some((v) => v.notas[i] > 0)) existe.add(t); });
    achados.push({ p, notasP, vars });
  }
  // A melhor nota de cada palavra no catálogo inteiro.
  const forca = termos.map((_, i) => Math.max(0, ...achados.flatMap((a) => a.vars.map((v) => v.notas[i]))));
  let valem = termos.map((t) => existe.has(t));
  if (!valem.some(Boolean)) return { variantes: [], ignoradas: termos, parecidos: false, termos };

  // Quantas palavras (das que valem) cada variação tem.
  const contar = (notas, m) => notas.reduce((n, x, i) => n + (m[i] && x > 0 ? 1 : 0), 0);
  const melhorCom = (m) => Math.max(0, ...achados.flatMap((a) => a.vars.map((v) => contar(v.notas, m))));
  let total = valem.filter(Boolean).length;
  let melhor = melhorCom(valem);
  // Nenhum produto tem todas: a palavra que só "parece" com alguma do
  // cadastro (um erro de digitação possível, como "preta" ~ "prata") é a
  // primeira a sair — o mais provável é ela não estar no cadastro.
  if (melhor < total) {
    const fortes = valem.map((ok, i) => ok && forca[i] >= 2);
    const nFortes = fortes.filter(Boolean).length;
    if (nFortes && nFortes < total && melhorCom(fortes) === nFortes) { valem = fortes; total = nFortes; melhor = nFortes; }
  }
  const ignoradas = termos.filter((_, i) => !valem[i]);
  const parecidos = melhor < total;
  const variantes = [];
  for (const a of achados) {
    for (const v of a.vars) {
      if (contar(v.notas, valem) < melhor) continue;
      let nota = v.notas.reduce((s, x, i) => s + (valem[i] ? x : 0), 0);
      if (frase.length >= 3 && a.p.nomeNorm.includes(frase)) nota += 2;      // digitou um pedaço do nome, na ordem
      else nota += 0.5 * pares.filter((x) => (' ' + a.p.nomeNorm + ' ').includes(' ' + x + ' ')).length;
      // O tipo do produto é a primeira palavra do nome: "hoodie" acha o
      // Moletom antes da Bermuda Moletom; "tênis" acha Tênis antes de meia.
      if (termos.some((t, i) => valem[i] && notaEm(t, [a.p.tipo], memo) >= 2)) nota += 1;
      variantes.push({ id: v.id, produto: a.p.id, nota });
    }
  }
  return { variantes, ignoradas, parecidos, termos };
}

// Para a aba Estoque, que lista produtos: a nota de cada produto que tem
// alguma variação combinando.
export function procurarProdutos(q) {
  const r = procurar(q);
  const notas = new Map();
  for (const v of r.variantes) notas.set(v.produto, Math.max(notas.get(v.produto) || 0, v.nota));
  return { notas, ignoradas: r.ignoradas, parecidos: r.parecidos };
}
