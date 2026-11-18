#!/usr/bin/env bash
# Instala o robô Faro num servidor Ubuntu 24.04 novo (DigitalOcean, Hetzner, Vultr...). Rode como root:
#   curl -fsSL https://raw.githubusercontent.com/deborahellenbastos/faro/main/infra/instalar.sh -o instalar.sh && bash instalar.sh
# Pode rodar de novo quando quiser: ele só completa o que faltar (e pergunta se quer trocar os segredos).
set -euo pipefail
REPO="deborahellenbastos/faro"
DIR=/opt/faro/repo
ENVF=/etc/faro/faro.env
TTY=/dev/tty
pergunta() { local v; read -r -p "$1" v < "$TTY"; echo "$v"; }
segredo() { local v; read -r -s -p "$1" v < "$TTY"; echo >&2; echo "$v"; }
passo() { echo; echo "==> $*"; }

[ "$(id -u)" = 0 ] || { echo "Rode como root (ssh root@IP)."; exit 1; }

passo "1/7 Atualizando o sistema e instalando o básico"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq git curl ca-certificates ufw fail2ban unattended-upgrades logrotate >/dev/null
dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null 2>&1 || true

# Servidor pequeno (1 GB): cria 2 GB de memória de reserva (swap) para o npm e o robô não travarem
if [ "$(awk '/MemTotal/ {print $2}' /proc/meminfo)" -lt 1900000 ] && ! swapon --show | grep -q .; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap -q /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "Swap de 2 GB criado."
fi

passo "2/7 Instalando o Node 22"
if ! node -v 2>/dev/null | grep -q '^v22'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
node -v

passo "3/7 Protegendo o servidor (firewall: só SSH; sem login por senha)"
ufw allow OpenSSH >/dev/null; ufw --force enable >/dev/null
if [ -s /root/.ssh/authorized_keys ]; then
  mkdir -p /etc/ssh/sshd_config.d
  printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin prohibit-password\n' > /etc/ssh/sshd_config.d/10-faro.conf
  systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
else
  echo "Aviso: sem chave SSH em /root/.ssh/authorized_keys; o login por senha continua ligado."
fi
systemctl enable --now fail2ban >/dev/null 2>&1 || true

passo "4/7 Criando o usuário do robô e a chave de acesso ao GitHub"
id faro >/dev/null 2>&1 || useradd -m -s /bin/bash faro
mkdir -p /opt/faro /var/lib/faro /var/log/faro /etc/faro
chown -R faro:faro /opt/faro /var/lib/faro /var/log/faro
if [ ! -f /home/faro/.ssh/id_ed25519 ]; then
  sudo -u faro ssh-keygen -q -t ed25519 -N '' -C "robo-faro-servidor" -f /home/faro/.ssh/id_ed25519
fi
sudo -u faro sh -c 'ssh-keyscan -t ed25519 github.com >> ~/.ssh/known_hosts 2>/dev/null; sort -u -o ~/.ssh/known_hosts ~/.ssh/known_hosts'
# O GitHub responde com código de saída 1 mesmo quando a chave funciona; com pipefail o teste
# em pipe nunca passava. Por isso guarda a resposta numa variável e só depois procura a frase.
github_ok() { local r; r=$(sudo -u faro ssh -o BatchMode=yes -o ConnectTimeout=15 -T git@github.com 2>&1 || true); [[ "$r" == *"successfully authenticated"* ]]; }
until github_ok; do
  echo
  echo "Adicione esta chave no GitHub (é pública, pode copiar à vontade):"
  echo "  github.com/$REPO -> Settings -> Deploy keys -> Add deploy key"
  echo "  Title: servidor   -   marque \"Allow write access\""
  echo
  cat /home/faro/.ssh/id_ed25519.pub
  echo
  pergunta "Depois de salvar no GitHub, aperte Enter para testar... " >/dev/null
done
echo "Acesso ao GitHub ok."

passo "5/7 Baixando o Faro"
if [ ! -d "$DIR/.git" ]; then
  sudo -u faro git clone -q "git@github.com:$REPO.git" "$DIR"
else
  sudo -u faro git -C "$DIR" fetch -q origin main && sudo -u faro git -C "$DIR" reset -q --hard origin/main
fi
sudo -u faro sh -c "cd $DIR && npm install --no-save --no-audit --no-fund @solana/web3.js@1 bs58@6 >/dev/null"

passo "6/7 Segredos (só você digita; ficam só neste servidor, legíveis apenas pelo robô)"
trocar=s
if [ -f "$ENVF" ]; then trocar=$(pergunta "Os segredos já existem. Quer digitar de novo? (s/N) "); fi
if [ "${trocar,,}" = s ]; then
  echo "O que você digitar nos campos secretos não aparece na tela. Para colar: botão direito do mouse."
  SENHA=$(segredo "FARO_SENHA (a senha do painel): ")
  WALLET=$(pergunta "FARO_WALLET (endereço público da carteira): ")
  PK=$(segredo "SOLANA_PRIVATE_KEY (chave privada da carteira do robô; Enter para deixar sem compra/venda): ")
  JUP=$(segredo "JUPITER_API_KEY (Enter se não tiver): ")
  RPC=$(segredo "SOLANA_RPC_URL (Enter para usar o público): ")
  sn() { local r; r=$(pergunta "$1 (S/n) "); [ "${r,,}" = n ] && echo false || echo true; }
  echo "Mesmas chaves das Variables do GitHub (Settings -> Secrets and variables -> Actions -> Variables):"
  AB=$(sn "AUTO_BUY: compra automática ligada?")
  AS=$(sn "AUTO_SELL: venda automática ligada?")
  LA=$(sn "LUCRO_AUTO: realização de lucro automática?")
  VG=$(sn "VIGIA: vigia rápida ligada?")
  umask 077
  cat > "$ENVF" <<ENV
FARO_SENHA=$SENHA
FARO_WALLET=$WALLET
SOLANA_PRIVATE_KEY=$PK
JUPITER_API_KEY=$JUP
SOLANA_RPC_URL=$RPC
AUTO_BUY=$AB
AUTO_SELL=$AS
LUCRO_AUTO=$LA
VIGIA=$VG
BRANCH=main
FARO_INTERVALO=120
ENV
  unset SENHA PK JUP RPC
fi
chown root:faro "$ENVF"; chmod 640 "$ENVF"; chmod 750 /etc/faro; chown root:faro /etc/faro

passo "7/7 Ligando o robô (sobe sozinho se o servidor reiniciar)"
cat > /etc/systemd/system/faro.service <<UNIT
[Unit]
Description=Robo Faro
After=network-online.target
Wants=network-online.target

[Service]
User=faro
WorkingDirectory=$DIR
EnvironmentFile=$ENVF
ExecStart=/bin/bash $DIR/infra/rodar.sh
Restart=always
RestartSec=10
StandardOutput=append:/var/log/faro/robo.log
StandardError=append:/var/log/faro/robo.log
NoNewPrivileges=true
ProtectSystem=full
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/logrotate.d/faro <<'ROT'
/var/log/faro/robo.log {
  daily
  rotate 7
  compress
  missingok
  notifempty
  copytruncate
}
ROT
systemctl daemon-reload
systemctl enable faro >/dev/null 2>&1
systemctl restart faro
sleep 3
systemctl is-active --quiet faro && echo "Robô ligado." || { echo "O robô não subiu. Veja: tail -n 50 /var/log/faro/robo.log"; exit 1; }
echo
echo "Pronto! Por enquanto ele fica esperando: o robô só troca de lugar quando o Claude mudar infra/onde-roda.txt para vps."
echo "Ver o que ele está fazendo: tail -f /var/log/faro/robo.log   (Ctrl+C para sair)"
