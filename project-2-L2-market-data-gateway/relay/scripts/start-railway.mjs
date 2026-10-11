// Container entrypoint for a hosted relay (Railway).
//
// Runs ONE relay serving every instrument in SYMBOLS (comma-separated, e.g.
// "BTC,xyz:CL"), and -- when DATABASE_URL is set -- one
// replay-gateway-neon.mjs per symbol, each looping that instrument's
// captured session out of Neon into the relay's /ingest. The relay routes
// each replay to its own channel by the symbol in its hello.
//
// The replays share this container because they connect to
// ws://localhost:<PORT>/ingest; a separate service would need the public
// URL and would pay egress for a feed that never needs to leave the box.
//
// One child process per symbol: a replay that crashes (or whose Neon query
// fails) is restarted on its own, without touching the relay or the other
// instruments. The cost is one Node runtime (~tens of MB) per symbol --
// fine for a handful, and the point at which to move all replays into one
// process if this ever carries hundreds.
//
// Without DATABASE_URL only the relay runs, waiting for live gateways to
// push into /ingest. Set INGEST_TOKEN on any public deployment; every
// child inherits it.
//
// Relay exit -> this process exits with the same code so the platform
// restarts the container. Replay exit -> that replay alone restarts.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const relayRoot = path.resolve(here, "..");
const PORT = process.env.PORT ?? "8080";
const SYMBOLS = (process.env.SYMBOLS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
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
  // /health answers 503 until every feed connects -- any HTTP response
  // means the relay is listening, which is all a replay needs.
  for (;;) {
    try {
      await fetch(`http://localhost:${PORT}/health`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

function startReplay(symbol) {
  const replay = run(`replay (${symbol})`, ["scripts/replay-gateway-neon.mjs", `--symbol=${symbol}`, PORT, "--loop"]);
  replay.on("exit", (code) => {
    console.error(`[start] replay ${symbol} exited (code=${code}); restarting in ${REPLAY_RESTART_MS}ms`);
    setTimeout(() => startReplay(symbol), REPLAY_RESTART_MS);
  });
}

if (process.env.DATABASE_URL && SYMBOLS.length > 0) {
  await waitForRelay();
  for (const symbol of SYMBOLS) startReplay(symbol);
} else {
  console.log("[start] DATABASE_URL or SYMBOLS not set -- relay only, waiting for gateways on /ingest");
}

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    for (const c of children) c.kill(sig);
  });
}
