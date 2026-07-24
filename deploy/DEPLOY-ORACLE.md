# Colocar a VN Store no ar — Oracle Cloud (grátis)

Guia passo a passo pra hospedar o sistema numa máquina **grátis pra sempre** da Oracle,
ligada 24/7, que guarda seus dados (vendas, financeiro, clientes, fotos).

> Você faz os passos 1–3 (criar conta e máquina). O passo 4 é **um comando só**.
> Qualquer dúvida, me chama que eu te acompanho na tela.

---

## 1) Criar a conta Oracle Cloud (grátis)
1. Acesse **oracle.com/br/cloud/free** e clique em *Comece gratuitamente*.
2. Cadastre e-mail, país (Brasil) e um **cartão** (é só pra validar identidade — **não cobra** no Always Free).
3. Escolha uma região próxima (ex.: *Brazil East (São Paulo)* ou *Vinhedo*).

## 2) Criar a máquina (VM) "Always Free"
1. No painel, menu **☰ → Compute → Instances → Create instance**.
2. **Image & shape**: escolha **Ubuntu** (22.04 ou 24.04) e a forma
   **VM.Standard.E2.1.Micro** (marcada como *Always Free-eligible*).
3. **SSH keys**: marque *Generate a key pair for me* e **baixe a chave privada**
   (guarde bem — é ela que te dá acesso).
4. Clique **Create**. Em ~1 min a VM sobe. Anote o **Public IP address**.

## 3) Liberar a porta no firewall da Oracle
1. Na página da VM, em *Primary VNIC*, clique na **Subnet** → na **Security List**.
2. **Add Ingress Rule**:
   - Source CIDR: `0.0.0.0/0`
   - IP Protocol: **TCP**
   - Destination Port Range: **3000**
   - Salve.

## 4) Instalar o sistema (um comando)
Conecte na VM por SSH (do seu computador):
```bash
ssh -i CAMINHO_DA_SUA_CHAVE.key ubuntu@SEU_IP_PUBLICO
```
Já dentro da VM, rode:
```bash
curl -fsSL https://raw.githubusercontent.com/GuiMorais33/Sistema-VN-Store/claude/vn-store-autonomous-agents-v8a2eo/deploy/setup.sh -o setup.sh && bash setup.sh
```
> Se o repositório for **privado**, o `curl`/clone pede autenticação. Duas saídas:
> deixar o repositório público (o código não tem segredos — o `.env` nunca sobe),
> ou usar um token do GitHub. Me avise qual prefere que eu te oriento.

Ao terminar, o script mostra:
- **sua senha de acesso inicial** (troque depois em `nano ~/Sistema-VN-Store/.env`);
- o endereço: **http://SEU_IP:3000**.

Abra esse endereço no navegador ou no celular, entre com a senha — e a VN Store está no ar. 🐊

---

## Depois (quando estiver rodando)
- **Domínio + cadeado (HTTPS)**: pra conectar a Nuvemshop com segurança e ter um endereço
  bonito (ex.: `sistema.vnstoreonline.com.br`), a gente coloca o **Caddy** na frente
  (HTTPS automático e grátis). Eu preparo quando chegarmos aqui.
- **Conectar a Nuvemshop**: com o HTTPS pronto, criamos o app no Portal de Parceiros,
  colocamos o token no `.env` do servidor e publicamos 1 produto de teste.

## Comandos úteis (dentro da VM)
```bash
sudo systemctl status vnstore     # ver se está rodando
sudo systemctl restart vnstore    # reiniciar
journalctl -u vnstore -f          # ver o log ao vivo
nano ~/Sistema-VN-Store/.env      # editar senha/segredos (reinicie depois)
```
