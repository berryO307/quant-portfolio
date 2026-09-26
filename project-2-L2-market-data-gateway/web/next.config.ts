import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next.js's own dev-mode build-indicator ("N" logo, expands to a red
  // issue-count pill on a build error/warning) defaults to bottom-left —
  // exactly where this app's Depth Curve renders its own y-axis on
  // desktop and its Parse-stage chart sits on a narrow/mobile layout. This
  // is framework chrome rendered outside React's own tree (confirmed:
  // nothing under src/ defines it), so no amount of app-level CSS
  // z-index/positioning can move it — devIndicators.position is the
  // actual, supported way to relocate it. bottom-right is clear of both
  // the ladder/curve column (left) and the latency panel's own charts
  // (right column, but its content stops well short of the bottom-right
  // corner). Dev-only: this entire indicator doesn't exist in a
  // production build regardless of this setting.
  devIndicators: {
    position: "bottom-right",
  },
};

export default nextConfig;
