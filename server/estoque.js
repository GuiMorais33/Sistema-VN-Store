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
// Trava de segurança: uma tarefa que passe do limite (a conversa com a loja
// travou) é abandonada e a fila anda — senão a baixa de TODAS as vendas
// seguintes ficaria parada atrás dela. Cada pedido à loja já corta em 45 s,
// então o limite só pega o que não deveria acontecer.
const LIMITE_FILA_MS = parseInt(process.env.LIMITE_FILA_MS, 10) || 10 * 60e3;
let fila = Promise.resolve();
export function naFila(fn) {
  const vez = fila.then(() => {
    let relogio;
    const limite = new Promise((_, nao) => {
      relogio = setTimeout(() => nao(new Error('A conversa com a loja travou; a fila seguiu sem ela.')), LIMITE_FILA_MS);
    });
    return Promise.race([Promise.resolve().then(fn), limite]).finally(() => clearTimeout(relogio));
  });
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
    ns_delta = ns_delta - @delta, ns_fixar = 0, ns_tentado = NULL, updated_at = @ts
  WHERE id = @id AND ns_versao = @versao`);

// Tira da fila sem enviar: não há o que fazer na loja.
const descartar = db.prepare(`UPDATE variants SET ns_delta = ns_delta - @delta, ns_fixar = 0, ns_tentado = NULL
  WHERE id = @id AND ns_versao = @versao`);
const anotarTentado = db.prepare('UPDATE variants SET ns_tentado = ?, ns_tentado_delta = ? WHERE id = ?');

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
      const remoto = parseInt(naLoja.stock, 10) || 0;
      // A última tentativa ficou sem resposta, mas a loja já tem o número
      // que foi mandado: ela chegou. Mandar de novo baixaria duas vezes.
      // Sai da fila só o que ia naquela tentativa; venda que veio depois
      // continua e sobe agora.
      if (v.ns_tentado != null && remoto === v.ns_tentado) {
        gravar.run({ id: v.id, valor: remoto, delta: v.ns_tentado_delta || 0, versao: v.ns_versao || 0,
          proprio: v.on_demand ? 0 : 1, ts: new Date().toISOString() });
        const resto = ler.get(id);
        if (resto && (resto.ns_delta || resto.ns_fixar)) return enviarUma(id);
        return { enviado: true, valor: remoto, ja_estava: true };
      }
      valor = Math.max(0, remoto + v.ns_delta);
    }
    anotarTentado.run(valor, v.ns_fixar ? null : v.ns_delta, v.id);
    await nuvem.setVariantStock(v.nuvemshop_product_id, v.nuvemshop_variant_id, valor);
  } catch (err) {
    // A peça não existe mais na loja: não há onde aplicar.
    if (err.status === 404) { descartar.run(marca); return { enviado: false, erro: 'não existe mais na loja' }; }
    // A loja respondeu com erro: a gravação não aconteceu, nada a conferir.
    if (err.status) anotarTentado.run(null, null, v.id);
    throw err;
  }
  gravarEnviado(v, valor, v.on_demand);
  return { enviado: true, valor };
}

// Envia agora o que estas variações têm na fila. Para cada uma diz se
// subiu; quando não sobe por falha da loja, "naFila" avisa que ela vai
// de novo depois.
// Falha de rede (sem resposta da loja): a loja está fora do ar ou a internet
// caiu. Não adianta seguir peça por peça esperando o tempo-limite de cada
// uma — o resto fica na fila e vai inteiro na próxima volta.
const semResposta = (err) => !err.status;
export function enviarEstoque(ids) {
  return naFila(async () => {
    const out = [];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      try { out.push({ id, ...(await enviarUma(id)) }); }
      catch (err) {
        out.push({ id, enviado: false, erro: err.message, naFila: true });
        if (semResposta(err)) {
          for (const resto of ids.slice(i + 1)) out.push({ id: resto, enviado: false, erro: err.message, naFila: true });
          break;
        }
      }
    }
    return out;
  });
}

// O site vendeu: o número daqui ficou velho. Relê da loja o estoque destas
// variações (o que a loja tem, mais o que daqui ainda não subiu). Contagem
// à mão que ainda não subiu continua valendo. Se a loja falhar, fica para
// a próxima leitura do catálogo.
const atualizar = db.prepare(`UPDATE variants SET
    stock   = MAX(0, @remoto + ns_delta),
    on_hand = CASE WHEN @proprio = 1 THEN MAX(0, @remoto + ns_delta) ELSE on_hand END,
    updated_at = @ts
  WHERE id = @id AND ns_fixar = 0`);
export function lerDaLoja(ids) {
  return naFila(async () => {
    let lidas = 0;
    for (const id of ids) {
      const v = ler.get(id);
      if (!v || !v.nuvemshop_product_id || !v.nuvemshop_variant_id || !v.stock_management || v.ns_fixar) continue;
      try {
        const naLoja = await nuvem.getVariant(v.nuvemshop_product_id, v.nuvemshop_variant_id);
        if (!naLoja || naLoja.stock == null) continue;
        atualizar.run({ id: v.id, remoto: parseInt(naLoja.stock, 10) || 0, proprio: v.on_demand ? 0 : 1, ts: new Date().toISOString() });
        lidas += 1;
      } catch (err) {
        // Fica para a próxima leitura; sem resposta da loja, nem tenta o resto.
        if (semResposta(err)) break;
      }
    }
    return lidas;
  });
}

// Sob encomenda: o número que o site vendeu volta para o site, até o alvo
// (variants.grade_alvo). Lê a loja na hora e só sobe — se alguém já pôs
// mais pelo painel, fica como está. Falhou? Tenta na próxima rodada.
// Só mexe no número que VENDEU: o que você tirou do site fica fora.
const marcadosParaRepor = db.prepare(`SELECT v.id FROM variants v JOIN products p ON p.id = v.product_id
  WHERE v.repor_site = 1 AND p.on_demand = 1 ORDER BY v.id LIMIT 60`);
const reposto = db.prepare(`UPDATE variants SET repor_site = 0, stock = @valor, updated_at = @ts WHERE id = @id`);
const largar = db.prepare('UPDATE variants SET repor_site = 0 WHERE id = ?');
export function reporGrade() {
  const ids = marcadosParaRepor.all().map((r) => r.id);
  if (!ids.length || !nuvem.isConfigured()) return Promise.resolve({ repostos: 0, falhas: 0 });
  return naFila(async () => {
    let repostos = 0, falhas = 0;
    for (const id of ids) {
      const v = ler.get(id);
      const alvo = v && v.grade_alvo != null ? v.grade_alvo : 0;
      if (!v || !v.on_demand || !v.stock_management || !v.nuvemshop_variant_id || alvo <= 0) { if (v) largar.run(id); continue; }
      try {
        const naLoja = await nuvem.getVariant(v.nuvemshop_product_id, v.nuvemshop_variant_id);
        const agora = naLoja && naLoja.stock != null ? (parseInt(naLoja.stock, 10) || 0) : null;
        if (agora == null) { largar.run(id); continue; }   // a loja não controla esse estoque
        if (agora < alvo) await nuvem.setVariantStock(v.nuvemshop_product_id, v.nuvemshop_variant_id, alvo);
        reposto.run({ id, valor: Math.max(agora, alvo), ts: new Date().toISOString() });
        repostos += agora < alvo ? 1 : 0;
      } catch (err) {
        if (err.status === 404) largar.run(id); else falhas += 1;   // 404: o número não existe mais na loja
        if (semResposta(err)) break;   // loja fora do ar: o resto vai na próxima volta
      }
    }
    return { repostos, falhas };
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
