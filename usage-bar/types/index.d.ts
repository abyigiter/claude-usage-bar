export type UsageRateLimit = { kind: string; percentUsed: number; resetsAt?: string };
export type UsageReading = {
  startedAt?: number;
  context?: { tokens?: number; window: number; percent?: number };
  rateLimits?: UsageRateLimit[];
  cost?: { usd?: number };
  model?: string;
  prevTokens?: number;
  delta?: number;
  history?: number[];
};
export type UsageActivity = { calls: number; files: string[] };

declare module "claude-code" {
  interface PluginState {
    "usage-bar": { last?: UsageReading; activity?: UsageActivity };
  }
}