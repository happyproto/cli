// crates/hpy/tests/happyview.rs's fake `deno` and `docker` for `dev --network local`, shared by
// test/cli/network.test.ts and the parity harness (`@netbin`). Both log every call to
// `$NET_LOG`; the `NET_*` variables below change what they do.

/**
 * A `deno` standing in for Atmosphere in a Box's CLI: it logs every call and writes the state
 * files the real one would. Like the real one it refuses every sandbox command while
 * `state/cli.lock` exists.
 */
export const FAKE_DENO = `echo "deno $*" >> "$NET_LOG"
case "$*" in
  "task sandbox"*)
    if [ -d state/cli.lock ]; then
      echo "CLI locked; inspect state/cli.lock before removing it after a crash" >&2
      echo "deno refused: locked" >> "$NET_LOG"
      exit 1
    fi ;;
esac
# The real CLI reports progress on stdout; \`access hosts\` is read by hpy and
# prints only its block.
if [ "$1" = install ]; then
  echo "deno install saw DENO_NO_PACKAGE_JSON=$DENO_NO_PACKAGE_JSON" >> "$NET_LOG"
fi
case "$*" in
  "task sandbox access hosts") ;;
  task*) echo "sandbox progress: $*" ;;
esac
case "$*" in
  --version) echo "deno 2.8.3 (stable, release)" ;;
  "task sandbox create"*)
    mkdir -p state/ca
    # The real one records the network it was created on.
    subnet=$(echo "$*" | sed -n 's/.*--subnet \\([^ ]*\\).*/\\1/p')
    echo "{\\"applications\\":[],\\"subnet\\":\\"$subnet\\"}" > state/manifest.json
    echo fake-ca > state/ca/root.crt ;;
  "task sandbox apply --app happyview")
    applied=$(sed 's/"applications":\\[\\]/"applications":["happyview"]/' state/manifest.json)
    echo "$applied" > state/manifest.json ;;
  "task sandbox seed")
    # Fails part way, leaving a step pending.
    if [ -n "$NET_SEED_FAILS" ]; then echo '{}' > state/pending-apply.json; exit 1; fi
    # Waits for \`NET_STEP_RELEASE\` to appear once it has said it started.
    if [ -n "$NET_SEED_BLOCK" ]; then
      if [ "$NET_SEED_BLOCK" = pending ]; then echo '{}' > state/pending-apply.json; fi
      echo seeding > "$NET_STEP_STARTED"
      while [ ! -f "$NET_STEP_RELEASE" ]; do sleep 0.05; done
    fi
    echo '{"version":1,"accounts":{"user1.pds1.atmosbox.test":{"handle":"user1.pds1.atmosbox.test","password":"seeded-secret-pw","phase":"ready","did":"did:plc:user1"}}}' > state/accounts.json
    echo "deno seed finished" >> "$NET_LOG" ;;
  "task sandbox resume")
    rm -f state/pending-create.json state/pending-apply.json
    mkdir -p state/ca
    [ -f state/manifest.json ] || echo '{"applications":[]}' > state/manifest.json
    echo fake-ca > state/ca/root.crt ;;
  "task sandbox destroy --accept-destructive")
    # The real one reads the project's name from the manifest.
    [ -f state/manifest.json ] || { echo "no manifest" >&2; exit 1; }
    rm -f state/manifest.json state/accounts.json state/pending-create.json state/pending-apply.json ;;
  "task sandbox access hosts")
    if [ -n "$NET_HOSTS" ]; then printf '%s\\n' '# begin' "$NET_HOSTS" '# end'; fi ;;
  "task sandbox up"*)
    # Dies holding the lock, as a deno killed mid-operation does.
    if [ -n "$NET_UP_CRASHES" ]; then mkdir state/cli.lock; kill -KILL $$; fi
    # Another command takes the lock first, and this one refuses with an
    # ordinary exit, as the real CLI's "CLI locked" does.
    if [ -n "$NET_UP_CONTENDED" ]; then
      mkdir state/cli.lock
      echo "CLI locked; inspect state/cli.lock before removing it after a crash" >&2
      exit 1
    fi
    if [ -n "$NET_UP_FAILS" ] && grep -q happyview state/manifest.json; then exit 1; fi
    # The \`up\` that brings HappyView in, blocked as \`seed\` is above.
    if [ -n "$NET_UP_BLOCK" ] && grep -q happyview state/manifest.json; then
      echo up > "$NET_STEP_STARTED"
      while [ ! -f "$NET_STEP_RELEASE" ]; do sleep 0.05; done
    fi ;;
esac
exit 0`;

/**
 * A \`docker\` answering what \`hpy\` asks of it. \`NET_RELAY\` names a running access relay;
 * \`NET_BLOCK\` keeps \`logs --follow\` open far longer than any test waits, so only \`hpy\`
 * ending it lets the test finish.
 */
export const FAKE_DOCKER = `echo "docker $*" >> "$NET_LOG"
case "$*" in
  "compose version"*) echo "Docker Compose version v2.40.0" ;;
  "network ls"*) echo bridge ;;
  "network inspect"*) echo "bridge 172.17.0.0/16 " ;;
  "ps --filter label=com.docker.compose.service=host-access"*)
    if [ -n "$NET_RELAY" ]; then echo "$NET_RELAY"; fi ;;
  "ps --filter label=com.docker.compose.project="*)
    printf '%s\\n' "hv-test-dns-1 dns" "hv-test-gateway-1 gateway" "hv-test-pds1-1 pds1" \\
      "hv-test-plc-1 plc" "hv-test-happyview-1 happyview" ;;
  "info"*) echo aarch64 ;;
  "ps -a"*)
    if grep -q happyview state/manifest.json 2>/dev/null; then echo hv-test-happyview-1; fi ;;
  "logs --tail"*) echo "happyview: could not open the database" ;;
  "logs --follow"*)
    echo "happyview log line"
    if [ -n "$NET_BLOCK" ]; then echo following > "$NET_FOLLOWING"; exec sleep 120; fi ;;
  "inspect"*) echo "true 0" ;;
esac
exit 0`;
