export type UsageRateLimit = { kind: string; percentUsed: number; resetsAt?: string };
export type UsageReading = {
  context?: { tokens?: number; window: number; percent?: number };
  rateLimits?: UsageRateLimit[];
  cost?: { usd?: number };
};

declare module "claude-code" {
  interface PluginState {
    "usage-bar": { last?: UsageReading };
  }
}