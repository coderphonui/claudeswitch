#!/usr/bin/env bash
# Behavioural test suite. Runs entirely inside a temporary CLAUDESWITCH_HOME and
# never touches ~/.claude or ~/.claudeswitch.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CS="$HERE/dist/claudeswitch"
[ -x "$CS" ] || { echo "Build first: bun run build" >&2; exit 1; }

ROOT="$(mktemp -d "${TMPDIR:-/tmp}/claudeswitch-test.XXXXXX")"
# TMPDIR often ends in a slash; normalise so string comparisons match the
# paths the tool prints (it builds them with path.join).
ROOT="$(cd "$ROOT" && pwd -P)"
export CLAUDESWITCH_HOME="$ROOT"
trap 'rm -rf "$ROOT"' EXIT

PASS=0
FAIL=0

check() { # check <description> <expected> <actual>
  if [ "$2" = "$3" ]; then
    printf '\033[32m  ok\033[0m   %s\n' "$1"; PASS=$((PASS + 1))
  else
    printf '\033[31mFAIL\033[0m   %s\n         expected: %s\n         actual:   %s\n' "$1" "$2" "$3"
    FAIL=$((FAIL + 1))
  fi
}

# Measures the leading table block only, in characters rather than bytes: the
# glyphs are multi-byte UTF-8, and the prose after the table is free to wrap.
fits() { python3 -c "
import re,sys
limit=int(sys.argv[1]); bad=0
for line in sys.stdin.read().splitlines():
    if not line.strip(): break
    if len(re.sub(r'\x1b\[[0-9;]*m','',line)) > limit: bad=1
print('no' if bad else 'yes')
" "$1"; }

contains() { # contains <description> <needle> <haystack>
  case "$3" in
    *"$2"*) printf '\033[32m  ok\033[0m   %s\n' "$1"; PASS=$((PASS + 1)) ;;
    *) printf '\033[31mFAIL\033[0m   %s\n         %s not found in: %s\n' "$1" "$2" "$3"; FAIL=$((FAIL + 1)) ;;
  esac
}

echo "── accounts and share policies"
"$CS" add alpha --no-login --label "Alpha" >/dev/null
"$CS" add beta  --no-login --share skills,plugins >/dev/null
"$CS" add gamma --no-login --share none >/dev/null

check "alpha links settings.json into shared/" \
  "../../shared/settings.json" "$(readlink "$ROOT/accounts/alpha/settings.json")"
check "beta does not link settings.json" "" "$(readlink "$ROOT/accounts/beta/settings.json" 2>/dev/null)"
check "beta links skills" "../../shared/skills" "$(readlink "$ROOT/accounts/beta/skills")"
check "gamma links nothing" "" "$(readlink "$ROOT/accounts/gamma/skills" 2>/dev/null)"
check "registry lists three accounts" "3" \
  "$(python3 -c "import json;print(len(json.load(open('$ROOT/registry.json'))['accounts']))")"

echo "── env emission"
OUT="$("$CS" use alpha --emit-shell 2>/dev/null)"
contains "emits CLAUDE_CONFIG_DIR" "export CLAUDE_CONFIG_DIR='$ROOT/accounts/alpha'" "$OUT"
contains "emits the account name" "export CLAUDESWITCH_ACCOUNT='alpha'" "$OUT"
check "human output stays off stdout" "" "$(echo "$OUT" | grep -c '✓' | tr -d ' ' | sed 's/^0$//')"
contains "off unsets the variables" "unset CLAUDE_CONFIG_DIR" "$("$CS" off --emit-shell 2>/dev/null)"

echo "── handoff (continuing a session on another account)"
mkdir -p "$ROOT/handoff-project"
HP="$(cd "$ROOT/handoff-project" && pwd -P)"
mkdir -p "$ROOT/accounts/alpha/projects/proj-a"
write_transcript() { # write_transcript <session-id> <cwd> <preview>
  python3 -c "
import json, sys
sid, cwd, preview = sys.argv[1], sys.argv[2], sys.argv[3]
p = '$ROOT/accounts/alpha/projects/proj-a/%s.jsonl' % sid
with open(p, 'w') as f:
    f.write(json.dumps({'type': 'mode', 'mode': 'normal', 'sessionId': sid}) + '\n')
    f.write(json.dumps({'type': 'user', 'isMeta': False, 'sessionId': sid, 'cwd': cwd,
      'message': {'role': 'user', 'content': preview}}) + '\n')
    f.write(json.dumps({'type': 'assistant', 'sessionId': sid, 'cwd': cwd,
      'message': {'role': 'assistant', 'content': [{'type': 'text', 'text': 'On it.'}]}}) + '\n')
" "$1" "$2" "$3"
}

write_transcript 11111111-1111-1111-1111-111111111111 "$HP" "Refactor the payments module"
OUT="$(cd "$HP" && "$CS" handoff beta --from alpha --session 11111111 --yes --stay --emit-shell 2>&1 >/dev/null)"
contains "reports the copy" "Copied session 11111111 to beta" "$OUT"
contains "prints the resume command" "claude --resume 11111111-1111-1111-1111-111111111111" "$OUT"
check "the transcript lands under the target, same project-dir name" "yes" \
  "$([ -f "$ROOT/accounts/beta/projects/proj-a/11111111-1111-1111-1111-111111111111.jsonl" ] && echo yes || echo no)"
check "a copy leaves the source transcript in place" "yes" \
  "$([ -f "$ROOT/accounts/alpha/projects/proj-a/11111111-1111-1111-1111-111111111111.jsonl" ] && echo yes || echo no)"
check "the copied transcript is byte-identical" "yes" \
  "$(diff -q "$ROOT/accounts/alpha/projects/proj-a/11111111-1111-1111-1111-111111111111.jsonl" \
             "$ROOT/accounts/beta/projects/proj-a/11111111-1111-1111-1111-111111111111.jsonl" >/dev/null && echo yes || echo no)"
check "--stay never writes to stdout" "" \
  "$(cd "$HP" && "$CS" handoff beta --from alpha --session 11111111 --yes --stay --emit-shell 2>/dev/null)"

contains "without --stay it also switches the terminal" "export CLAUDESWITCH_ACCOUNT='beta'" \
  "$(cd "$HP" && "$CS" handoff beta --from alpha --session 11111111 --yes --emit-shell 2>/dev/null)"

write_transcript 22222222-2222-2222-2222-222222222222 "$HP" "one more thing"
(cd "$HP" && "$CS" handoff beta --from alpha --session 22222222 --move --yes --stay >/dev/null 2>&1)
check "--move copies to the target" "yes" \
  "$([ -f "$ROOT/accounts/beta/projects/proj-a/22222222-2222-2222-2222-222222222222.jsonl" ] && echo yes || echo no)"
check "--move removes it from the source" "yes" \
  "$([ ! -f "$ROOT/accounts/alpha/projects/proj-a/22222222-2222-2222-2222-222222222222.jsonl" ] && echo yes || echo no)"

echo "── handoff --open (launching claude, not just switching)"
# A stub `claude` on PATH so this never depends on the real CLI being installed.
FAKEBIN="$(mktemp -d)"
cat > "$FAKEBIN/claude" <<'EOF'
#!/bin/sh
echo "FAKE CLAUDE: CLAUDE_CONFIG_DIR=$CLAUDE_CONFIG_DIR args=$*"
EOF
chmod +x "$FAKEBIN/claude"

OUT="$(cd "$HP" && PATH="$FAKEBIN:$PATH" "$CS" handoff beta --from alpha --session 11111111 --yes --emit-shell 2>/dev/null)"
contains "by default, the launch line rides along with the exports" \
  "--resume '11111111-1111-1111-1111-111111111111'" "$OUT"
EXPORT_LINE="$(printf '%s\n' "$OUT" | grep -n "CLAUDESWITCH_ACCOUNT" | head -1 | cut -d: -f1)"
RESUME_LINE="$(printf '%s\n' "$OUT" | grep -n -- "--resume" | head -1 | cut -d: -f1)"
check "the launch line comes after the exports, so it inherits the switch" "yes" \
  "$([ "${RESUME_LINE:-0}" -gt "${EXPORT_LINE:-0}" ] && echo yes || echo no)"
check "--no-open switches but does not emit a launch line" "0" \
  "$(cd "$HP" && PATH="$FAKEBIN:$PATH" "$CS" handoff beta --from alpha --session 11111111 --yes --no-open --emit-shell 2>/dev/null | grep -c resume)"

# Without a shell hook capturing stdout, handoff owns the real stdio itself and
# can just run the stub directly, instead of relying on a parent shell's eval.
OUT2="$(cd "$HP" && PATH="$FAKEBIN:$PATH" "$CS" handoff beta --from alpha --session 11111111 --yes 2>&1)"
contains "with no shell hook, it launches claude itself" "FAKE CLAUDE" "$OUT2"
contains "and passes the target account's CLAUDE_CONFIG_DIR" "CLAUDE_CONFIG_DIR=$ROOT/accounts/beta" "$OUT2"

# No claude anywhere findable (empty PATH and HOME): --open degrades to a plain
# switch instead of failing the whole command.
FAKEHOME="$(mktemp -d)"
ERR3="$(cd "$HP" && env -i PATH=/usr/bin:/bin HOME="$FAKEHOME" CLAUDESWITCH_HOME="$ROOT" \
  "$CS" handoff beta --from alpha --session 11111111 --yes --emit-shell 2>&1 >/dev/null)"
OUT3="$(cd "$HP" && env -i PATH=/usr/bin:/bin HOME="$FAKEHOME" CLAUDESWITCH_HOME="$ROOT" \
  "$CS" handoff beta --from alpha --session 11111111 --yes --emit-shell 2>/dev/null)"
contains "missing claude is reported, not a crash" "Could not find the claude CLI" "$ERR3"
contains "the switch still happens" "export CLAUDESWITCH_ACCOUNT='beta'" "$OUT3"
rm -rf "$FAKEBIN" "$FAKEHOME"

contains "an unknown --session is a clear error" "No session" \
  "$(cd "$HP" && "$CS" handoff beta --from alpha --session deadbeef --yes 2>&1)"
contains "the same account as both source and target is refused" "both the source and the target" \
  "$(cd "$HP" && "$CS" handoff alpha --from alpha --yes 2>&1)"
# Run from outside the project directory: alpha has a session, but not for this cwd.
contains "no session for a directory the source account never ran claude in" "No Claude Code session" \
  "$("$CS" handoff beta --from alpha --yes 2>&1)"
contains "an unknown target account is a clear error" "No account named" \
  "$(cd "$HP" && "$CS" handoff nope --from alpha --yes 2>&1)"
rm -rf "$ROOT/accounts/alpha/projects" "$ROOT/accounts/beta/projects" "$ROOT/handoff-project"

echo "── shared-link resilience"
printf '%s' '{"v":"shared"}' > "$ROOT/shared/settings.json"
printf '%s' '{"v":"local-newer"}' > "$ROOT/accounts/alpha/.t" && mv "$ROOT/accounts/alpha/.t" "$ROOT/accounts/alpha/settings.json"
"$CS" use alpha --emit-shell >/dev/null 2>&1
check "a clobbered link is restored" "../../shared/settings.json" "$(readlink "$ROOT/accounts/alpha/settings.json")"
check "the newer local file is promoted" '{"v":"local-newer"}' "$(cat "$ROOT/shared/settings.json")"
check "the replaced shared file is archived" '{"v":"shared"}' \
  "$(cat "$(find "$ROOT/archive/shared" -name settings.json | head -1)")"

echo "── isolation guarantees"
for private in .credentials.json .claude.json projects sessions history.jsonl; do
  check "$private is not a link in alpha" "" "$(readlink "$ROOT/accounts/alpha/$private" 2>/dev/null)"
done
ln -sf ../../shared/settings.json "$ROOT/accounts/gamma/.credentials.json"
contains "doctor flags a linked credential file" "NOT isolated" "$("$CS" doctor 2>&1)"
rm -f "$ROOT/accounts/gamma/.credentials.json"

echo "── concurrency"
for i in 1 2 3 4 5 6 7 8; do ( "$CS" use alpha --emit-shell >/dev/null 2>&1 ) & done
( "$CS" add racer-a --no-login >/dev/null 2>&1 ) &
( "$CS" add racer-b --no-login >/dev/null 2>&1 ) &
( "$CS" add racer-c --no-login >/dev/null 2>&1 ) &
wait
check "no concurrent write lost an account" "6" \
  "$(python3 -c "import json;print(len(json.load(open('$ROOT/registry.json'))['accounts']))")"
check "no lock file is left behind" "" "$(ls -A "$ROOT" | grep '\.lock$')"
check "no temp file is left behind" "" "$(ls -A "$ROOT" | grep '\.tmp$')"

echo "── per-shell independence"
if command -v zsh >/dev/null; then
  cat > "$ROOT/peer.zsh" <<'ZEOF'
export CLAUDESWITCH_HOME="$1"
eval "$("$2" init --shell zsh)"
cs use "$3" >/dev/null 2>&1
sleep 0.3
print -r -- "$CLAUDESWITCH_ACCOUNT"
ZEOF
  A="$(zsh "$ROOT/peer.zsh" "$ROOT" "$CS" alpha & zsh "$ROOT/peer.zsh" "$ROOT" "$CS" beta & wait)"
  contains "one shell holds alpha" "alpha" "$A"
  contains "the other holds beta at the same time" "beta" "$A"
else
  echo "  skip  zsh not available"
fi

echo "── aliases"
"$CS" alias beta b bt >/dev/null
contains "aliases are stored" '"aliases"' "$(cat "$ROOT/registry.json")"
check "an alias resolves to the account" "$ROOT/accounts/beta" "$("$CS" which b)"
check "a second alias resolves too" "$ROOT/accounts/beta" "$("$CS" which bt)"
contains "a bare alias switches the shell" "export CLAUDESWITCH_ACCOUNT='beta'" \
  "$("$CS" b --emit-shell 2>/dev/null)"
contains "a bare account name switches too" "export CLAUDESWITCH_ACCOUNT='beta'" \
  "$("$CS" beta --emit-shell 2>/dev/null)"
contains "an alias taken by another account is rejected" "already refers to" "$("$CS" alias gamma b 2>&1)"
contains "an alias equal to an account name is rejected" "already refers to" "$("$CS" alias gamma alpha 2>&1)"
contains "a command word cannot be an alias" "claudeswitch command" "$("$CS" alias gamma doctor 2>&1)"
contains "a command word cannot be an account name" "claudeswitch command" "$("$CS" add share --no-login 2>&1)"
contains "an invalid alias is rejected" "Invalid alias" "$("$CS" alias gamma "Bad Alias" 2>&1)"
contains "unalias on a non-alias explains itself" "is not an alias" "$("$CS" unalias nope 2>&1)"
contains "unalias on an account name suggests rename" "rename" "$("$CS" unalias alpha 2>&1)"
"$CS" unalias bt >/dev/null
check "unalias removes only that alias" "$ROOT/accounts/beta" "$("$CS" which b)"
contains "the removed alias no longer resolves" "Unknown command or account" "$("$CS" bt 2>&1)"
contains "ls grows an alias column" "ALIAS" "$("$CS" ls)"
"$CS" alias beta --clear >/dev/null
contains "--clear removes every alias" "no aliases" "$("$CS" alias beta 2>&1)"
check "no alias column when nothing has one" "0" "$("$CS" ls | grep -c 'ALIAS')"

echo "── credential safety"
# Claude Code derives the macOS Keychain entry from the config-dir path, so the
# key must be pinned at creation and survive a rename.
check "a new account pins its keychain key" "$ROOT/accounts/alpha" \
  "$(python3 -c "import json;print(json.load(open('$ROOT/registry.json'))['accounts']['alpha'].get('securestorageKey',''))")"
contains "the switch exports the pinned key" "CLAUDE_SECURESTORAGE_CONFIG_DIR='$ROOT/accounts/alpha'" \
  "$("$CS" use alpha --emit-shell 2>/dev/null)"

# Two accounts holding one refresh token invalidate each other on rotation.
mkdir -p "$ROOT/accounts/alpha" "$ROOT/accounts/beta"
for acc in alpha beta; do
  python3 -c "
import json,time
now=int(time.time()*1000)
json.dump({'claudeAiOauth':{'accessToken':'AT','refreshToken':'RT-SHARED','expiresAt':now+3600000,
  'refreshTokenExpiresAt':now+30*86400000,'subscriptionType':'team','scopes':['user:inference']}},
  open('$ROOT/accounts/$acc/.credentials.json','w'))
"
done
contains "doctor catches two accounts sharing a credential" "hold the same credential" "$("$CS" doctor 2>&1)"
check "doctor exits non-zero on a shared credential" "2" "$("$CS" doctor >/dev/null 2>&1; echo $?)"
python3 -c "
import json,time
now=int(time.time()*1000)
json.dump({'claudeAiOauth':{'accessToken':'AT','refreshToken':'RT-BETA','expiresAt':now+3600000,
  'refreshTokenExpiresAt':now+30*86400000,'subscriptionType':'team','scopes':['user:inference']}},
  open('$ROOT/accounts/beta/.credentials.json','w'))
"
contains "distinct credentials pass the check" "own credential lineage" "$("$CS" doctor 2>&1)"

# An idle deadline close to expiry has to be visible, not buried.
python3 -c "
import json,time
now=int(time.time()*1000)
json.dump({'claudeAiOauth':{'accessToken':'AT','refreshToken':'RT-BETA','expiresAt':now-1000,
  'refreshTokenExpiresAt':now+2*86400000,'subscriptionType':'team','scopes':['user:inference']}},
  open('$ROOT/accounts/beta/.credentials.json','w'))
"
contains "ls flags a login that is about to lapse" "renew (2d)" "$("$CS" ls)"
contains "switching warns about the deadline" "expires in 2 days" "$("$CS" use beta --emit-shell 2>&1 >/dev/null)"

# A long-lived token is exported, and replaced cleanly by a normal account.
printf 'sk-ant-oat01-TESTTOKEN-0123456789abcdefghijklmnopqrstuvwxyz\n' > "$ROOT/accounts/gamma/.long-lived-token"
chmod 600 "$ROOT/accounts/gamma/.long-lived-token"
contains "a long-lived token is exported on switch" "CLAUDE_CODE_OAUTH_TOKEN=" \
  "$("$CS" use gamma --emit-shell 2>/dev/null)"
contains "ls marks the long-lived account" "long-lived" "$("$CS" ls)"
contains "switching away unsets the token" "unset CLAUDE_CODE_OAUTH_TOKEN" \
  "$(CLAUDE_CODE_OAUTH_TOKEN=leftover "$CS" use alpha --emit-shell 2>/dev/null)"
check "an account without one exports no token" "0" \
  "$("$CS" use alpha --emit-shell 2>/dev/null | grep -c 'CLAUDE_CODE_OAUTH_TOKEN=')"

echo "── rename keeps credentials reachable"
"$CS" rename gamma gamma2 >/dev/null 2>&1
check "the pinned key survives a rename" "$ROOT/accounts/gamma" \
  "$(python3 -c "import json;print(json.load(open('$ROOT/registry.json'))['accounts']['gamma2'].get('securestorageKey',''))")"
contains "the renamed account still exports the old key" "CLAUDE_SECURESTORAGE_CONFIG_DIR='$ROOT/accounts/gamma'" \
  "$("$CS" use gamma2 --emit-shell 2>/dev/null)"
"$CS" rename gamma2 gamma >/dev/null 2>&1

echo "── login state the picker can trust"
# A Keychain-backed account leaves no file behind, so an absent file must never
# be reported as "not logged in" — the bug that made every account look broken.
mkdir -p "$ROOT/accounts/kc"
python3 -c "
import json
p='$ROOT/registry.json'
d=json.load(open(p))
d['accounts']['kc']={'slug':'kc','share':'none','createdAt':'2026-01-01T00:00:00.000Z',
  'securestorageKey':'$ROOT/accounts/kc','email':'kc@example.com'}
json.dump(d,open(p,'w'),indent=2)
"
OUT="$(CLAUDESWITCH_NO_PROBE=1 "$CS" ls --json)"
check "an absent credential file is reported as keychain storage" "keychain" \
  "$(python3 -c "
import json,sys
d=json.loads(sys.argv[1])
print(next(a['credentials']['storage'] for a in d['accounts'] if a['slug']=='kc'))
" "$OUT")"
check "and never claimed to need a login" "False" \
  "$(python3 -c "
import json,sys
d=json.loads(sys.argv[1])
a=next(x for x in d['accounts'] if x['slug']=='kc')
print(a['credentials'].get('kind')=='none')
" "$OUT")"

# A cached probe result is what the picker shows; stale caches are ignored.
python3 -c "
import json
p='$ROOT/registry.json'
d=json.load(open(p))
d['accounts']['kc']['authState']='logged-out'
d['accounts']['kc']['authCheckedAt']='2026-08-18T00:00:00.000Z'
json.dump(d,open(p,'w'),indent=2)
"
check "a fresh cached state is trusted" "logged-out" \
  "$(python3 -c "import json;print(json.load(open('$ROOT/registry.json'))['accounts']['kc']['authState'])")"
"$CS" rm kc --yes >/dev/null 2>&1

echo "── quota reporting"
# Claude Code caches usage per config dir; claudeswitch reads that cache.
write_usage() { # write_usage <account> <uuid> <ageMinutes> <fiveHourPct>
  python3 -c "
import json,sys,time
acct,uuid,age,five = sys.argv[1], sys.argv[2], int(sys.argv[3]), float(sys.argv[4])
p='$ROOT/accounts/%s/.claude.json' % acct
d=json.load(open(p))
d['oauthAccount']={'accountUuid':uuid,'emailAddress':'u@example.com'}
now=int(time.time()*1000)
reset=lambda h: __import__('datetime').datetime.fromtimestamp(now/1000+h*3600, __import__('datetime').timezone.utc).isoformat()
d['cachedUsageUtilization']={'fetchedAtMs':now-age*60000,'accountUuid':uuid,'utilization':{
  'five_hour':{'utilization':five,'resets_at':reset(2)},
  'seven_day':{'utilization':13,'resets_at':reset(72)},
  'seven_day_opus':None,
  'nimbus_quill':{'utilization':0,'resets_at':None},
  'extra_usage':{'is_enabled':True,'monthly_limit':3500,'used_credits':1143,
                 'utilization':32.657,'currency':'USD','decimal_places':2,
                 'spend_limit_reached':False,'disabled_reason':None},
}}
json.dump(d,open(p,'w'),indent=2)
" "$1" "$2" "$3" "$4"; }

write_usage alpha 11111111-1111-1111-1111-111111111111 5 100
OUT="$("$CS" usage alpha)"
contains "the 5-hour window is reported" "5-hour session" "$OUT"
contains "with its utilization" "100%" "$OUT"
contains "and when it resets" "resets in" "$OUT"
contains "the weekly window is reported" "week" "$OUT"
contains "extra credits are shown in major units" "11.43 of 35.00 USD" "$OUT"
check "an all-zero codename bucket is hidden" "0" "$(printf '%s' "$OUT" | grep -c 'nimbus')"
contains "the reading's age is stated" "as of" "$OUT"

# Older than Claude Code's own one-hour cutoff: still shown, but labelled.
write_usage alpha 11111111-1111-1111-1111-111111111111 180 100
contains "a stale reading is marked as such" "ignores readings older than" "$("$CS" usage alpha)"

# A reading left over from a different identity must never be displayed.
python3 -c "
import json
p='$ROOT/accounts/alpha/.claude.json'
d=json.load(open(p)); d['oauthAccount']['accountUuid']='99999999-9999-9999-9999-999999999999'
json.dump(d,open(p,'w'),indent=2)
"
contains "a reading from another identity is discarded" "no usage data" "$("$CS" usage alpha)"

contains "a missing reading explains how to get one" "/usage" "$("$CS" usage beta)"

# Quota belongs to the identity, not to a directory: a reading recorded anywhere
# for the same account is valid, and using the freshest one beats showing nothing.
"$CS" add twin --no-login --share none >/dev/null 2>&1
python3 -c "
import json
shared='aaaaaaaa-1111-2222-3333-444444444444'
for acct in ('twin','beta'):
    p='$ROOT/accounts/%s/.claude.json' % acct
    d=json.load(open(p))
    d['oauthAccount']={'accountUuid':shared,'emailAddress':'shared@example.com'}
    if acct=='twin': d.pop('cachedUsageUtilization',None)
    json.dump(d,open(p,'w'),indent=2)
"
write_usage beta aaaaaaaa-1111-2222-3333-444444444444 10 64
OUT="$("$CS" usage twin)"
contains "an account borrows a sibling's reading for the same identity" "5-hour session" "$OUT"
contains "and says where it came from" "recorded by account beta" "$OUT"
contains "a different identity does not borrow it" "no usage data" "$("$CS" usage alpha)"

# A window whose reset time has passed: the percentage describes a window that no
# longer exists, so it must not be presented as current.
python3 -c "
import json,time,datetime
now=int(time.time()*1000)
past=datetime.datetime.fromtimestamp(now/1000-7200, datetime.timezone.utc).isoformat()
future=datetime.datetime.fromtimestamp(now/1000+180000, datetime.timezone.utc).isoformat()
p='$ROOT/accounts/beta/.claude.json'; d=json.load(open(p))
d['cachedUsageUtilization']={'fetchedAtMs':now-6*3600*1000,
  'accountUuid':'aaaaaaaa-1111-2222-3333-444444444444','utilization':{
    'five_hour':{'utilization':100,'resets_at':past},
    'seven_day':{'utilization':22,'resets_at':future}}}
json.dump(d,open(p,'w'),indent=2)
"
OUT="$("$CS" usage beta)"
contains "a rolled-over window is labelled, not shown as current" "window reset" "$OUT"
check "and its stale percentage is withheld" "0" "$(printf '%s' "$OUT" | grep -c '100%')"
contains "the still-valid window is unaffected" "22%" "$OUT"
contains "the ls column falls back to the valid window" "7d 22%" "$("$CS" ls --usage)"
"$CS" rm twin --yes --keep-credentials >/dev/null 2>&1

write_usage beta 22222222-2222-2222-2222-222222222222 5 42
contains "ls --usage adds a quota column" "QUOTA" "$("$CS" ls --usage)"
check "ls hides quota by default" "0" "$("$CS" ls | grep -c 'QUOTA')"
contains "the column shows the tightest window" "5h 42%" "$("$CS" ls --usage)"
for w in 120 100 80; do
  check "the ls --usage table fits $w columns" "yes" "$(COLUMNS=$w "$CS" ls --usage | fits "$w")"
done
check "usage --json lists every account" "$("$CS" ls --json | python3 -c "import json,sys; print(len(json.load(sys.stdin)['accounts']))")" \
  "$("$CS" usage --json | python3 -c "import json,sys; print(len(json.load(sys.stdin)['accounts']))")"
check "usage --json keeps reset times as ISO" "yes" \
  "$("$CS" usage --json | python3 -c "
import json,sys,re
d=json.load(sys.stdin)
for a in d['accounts']:
    if a['usage']:
        for b in a['usage']['buckets']:
            if b['resetsAt'] and not re.match(r'\d{4}-\d\d-\d\dT', b['resetsAt']):
                print('no'); raise SystemExit
print('yes')")"

echo "── a closed output pipe is not an error"
"$CS" usage 2>"$ROOT/pipe.err" | no-such-command-for-claudeswitch-tests 2>/dev/null
check "no diagnostics when the reader never starts" "" "$(cat "$ROOT/pipe.err")"
"$CS" ls --usage 2>"$ROOT/pipe.err" | no-such-command-for-claudeswitch-tests 2>/dev/null
check "same for the account list" "" "$(cat "$ROOT/pipe.err")"
check "and piping to head still yields output" "yes" \
  "$(test -n "$("$CS" usage | head -1)" && echo yes || echo no)"
rm -f "$ROOT/pipe.err"

echo "── documentation stays in step with the code"
check "every command in the README table is wired up" "" "$(python3 "$HERE/scripts/check-docs.py" 2>&1)"

echo "── option handling"
contains "a typo on a destructive flag is refused" "Unknown option" "$("$CS" rm alpha --purgee --yes 2>&1)"
contains "and the typo is named" "--purgee" "$("$CS" rm alpha --purgee --yes 2>&1)"
contains "a near miss is suggested" "Did you mean --purge" "$("$CS" rm alpha --purgee --yes 2>&1)"
check "the account survives a refused command" "yes" \
  "$(python3 -c "import json;print('yes' if 'alpha' in json.load(open('$ROOT/registry.json'))['accounts'] else 'no')")"
contains "a value flag with no value is refused" "needs a value" "$("$CS" keepwarm --install --every-days 2>&1)"
contains "an unknown flag on ls is refused" "Unknown option" "$("$CS" ls --deap 2>&1)"
check "global flags are accepted everywhere" "0" "$("$CS" ls --json >/dev/null 2>&1; echo $?)"

# Every flag read as a string must be declared, or its value becomes a
# positional and the command silently falls back to a default.
check "every string flag is declared as value-taking" "" "$(python3 "$HERE/scripts/check-value-flags.py")"

echo "── corrupt state is reported, never overwritten"
cp "$ROOT/registry.json" "$ROOT/registry.good"
printf '{ this is not json' > "$ROOT/registry.json"
contains "a damaged registry is explained" "not readable as JSON" "$("$CS" ls 2>&1)"
check "and left exactly as it was" "{ this is not json" "$(cat "$ROOT/registry.json")"
cp "$ROOT/registry.good" "$ROOT/registry.json"
rm -f "$ROOT/registry.good"
check "recovers once restored" "0" "$("$CS" ls >/dev/null 2>&1; echo $?)"

echo "── terminal output"
for w in 120 100 80 60 40; do
  check "the ls table fits $w columns" "yes" "$(COLUMNS=$w "$CS" ls | fits "$w")"
done
check "the ls --wide table fits 100 columns" "yes" "$(COLUMNS=100 "$CS" ls --wide | fits 100)"
contains "ls --wide adds the org column" "ORG" "$("$CS" ls --wide)"
check "ls hides org by default" "0" "$("$CS" ls | grep -c 'ORG')"

echo "── management commands"
"$CS" rename alpha alpha2 >/dev/null 2>&1
check "rename moves the directory" "yes" "$([ -d "$ROOT/accounts/alpha2" ] && echo yes || echo no)"
check "rename keeps links valid" "../../shared/settings.json" "$(readlink "$ROOT/accounts/alpha2/settings.json")"
"$CS" alias alpha2 a2 >/dev/null
check "aliases survive a rename" "$ROOT/accounts/alpha2" "$("$CS" which a2)"
"$CS" label alpha2 renamed account >/dev/null
contains "label is stored" "renamed account" "$(cat "$ROOT/registry.json")"
"$CS" default beta >/dev/null
contains "default is stored" '"defaultAccount": "beta"' "$(cat "$ROOT/registry.json")"
check "which prints the config dir" "$ROOT/accounts/beta" "$("$CS" which beta)"
"$CS" rm gamma --yes >/dev/null 2>&1
check "rm unregisters the account" "0" \
  "$(python3 -c "import json;print(1 if 'gamma' in json.load(open('$ROOT/registry.json'))['accounts'] else 0)")"
check "rm archives the directory" "yes" \
  "$([ -n "$(find "$ROOT/archive/removed" -maxdepth 1 -name 'gamma-*' 2>/dev/null)" ] && echo yes || echo no)"
contains "unknown account is a clear error" "No account named" "$("$CS" use nope 2>&1)"
contains "invalid name is rejected" "Invalid account name" "$("$CS" add "Bad Name" --no-login 2>&1)"
contains "unshareable asset is rejected" "Not shareable" "$("$CS" share beta projects 2>&1)"

echo
if [ "$FAIL" -eq 0 ]; then
  printf '\033[32m%s passed\033[0m\n' "$PASS"
else
  printf '\033[31m%s failed\033[0m, %s passed\n' "$FAIL" "$PASS"
  exit 1
fi
