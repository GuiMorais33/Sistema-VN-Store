#!/usr/bin/env bash
# ============================================================
#  VN Store — HTTPS (cadeado) com Caddy
#  Coloca um endereço https:// na frente do sistema, com
#  certificado automático e grátis (Let's Encrypt).
#
#  Uso (dentro da VM):
#     bash https-setup.sh                 # usa <ip>.sslip.io (grátis, automático)
#     bash https-setup.sh meu.dominio.com # usa seu domínio (aponte o DNS antes)
#
#  ANTES de rodar: libere as portas 80 e 443 na Security List da Oracle.
# ============================================================
set -e
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a

IP="$(curl -s ifconfig.me)"
DOMAIN="${1:-${IP}.sslip.io}"

echo "==> Endereço que terá HTTPS: $DOMAIN"

echo "==> Instalando o Caddy..."
sudo -E apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
sudo -E apt-get update -y
sudo -E apt-get install -y caddy

echo "==> Configurando o Caddy (proxy para o sistema na porta 3000)..."
sudo tee /etc/caddy/Caddyfile >/dev/null <<CADDY
$DOMAIN {
    reverse_proxy localhost:3000
}
CADDY

echo "==> Liberando portas 80 e 443 no firewall do sistema..."
sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT || true
sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT || true
sudo netfilter-persistent save 2>/dev/null || true

echo "==> Reiniciando o Caddy..."
sudo systemctl enable caddy
sudo systemctl restart caddy
sleep 5

echo ""
echo "======================================================"
echo "  ✅ HTTPS no ar (pode levar ~30s pra emitir o certificado):"
echo "     https://$DOMAIN"
echo ""
echo "  Se der erro de certificado, confirme que as portas 80 e 443"
echo "  estão liberadas na Security List da Oracle e rode de novo:"
echo "     sudo systemctl restart caddy"
echo "======================================================"
