// Container entrypoint for a hosted relay (Railway).
//
// Runs the relay, and -- when DATABASE_URL and REPLAY_SYMBOL are both set --
// replay-gateway-neon.mjs alongside it, looping a captured session out of
// Neon into the relay's own /ingest. They have to share one container:
// replay-gateway-neon.mjs connects to ws://localhost:<PORT>/ingest, and a
// platform service gets one public port, so a separate service could not
// reach it.
//
// Without those two vars only the relay runs, waiting for a gateway to push
// into /ingest (e.g. the C++ gateway on a self-hosted box later). Set
// INGEST_TOKEN on any public deployment; the replay child inherits it.
//
// Relay exit -> this process exits with the same code so the platform
// restarts the container. Replay exit -> restarted after a delay, without
// taking down the relay clients are connected to.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const relayRoot = path.resolve(here, "..");
const PORT = process.env.PORT ?? "8080";
const SYMBOL = process.env.REPLAY_SYMBOL;
const REPLAY_RESTART_MS = 5_000;

const children = new Set();

function run(label, args) {
  const child = spawn(process.execPath, args, { cwd: relayRoot, env: process.env, stdio: "inherit" });
  children.add(child);
  child.on("exit", () => children.delete(child));
  console.log(`[start] ${label} started (pid ${child.pid})`);
  return child;
}

const relay = run("relay", ["dist/index.js"]);
relay.on("exit", (code, signal) => {
  console.error(`[start] relay exited (code=${code} signal=${signal})`);
  for (const c of children) c.kill("SIGTERM");
  process.exit(code ?? 1);
});

async function waitForRelay() {
  // /health answers 503 until an upstream connects -- any HTTP response
  // means the relay is listening, which is all the replay needs.
  for (;;) {
    try {
      await fetch(`http://localhost:${PORT}/health`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

function startReplay() {
  const replay = run(`replay (${SYMBOL})`, ["scripts/replay-gateway-neon.mjs", `--symbol=${SYMBOL}`, PORT, "--loop"]);
  replay.on("exit", (code) => {
    console.error(`[start] replay exited (code=${code}); restarting in ${REPLAY_RESTART_MS}ms`);
    setTimeout(startReplay, REPLAY_RESTART_MS);
  });
}

if (process.env.DATABASE_URL && SYMBOL) {
  await waitForRelay();
  startReplay();
} else {
  console.log("[start] DATABASE_URL/REPLAY_SYMBOL not set -- relay only, waiting for a gateway on /ingest");
}

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    for (const c of children) c.kill(sig);
  });
}
