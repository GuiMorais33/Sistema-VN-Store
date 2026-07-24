#!/usr/bin/env bash
# ============================================================
#  VN Store — instalação na VM (Oracle Cloud / Ubuntu)
#  Rode UMA vez, dentro da VM, como usuário "ubuntu":
#    bash setup.sh
#  Ele instala Node, baixa o sistema, cria o serviço e sobe.
# ============================================================
set -e

REPO_URL="${REPO_URL:-https://github.com/GuiMorais33/Sistema-VN-Store.git}"
BRANCH="${BRANCH:-claude/vn-store-autonomous-agents-v8a2eo}"
APP_DIR="${APP_DIR:-$HOME/Sistema-VN-Store}"
PORT="${PORT:-3000}"

echo "==> Atualizando o sistema e instalando dependências base..."
sudo apt-get update -y
sudo apt-get install -y git build-essential python3 ca-certificates curl

echo "==> Instalando Node.js 22..."
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node -v

echo "==> Baixando o sistema..."
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch origin "$BRANCH"
  git -C "$APP_DIR" checkout "$BRANCH"
  git -C "$APP_DIR" pull origin "$BRANCH"
else
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi

echo "==> Instalando pacotes..."
cd "$APP_DIR"
npm install --omit=dev

echo "==> Preparando o .env (segredos)..."
if [ ! -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  # Gera uma senha e um segredo de sessão aleatórios de partida.
  RAND_PWD="$(openssl rand -base64 9 2>/dev/null || echo trocar123)"
  RAND_SEC="$(openssl rand -hex 24 2>/dev/null || echo trocar-segredo)"
  sed -i "s|^APP_PASSWORD=.*|APP_PASSWORD=$RAND_PWD|" "$APP_DIR/.env"
  sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=$RAND_SEC|" "$APP_DIR/.env"
  echo "    -> .env criado. SUA SENHA DE ACESSO INICIAL: $RAND_PWD"
  echo "       (edite depois com: nano $APP_DIR/.env)"
fi

echo "==> Liberando a porta $PORT no firewall do sistema..."
sudo iptables -I INPUT -p tcp --dport "$PORT" -j ACCEPT || true
sudo netfilter-persistent save 2>/dev/null || (sudo apt-get install -y iptables-persistent && sudo netfilter-persistent save) || true

echo "==> Criando o serviço (inicia sozinho e reinicia se cair)..."
sudo tee /etc/systemd/system/vnstore.service >/dev/null <<UNIT
[Unit]
Description=VN Store Sistema
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$APP_DIR
ExecStart=$(command -v node) --env-file-if-exists=.env server/index.js
Restart=always
RestartSec=3
Environment=PORT=$PORT

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable vnstore
sudo systemctl restart vnstore
sleep 2
sudo systemctl --no-pager status vnstore | head -n 8 || true

IP="$(curl -s ifconfig.me || echo SEU_IP_PUBLICO)"
echo ""
echo "======================================================"
echo "  ✅ Pronto! Acesse:  http://$IP:$PORT"
echo "  Se não abrir, falta liberar a porta $PORT na"
echo "  'Security List' do painel da Oracle (veja o guia)."
echo "======================================================"
