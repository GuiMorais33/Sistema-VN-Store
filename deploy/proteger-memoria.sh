#!/usr/bin/env bash
# ============================================================
#  Protege a máquina pequena da Oracle (1 GB de memória) de travar.
#
#  Sem isto, quando a memória acabava a máquina inteira travava (nem o
#  ssh respondia) e só voltava reiniciando pelo painel da Oracle. Com isto:
#   1. swap de 2 GB: uma reserva no disco para a memória não acabar de vez;
#   2. limite para o sistema da loja: se ele passar do limite, só ele é
#      reiniciado (em 3 segundos, sozinho) — a máquina continua de pé;
#   3. o diário do Linux fica guardado entre um ligar e outro, e o sistema
#      da loja pode lê-lo (tela /api/sistema): se travar de novo, dá para
#      ver o porquê.
#  Pode rodar quantas vezes quiser: o que já está feito, ele pula.
#  Uso: bash ~/Sistema-VN-Store/deploy/proteger-memoria.sh
# ============================================================
set -euo pipefail

echo "› Memória antes:"; free -m

# 1) Swap de 2 GB (só se a máquina ainda não tiver nenhum).
if [ -z "$(swapon --show --noheadings)" ]; then
  echo "› Criando swap de 2 GB…"
  sudo fallocate -l 2G /swapfile || sudo dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null
  sudo swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
else
  echo "› Swap já existe:"; swapon --show
fi
# Usa o swap só quando precisa (o padrão do Linux, 60, troca cedo demais).
echo 'vm.swappiness=20' | sudo tee /etc/sysctl.d/99-vnstore.conf >/dev/null
sudo sysctl -q -p /etc/sysctl.d/99-vnstore.conf

# 2) Limite de memória do sistema da loja (arquivo à parte: o serviço
#    original, de setup.sh, continua igual).
sudo mkdir -p /etc/systemd/system/vnstore.service.d
sudo tee /etc/systemd/system/vnstore.service.d/memoria.conf >/dev/null <<'EOF'
[Service]
# O Node não passa de 384 MB de dados; a partir de 500 MB o Linux aperta,
# e com 700 MB o sistema é reiniciado (Restart=always) — nunca a máquina.
Environment=NODE_OPTIONS=--max-old-space-size=384
MemoryHigh=500M
MemoryMax=700M
EOF

# 3) Diário do Linux guardado entre um ligar e outro, e legível pelo
#    usuário que roda o sistema da loja.
sudo mkdir -p /var/log/journal
sudo systemd-tmpfiles --create --prefix /var/log/journal >/dev/null 2>&1 || true
sudo systemctl restart systemd-journald
sudo usermod -aG systemd-journal "$USER" || true

sudo systemctl daemon-reload
sudo systemctl restart vnstore
sleep 3
echo "› Sistema da loja:"; sudo systemctl --no-pager status vnstore 2>&1 | head -n 3 || true

echo "› Memória depois:"; free -m
echo "› Antes do último travamento, o Linux registrou (vazio = nada guardado):"
sudo journalctl -b -1 -k --no-pager -q 2>/dev/null | grep -iE 'out of memory|oom-kill|killed process|blocked for more than' | tail -n 10 || true
echo "PROTEGIDO"
