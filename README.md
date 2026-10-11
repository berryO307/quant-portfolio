# Barinder Singh

**Quant development and research for financial markets.** I build market-data systems and trading tools, then use quantitative methods to investigate the decisions they support.

I work across the full path from market question to running software: data capture, low-latency infrastructure, research models, and dashboards. This combination is useful when a project needs both sound engineering and an understanding of what the market data is meant to explain.

[L2 dashboard demo](https://l2-orderbook-gateway.vercel.app/) · [GitHub](https://github.com/berryO307) · [Buy Me a Coffee](https://buymeacoffee.com/berry07)

## Selected work

| Project | What it demonstrates | Stack | Result |
| --- | --- | --- | --- |
| [L2 Market Data Gateway](./project-2-L2-market-data-gateway/) | Exchange order-book capture, a C++ gateway and a hosted dashboard backed by a relay and database. | C++20, TypeScript, Next.js, Railway, Neon | **28.5 µs p99 queue transit** across 383 samples in a short native desktop capture. |
| [Microgrid MDP](./project-1-microgrid-mdp/) | Battery dispatch optimization under changing market regimes and transaction costs. | Python, NumPy, Pandas | **+96.17 alpha lift** over a random policy in the documented seeded simulation. |

The gateway measurement predates a later consumer-stall fix; no post-fix capture is documented. It is a desktop measurement, not a cloud-latency claim. The microgrid result is from a simulation, not a realized market return.

## Areas I work across

- **Market systems:** C++20 data pipelines, order-book reconstruction, lock-free queues, latency measurement.
- **Quantitative work:** market microstructure, dynamic programming, regime-switching models, and strategy evaluation.
- **Product delivery:** APIs, dashboards, database-backed services, and deployment across the stack.

## Repository map

```text
quant-portfolio/
├── project-1-microgrid-mdp/              Python MDP, experiments, and results
└── project-2-L2-market-data-gateway/     C++ gateway, Railway relay, Neon, Next.js dashboard
```

For freelance work, I’m most useful on projects that connect market data, quantitative analysis, and dependable software: market-data tooling, research prototypes, and trading dashboards.
