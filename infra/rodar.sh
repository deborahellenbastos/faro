#!/usr/bin/env bash
# Robô Faro no servidor: roda direto, sem as pausas do GitHub.
# Uma rodada (busca e análise) a cada FARO_INTERVALO segundos e a vigia rápida das suas moedas rodando sem parar, em paralelo.
# Só trabalha quando infra/onde-roda.txt (no GitHub) diz "vps". Assim o GitHub e o servidor nunca operam juntos.
set -u
cd "$(dirname "$0")/.." || exit 1
BRANCH="${BRANCH:-main}"
INTERVALO="${FARO_INTERVALO:-120}"
CARENCIA="${FARO_CARENCIA:-420}"   # espera a última rodada do GitHub terminar antes de assumir (7 min)
MSG="Atualiza painel [skip ci]"
ESTADO="${FARO_ESTADO:-/var/lib/faro}"
LOG="${FARO_LOG:-/var/log/faro/robo.log}"
mkdir -p "$ESTADO"
git config user.name "robo-faro"; git config user.email "robo-faro@users.noreply.github.com"

alinhar() { git fetch -q origin "$BRANCH" && git reset -q --hard "origin/$BRANCH"; }

salvar() {
  rm -rf /tmp/faro-out && mkdir -p /tmp/faro-out
  cp docs/data.enc.json docs/data.json /tmp/faro-out/ 2>/dev/null || true
  git fetch -q origin "$BRANCH" || return 0
  git reset -q --hard "origin/$BRANCH"
  if [ -f /tmp/faro-out/data.enc.json ]; then cp /tmp/faro-out/data.enc.json docs/ && rm -f docs/data.json
  elif [ -f /tmp/faro-out/data.json ]; then cp /tmp/faro-out/data.json docs/; fi
  git add -A docs/data.json docs/data.enc.json 2>/dev/null || git add -A docs
  git diff --cached --quiet && return 0
  if [ "$(git log -1 --format=%s)" = "$MSG" ] && [ "$(git rev-list --count HEAD)" -gt 1 ]; then
    git commit -q --amend --no-edit --date=now
    git push -q --force-with-lease origin "HEAD:$BRANCH" || echo "Não gravou nesta rodada; tenta na próxima"
  else
    git commit -q -m "$MSG"
    git push -q origin "HEAD:$BRANCH" || echo "Não gravou nesta rodada; tenta na próxima"
  fi
}

# Manda as últimas linhas do log para o ramo servidor-log (para o Claude conseguir ler), com os segredos apagados
enviar_log() {
  [ -f "$LOG" ] || return 0
  tail -n 800 "$LOG" | node -e '
    let s = require("fs").readFileSync(0, "utf8");
    for (const k of ["SOLANA_PRIVATE_KEY","JUPITER_API_KEY","SOLANA_RPC_URL","FARO_SENHA"]) {
      const v = (process.env[k] || "").trim(); if (v.length >= 6) s = s.split(v).join("***");
    }
    s = s.replace(/(api[-_]?key=)[^&\s"]+/gi, "$1***");
    process.stdout.write(s);' > /tmp/faro-log.txt || return 0
  local blob tree commit
  blob=$(git hash-object -w /tmp/faro-log.txt) || return 0
  tree=$(printf '100644 blob %s\tlog.txt\n' "$blob" | git mktree) || return 0
  commit=$(echo "Log do servidor $(date -u +%FT%TZ)" | git commit-tree "$tree") || return 0
  git push -q -f origin "$commit:refs/heads/servidor-log" 2>/dev/null || true
}

ativo() {
  [ "$(tr -d '[:space:]' < infra/onde-roda.txt 2>/dev/null)" = "vps" ] && [ -f "$ESTADO/ativo-desde" ] \
    && [ $(( $(date +%s) - $(cat "$ESTADO/ativo-desde") )) -ge "$CARENCIA" ]
}
# Vigia sem pausa: roda o tempo todo, em paralelo com a rodada (no GitHub ela parava enquanto a rodada rodava).
# A cada 60 s ela recomeça e relê os dados que a rodada acabou de gravar.
vigia_continua() {
  while :; do
    if ativo; then timeout 90 node scanner/watch.mjs 60 || sleep 5; else sleep 10; fi
  done
}
vigia_continua &
VIGIA_PID=$!
trap 'kill $VIGIA_PID 2>/dev/null' EXIT

alinhar || echo "Sem acesso ao GitHub agora; tento de novo"
N=0
while :; do
  INICIO=$(date +%s)
  if [ "$(tr -d '[:space:]' < infra/onde-roda.txt 2>/dev/null)" != "vps" ]; then
    rm -f "$ESTADO/ativo-desde"
    echo "$(date '+%F %T') Aguardando: o robô ainda está no GitHub (infra/onde-roda.txt)"
    sleep 60; alinhar; continue
  fi
  [ -f "$ESTADO/ativo-desde" ] || { date +%s > "$ESTADO/ativo-desde"; echo "$(date '+%F %T') Assumindo o robô em $((CARENCIA / 60)) min (esperando o GitHub terminar a última rodada)"; }
  if [ $(( INICIO - $(cat "$ESTADO/ativo-desde") )) -lt "$CARENCIA" ]; then sleep 30; alinhar; continue; fi

  echo "$(date '+%F %T') ---- rodada ----"
  timeout 600 node scanner/index.mjs || echo "Rodada com erro; segue para a próxima"
  salvar
  N=$((N + 1)); [ $((N % 3)) -eq 1 ] && enviar_log
  # A vigia já está rodando em paralelo; aqui só espera a próxima rodada (nunca roda mais rápido que o intervalo)
  RESTO=$(( INTERVALO - ($(date +%s) - INICIO) )); [ "$RESTO" -gt 5 ] && sleep "$RESTO" || sleep 5
done
