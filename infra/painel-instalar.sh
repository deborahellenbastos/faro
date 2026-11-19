#!/usr/bin/env bash
# Liga o servidor do painel (infra/painel.mjs) como serviço "faro-painel". Rode como root:
#   cd /opt/faro/repo && sudo -u faro git pull -q && bash infra/painel-instalar.sh
# Ele escuta só em 127.0.0.1:8080. O firewall continua fechado: quem leva o painel para a internet
# é o túnel do Cloudflare (cloudflared), instalado com o comando que o próprio Cloudflare mostra.
# Não mexe no robô: o serviço "faro" continua igual.
set -euo pipefail
DIR=/opt/faro/repo
[ "$(id -u)" = 0 ] || { echo "Rode como root."; exit 1; }
[ -f "$DIR/infra/painel.mjs" ] || { echo "Não achei $DIR/infra/painel.mjs. Rode antes: cd $DIR && sudo -u faro git pull"; exit 1; }

cat > /etc/systemd/system/faro-painel.service <<UNIT
[Unit]
Description=Painel do Faro (só local, para o túnel do Cloudflare)
After=network-online.target
Wants=network-online.target

[Service]
User=faro
WorkingDirectory=$DIR
ExecStart=/usr/bin/node $DIR/infra/painel.mjs
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=full
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable faro-painel >/dev/null 2>&1
systemctl restart faro-painel
sleep 2

echo
if systemctl is-active --quiet faro-painel && curl -fsS -o /dev/null http://127.0.0.1:8080/ && curl -fsS -o /dev/null http://127.0.0.1:8080/data.enc.json; then
  echo "OK    Painel ligado em http://127.0.0.1:8080 (só dentro do servidor)"
  echo "OK    Dados do robô sendo entregues"
  echo
  echo "Pronto para o túnel do Cloudflare. O robô (serviço faro) não foi alterado."
else
  echo "ERRO  O painel não respondeu. Veja: journalctl -u faro-painel -n 30"
  exit 1
fi
