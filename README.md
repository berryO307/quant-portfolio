# Quant Portfolio

Trading systems and quantitative tools spanning C++20 market-data infrastructure, real-time web dashboards, and Python research.

## Projects

| Project | What it does | Stack | Headline metric | Demo | Source |
| --- | --- | --- | --- | --- | --- |
| [L2 Market Data Gateway](./project-2-L2-market-data-gateway/) | Captures Hyperliquid L2 depth and trades, records measured pipeline stages, and serves a live or replay dashboard. | C++20, Boost.Beast, simdjson, TypeScript, Next.js, Node.js, Neon Postgres | Queue transit p99 **28.5 µs** in a 383-sample desktop run; 0 samples exceeded 1 ms. | [Open dashboard](https://l2-orderbook-gateway.vercel.app/) | [Project folder](./project-2-L2-market-data-gateway/) |
| [Microgrid MDP](./project-1-microgrid-mdp/) | Models battery dispatch under changing market regimes and transaction costs using a Markov Decision Process. | Python, NumPy, Pandas | **+96.17** alpha lift over a random policy in the documented seeded experiment. | — | [Project folder](./project-1-microgrid-mdp/) |

The gateway latency figure is from a short native desktop measurement with both instruments active. It predates a later consumer-stall fix, and no post-fix capture is documented. It is not a cloud latency claim. The microgrid result is a simulation result, not a market return.

## Repository structure

```text
quant-portfolio/
├── README.md
├── project-1-microgrid-mdp/
│   ├── src/                 # MDP, solver, and simulator
│   ├── experiments/         # Reproducible simulation reports
│   ├── notes/               # Mathematical walkthroughs
│   ├── results/             # Saved experiment outputs
│   └── README.md
└── project-2-L2-market-data-gateway/
    ├── include/             # C++20 gateway headers
    ├── src/                 # Capture, order book, and relay client
    ├── relay/               # Railway WebSocket relay and Neon scripts
    ├── web/                 # Next.js dashboard deployed on Vercel
    ├── scripts/             # Local and hosted gateway helpers
    ├── CMakeLists.txt
    └── README.md
```

Project 2 has no notebook-based analysis directory. Its latency view is part of the dashboard and is populated from the relay feed.

## Profile

[GitHub profile](https://github.com/berryO307)
