// ============================================================
//  Fuso horário da loja. Tem que ser o PRIMEIRO import do servidor.
//
//  Servidor na nuvem costuma rodar em UTC. Sem isto, das 21h à
//  meia-noite de Brasília o sistema já achava que era o dia seguinte:
//  a venda das 15h aparecia como "ontem", o fechamento de caixa e os
//  lembretes "de hoje" olhavam para o dia errado, e a meta do último
//  dia do mês contava no mês seguinte.
//
//  Regra: datas e horas guardadas continuam em ISO (UTC) — são
//  absolutas. O que muda é a pergunta "que dia é hoje?": essa é sempre
//  respondida no horário da loja.
// ============================================================
if (!process.env.TZ) process.env.TZ = 'America/Sao_Paulo';

const pad = (n) => String(n).padStart(2, '0');

// AAAA-MM-DD no horário da loja.
export const diaLocal = (d = new Date()) => {
  const x = d instanceof Date ? d : new Date(d);
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
};

// AAAA-MM no horário da loja.
export const mesLocal = (d = new Date()) => diaLocal(d).slice(0, 7);

// Meia-noite (horário da loja) de um dia AAAA-MM-DD, em ISO — é o que se
// compara com created_at.
export const inicioDoDia = (dia) => {
  const [a, m, d] = String(dia).split('-').map(Number);
  return new Date(a, m - 1, d).toISOString();
};

// Meia-noite do dia 1º de um mês AAAA-MM, em ISO.
export const inicioDoMes = (ym) => {
  const [a, m] = String(ym).split('-').map(Number);
  return new Date(a, m - 1, 1).toISOString();
};
