#!/usr/bin/env bash
# Troca UM segredo do servidor sem redigitar os outros, e confere tudo no fim. Rode como root:
#   bash /opt/faro/repo/infra/trocar-segredo.sh FARO_SENHA
# Nomes: FARO_SENHA, SOLANA_PRIVATE_KEY, JUPITER_API_KEY, SOLANA_RPC_URL, FARO_WALLET
set -euo pipefail
ENVF=/etc/faro/faro.env
DIR=/opt/faro/repo
NOME="${1:-}"
case "$NOME" in
  FARO_SENHA|SOLANA_PRIVATE_KEY|JUPITER_API_KEY|SOLANA_RPC_URL|FARO_WALLET) ;;
  *) echo "Use: bash $0 FARO_SENHA   (ou SOLANA_PRIVATE_KEY, JUPITER_API_KEY, SOLANA_RPC_URL, FARO_WALLET)"; exit 1 ;;
esac
[ "$(id -u)" = 0 ] || { echo "Rode como root."; exit 1; }
[ -f "$ENVF" ] || { echo "Ainda não há segredos. Rode bash instalar.sh primeiro."; exit 1; }

echo "O que você digitar não aparece na tela. Cole uma vez só (botão direito) e aperte Enter."
read -r -s -p "$NOME: " v < /dev/tty; echo
v="${v//$'\e'\[[A-D]/}"; v="${v//$'\r'/}"
v="${v#"${v%%[![:space:]]*}"}"; v="${v%"${v##*[![:space:]]}"}"
case "$v" in *"'"*) linha="$NOME=$v" ;; *) linha="$NOME='$v'" ;; esac

tmp=$(mktemp)
grep -v "^$NOME=" "$ENVF" > "$tmp" || true
printf '%s\n' "$linha" >> "$tmp"
cat "$tmp" > "$ENVF"; rm -f "$tmp"; unset v linha
chown root:faro "$ENVF"; chmod 640 "$ENVF"
echo "$NOME trocado."

sudo -u faro git -C "$DIR" pull -q || true
echo
echo "Conferindo os segredos (nada aparece na tela):"
systemd-run --quiet --pipe --wait -p User=faro -p EnvironmentFile="$ENVF" -p WorkingDirectory="$DIR" /usr/bin/node infra/conferir.mjs || true
systemctl restart faro
