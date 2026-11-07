#!/bin/sh
# Rotate the DSH web launch token: write a new random value to ~/.dsh/web-token and restart both web profiles so the
# new token takes effect. Run after `apply-web-token-patch.mjs` has patched dsh once.
#
# The old token stops working the moment the profiles restart; any browser already signed in keeps its cookie until it
# expires, so rotating the token alone does not sign existing browsers out.
set -e
TOKEN_FILE="${DSH_WEB_TOKEN_FILE:-$HOME/.dsh/web-token}"
mkdir -p "$(dirname "$TOKEN_FILE")"

# A URL-safe random token, 32 bytes base64url, matching what the patched dsh writes on first run.
TOKEN=$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,""))')
printf '%s\n' "$TOKEN" > "$TOKEN_FILE"
chmod 600 "$TOKEN_FILE"
echo "new token: $TOKEN"

# Restart whatever is running, without failing when a profile is not loaded.
UID_NUM=$(id -u)
for label in ai.deepseek.web ai.deepseek.superagent; do
  launchctl kickstart -k "gui/$UID_NUM/$label" 2>/dev/null && echo "restarted $label" || true
done
# The superagent profile is started through its script (it runs under tmux), so restart it there too.
if [ -x "$HOME/code/dsh-superagent-prototype/scripts/dsh-superagent" ]; then
  "$HOME/code/dsh-superagent-prototype/scripts/dsh-superagent" restart >/dev/null 2>&1 && echo "restarted superagent profile" || true
fi

echo ""
echo "Open (pass Cloudflare Access first):"
echo "  https://dsh.kkrunning.win/?token=$TOKEN"
echo "  https://agent.kkrunning.win/?token=$TOKEN"
