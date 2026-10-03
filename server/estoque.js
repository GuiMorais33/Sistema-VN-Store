// ============================================================
//  Estoque na loja (Nuvemshop): como o que muda aqui chega lá.
//
//  Duas pontas vendem a mesma peça: o balcão (aqui) e o site (lá).
//  A venda do site só aparece aqui na sincronização de produtos, então
//  o número daqui pode estar atrasado. Se o balcão mandasse esse número
//  para a loja, desfaria a venda do site — e o site venderia peça que
//  não existe.
//
//  Regra: a loja recebe o número DELA, ajustado pelo que mudou aqui.
//    - venda e entrada guardam a diferença (variants.ns_delta);
//    - na hora de enviar, lê o estoque atual da loja e soma a diferença;
//    - contagem à mão (variants.ns_fixar) é a exceção: vale como está.
//  O que não subir (loja fora do ar, internet caiu) fica na fila e vai
//  de novo na próxima rodada automática ou no botão Sincronizar.
// ============================================================
import db from './db.js';
import * as nuvem from './nuvemshop.js';

// Um envio por vez. Dois envios da mesma peça ao mesmo tempo leriam o
// mesmo número da loja, e o segundo apagaria o primeiro.
let fila = Promise.resolve();
export function naFila(fn) {
  const vez = fila.then(() => fn());
  fila = vez.catch(() => {});
  return vez;
}

const ler = db.prepare(`SELECT v.*, COALESCE(p.on_demand,0) AS on_demand
  FROM variants v LEFT JOIN products p ON p.id = v.product_id WHERE v.id = ?`);

// A loja aceitou "valor". Sai da fila o que foi enviado, e o número daqui
// passa a ser o da loja mais o que mudou aqui enquanto o envio estava no
// ar (isso continua na fila). Se houve contagem à mão no meio tempo, a
// versão mudou e nada é tocado: a contagem é que vale.
const gravar = db.prepare(`UPDATE variants SET
    stock    = MAX(0, @valor + ns_delta - @delta),
    on_hand  = CASE WHEN @proprio = 1 THEN MAX(0, @valor + ns_delta - @delta) ELSE on_hand END,
    ns_delta = ns_delta - @delta, ns_fixar = 0, updated_at = @ts
  WHERE id = @id AND ns_versao = @versao`);

// Tira da fila sem enviar: não há o que fazer na loja.
const descartar = db.prepare(`UPDATE variants SET ns_delta = ns_delta - @delta, ns_fixar = 0
  WHERE id = @id AND ns_versao = @versao`);

const marcarContagem = db.prepare(`UPDATE variants SET ns_fixar = 1, ns_delta = 0,
  ns_versao = ns_versao + 1 WHERE id = ?`);

// "v" é a linha da variação lida ANTES do envio (com ns_delta e ns_versao
// daquele momento).
export function gravarEnviado(v, valor, sobEncomenda) {
  return gravar.run({
    id: v.id, valor, delta: v.ns_delta || 0, versao: v.ns_versao || 0,
    proprio: sobEncomenda ? 0 : 1, ts: new Date().toISOString(),
  }).changes > 0;
}

// O número foi digitado à mão (contagem): vale na loja como está, e a
// diferença que estava na fila perde o sentido — a contagem já a inclui.
export function contagemAMao(variantId) {
  marcarContagem.run(variantId);
}

async function enviarUma(id) {
  const v = ler.get(id);
  if (!v || !v.nuvemshop_product_id || !v.nuvemshop_variant_id) return { enviado: false };
  if (!v.ns_delta && !v.ns_fixar) return { enviado: false };
  const marca = { id: v.id, delta: v.ns_delta, versao: v.ns_versao };
  // Sob encomenda a grade do site é sua: venda não mexe nela, só a mão.
  if (!v.stock_management || (v.on_demand && !v.ns_fixar)) { descartar.run(marca); return { enviado: false }; }

  let valor;
  try {
    if (v.ns_fixar) valor = Math.max(0, v.stock);
    else {
      const naLoja = await nuvem.getVariant(v.nuvemshop_product_id, v.nuvemshop_variant_id);
      // A loja não controla o estoque dessa peça: não há número a acertar.
      if (!naLoja || naLoja.stock == null) { descartar.run(marca); return { enviado: false }; }
      valor = Math.max(0, (parseInt(naLoja.stock, 10) || 0) + v.ns_delta);
    }
    await nuvem.setVariantStock(v.nuvemshop_product_id, v.nuvemshop_variant_id, valor);
  } catch (err) {
    // A peça não existe mais na loja: não há onde aplicar.
    if (err.status === 404) { descartar.run(marca); return { enviado: false, erro: 'não existe mais na loja' }; }
    throw err;
  }
  gravarEnviado(v, valor, v.on_demand);
  return { enviado: true, valor };
}

// Envia agora o que estas variações têm na fila. Para cada uma diz se
// subiu; quando não sobe por falha da loja, "naFila" avisa que ela vai
// de novo depois.
export function enviarEstoque(ids) {
  return naFila(async () => {
    const out = [];
    for (const id of ids) {
      try { out.push({ id, ...(await enviarUma(id)) }); }
      catch (err) { out.push({ id, enviado: false, erro: err.message, naFila: true }); }
    }
    return out;
  });
}

// Tudo que ficou para trás (loja fora do ar na hora da venda, etc.).
export async function enviarPendentes() {
  if (!nuvem.isConfigured()) return { enviados: 0, falhas: 0 };
  const ids = db.prepare(`SELECT id FROM variants WHERE (ns_delta <> 0 OR ns_fixar = 1)
    AND nuvemshop_variant_id IS NOT NULL ORDER BY id`).all().map((r) => r.id);
  if (!ids.length) return { enviados: 0, falhas: 0 };
  const r = await enviarEstoque(ids);
  const falhas = r.filter((x) => x.naFila);
  return {
    enviados: r.filter((x) => x.enviado).length,
    falhas: falhas.length,
    erro: falhas.length ? falhas[0].erro : null,
  };
}
