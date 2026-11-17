// ============================================================
//  Saúde da máquina.
//
//  A loja roda numa máquina gratuita da Oracle com 1 GB de memória. Quando
//  a memória acaba, ela não derruba só o sistema: trava inteira, e só volta
//  reiniciando pelo painel da Oracle (em novembro isso acontecia quase todo
//  dia). Aqui fica o que dá para ver de longe, sem entrar no servidor:
//   - agora: memória disponível, swap, disco, há quanto tempo está ligada;
//   - a cada 5 min, uma amostra guardada no banco (3 dias), para ver o que
//     veio antes de um travamento — memória subindo aos poucos é vazamento,
//     de repente é alguma tarefa pesada;
//   - quando a máquina ligou nas últimas vezes (o fim de cada uma é a hora
//     em que travou) e o que o Linux registrou de falta de memória antes do
//     último travamento.
// ============================================================
import fs from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';
import db from './db.js';

db.exec(`CREATE TABLE IF NOT EXISTS saude (
  quando TEXT NOT NULL, rss INTEGER, heap INTEGER, mem_disp INTEGER, mem_total INTEGER,
  swap_livre INTEGER, swap_total INTEGER, carga REAL)`);

const MB = (b) => Math.round((Number(b) || 0) / 1048576);

// /proc/meminfo diz o que o Linux tem DISPONÍVEL (livre + cache que ele
// pode soltar) e o swap. Fora do Linux (nos testes), o que o Node sabe.
function memoria() {
  const m = {};
  try {
    for (const l of fs.readFileSync('/proc/meminfo', 'utf8').split('\n')) {
      const [k, v] = l.split(':');
      if (v) m[k.trim()] = parseInt(v, 10) * 1024;
    }
  } catch (_) { /* fora do Linux */ }
  return {
    total: m.MemTotal || os.totalmem(),
    disponivel: m.MemAvailable ?? os.freemem(),
    swap_total: m.SwapTotal ?? 0,
    swap_livre: m.SwapFree ?? 0,
  };
}

const insere = db.prepare(`INSERT INTO saude (quando, rss, heap, mem_disp, mem_total, swap_livre, swap_total, carga)
  VALUES (?,?,?,?,?,?,?,?)`);
const poda = db.prepare('DELETE FROM saude WHERE quando < ?');
export function anotar() {
  const m = memoria(), p = process.memoryUsage();
  insere.run(new Date().toISOString(), MB(p.rss), MB(p.heapUsed), MB(m.disponivel), MB(m.total),
    MB(m.swap_livre), MB(m.swap_total), Math.round(os.loadavg()[0] * 100) / 100);
  poda.run(new Date(Date.now() - 3 * 864e5).toISOString());
}

// O diário do Linux (journalctl). O usuário do sistema lê o diário na
// máquina da Oracle; onde não existe (testes), volta vazio.
const diario = (args) => new Promise((ok) => {
  execFile('journalctl', ['--no-pager', '-q', ...args], { timeout: 8000, maxBuffer: 8 << 20 },
    (err, out) => ok(err ? null : String(out)));
});
const linhas = (t) => (t || '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => l.slice(0, 300));
const FALTA_DE_MEMORIA = /out of memory|oom[-_ ]?kill|killed process|invoked oom-killer|blocked for more than|soft lockup|hung_task|page allocation failure/i;

export async function situacao({ horas = 24 } = {}) {
  const m = memoria(), p = process.memoryUsage();
  let disco = null;
  try {
    const s = fs.statfsSync('/');
    disco = { total_mb: MB(s.blocks * s.bsize), livre_mb: MB(s.bavail * s.bsize) };
  } catch (_) { /* sem statfs */ }
  const [boots, kernel, sistema, app] = await Promise.all([
    diario(['--list-boots']),
    diario(['-b', '-1', '-k', '-o', 'short-iso', '-n', '5000']),
    diario(['-b', '-1', '-o', 'short-iso', '-n', '60']),
    diario(['-b', '-1', '-u', 'vnstore', '-o', 'short-iso', '-n', '25']),
  ]);
  return {
    agora: {
      quando: new Date().toISOString(),
      maquina_ligada_ha_h: Math.round(os.uptime() / 360) / 10,
      sistema_ligado_ha_h: Math.round(process.uptime() / 360) / 10,
      memoria_mb: { total: MB(m.total), disponivel: MB(m.disponivel) },
      swap_mb: { total: MB(m.swap_total), livre: MB(m.swap_livre) },
      sistema_mb: { rss: MB(p.rss), heap: MB(p.heapUsed) },
      carga: os.loadavg().map((x) => Math.round(x * 100) / 100),
      disco,
    },
    // Cada linha: uma vez que a máquina ligou, do primeiro ao último registro.
    ligou: boots == null ? null : linhas(boots).slice(-10),
    antes_do_ultimo_desligamento: kernel == null && sistema == null ? null : {
      falta_de_memoria: linhas(kernel).filter((l) => FALTA_DE_MEMORIA.test(l)).slice(-30),
      // As últimas linhas do diário antes de parar (sem as de acesso por
      // ssh, que têm endereço de quem entrou).
      ultimas: linhas(sistema).filter((l) => !/sshd/.test(l)).slice(-40),
      sistema_da_loja: linhas(app),
    },
    amostras: db.prepare(`SELECT quando, rss, heap, mem_disp, swap_livre, swap_total, carga FROM saude
      WHERE quando >= ? ORDER BY quando`).all(new Date(Date.now() - Math.min(72, Math.max(1, horas)) * 3600e3).toISOString()),
  };
}
