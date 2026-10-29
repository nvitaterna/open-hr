#!/usr/bin/env bash
# Checks an installed open-hr package (decision 0009): both services run,
# web serves the setup page over HTTPS as the ohr user, the CLI reaches core,
# and the files have the owners and modes the units expect. Run as root on a
# disposable machine right after installing the .deb.
set -euo pipefail

URL=https://127.0.0.1:7700
FAILED=0

# GitHub Actions shows these as annotations on the pull request.
annotate() {
  local level=$1 title=$2 text=$3
  if [ -n "${GITHUB_ACTIONS:-}" ]; then
    text=${text//'%'/'%25'}
    text=${text//$'\n'/'%0A'}
    echo "::$level title=$title::$text"
  fi
}

check() {
  local what=$1
  shift
  if "$@" >/dev/null 2>&1; then
    echo "PASS  $what"
  else
    echo "FAIL  $what"
    annotate error "Smoke test" "FAIL  $what"
    FAILED=1
  fi
}

# What the services said, so a failure can be understood without the full log.
diagnose() {
  local unit
  for unit in ohr-core ohr-web; do
    local report
    report=$(
      systemctl status --no-pager --lines=0 "$unit.service" 2>&1 | head -n 5
      journalctl --no-pager --unit="$unit.service" --lines=15 --output=cat 2>&1
    )
    echo "--- $unit"
    echo "$report"
    annotate warning "$unit" "$report"
  done
}

owner_mode() {
  [ "$(stat -c '%U:%G %a' "$1")" = "$2" ]
}

for _ in $(seq 30); do
  curl -fsk "$URL/api/v1/setup" >/dev/null 2>&1 && break
  sleep 1
done

check "ohr-core is active" systemctl is-active --quiet ohr-core.service
check "ohr-web is active" systemctl is-active --quiet ohr-web.service
check "ohr-core and ohr-web start at boot" systemctl is-enabled --quiet ohr-core.service ohr-web.service
check "ohr-web runs as ohr" sh -c '[ "$(ps -o user= -p "$(systemctl show -p MainPID --value ohr-web.service)")" = ohr ]'
check "ohr-core runs as root" sh -c '[ "$(ps -o user= -p "$(systemctl show -p MainPID --value ohr-core.service)")" = root ]'
check "setup page answers over HTTPS" sh -c "curl -fsk $URL/api/v1/setup | grep -q '\"required\":true'"
check "the UI is served" sh -c "curl -fsk $URL/drives | grep -q '<div id=\"root\">'"
check "responses carry the CSP" sh -c "curl -fsk -D - -o /dev/null $URL/ | grep -qi \"content-security-policy: default-src 'self'\""
check "plain HTTP is refused" sh -c "! curl -fs http://127.0.0.1:7700/ >/dev/null"
check "the CLI reaches core" ohr status
check "ohr version runs" ohr version
check "/run/ohr is root:ohr 750" owner_mode /run/ohr "root:ohr 750"
check "the socket is root:ohr 660" owner_mode /run/ohr/core.sock "root:ohr 660"
check "the web data is ohr:ohr 750" owner_mode /var/lib/ohr/web "ohr:ohr 750"
check "the setup token is ohr:ohr 600" owner_mode /var/lib/ohr/web/setup-token "ohr:ohr 600"
check "the TLS key is root:ohr 640" owner_mode /etc/ohr/tls/key.pem "root:ohr 640"
check "the certificate names this host" sh -c "openssl x509 -in /etc/ohr/tls/cert.pem -noout -ext subjectAltName | grep -q 'DNS:$(hostname)'"

if [ "$FAILED" -ne 0 ]; then
  diagnose
fi
exit "$FAILED"
