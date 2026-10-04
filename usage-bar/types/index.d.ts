export type UsageRateLimit = { kind: string; percentUsed: number; resetsAt?: string };
export type UsageReading = {
  startedAt?: number;
  context?: { tokens?: number; window: number; percent?: number };
  rateLimits?: UsageRateLimit[];
  cost?: { usd?: number };
  model?: string;
  prevTokens?: number;
  costDelta?: number;
  delta?: number;
  history?: number[];
};
export type UsageActivity = { calls: number; files: string[]; tools?: Record<string, number> };
export type UsageTurn = { ms: number; usd: number | null; in: number; out: number; cr: number; cw: number };
export type UsageContextMap = { at: number; cats: { name: string; tokens: number; kind: string }[] };
export type UsagePr = { number: number; state: string; review: "approved" | "changes" | null; checks: "pass" | "fail" | "pending" | null };
export type UsageGit = {
  branch?: string;
  dirty?: number;
  untracked?: number;
  added?: number;
  removed?: number;
  ahead?: number;
  behind?: number;
  pr?: UsagePr | null;
  prCheckedAt?: number;
};

declare module "claude-code" {
  interface PluginState {
    "usage-bar": {
      last?: UsageReading;
      activity?: UsageActivity;
      git?: UsageGit;
      turn?: { startedAt: number; tick: number; costAt?: number };
      ui?: { expanded: boolean };
      turns?: UsageTurn[];
      ctxmap?: UsageContextMap;
    };
  }
}