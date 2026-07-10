import type { FixtureSpec } from "../../shared/types";

// Multi-bug fixture: two independent defects in one diff. Both mustFind specs
// carry their own file anchor — finding one bug and stopping scores 1/2 and
// fails recall. Catches the "first finding, ship it" laziness pattern.
const spec: FixtureSpec = {
  id: "t3-multi-bug",
  kind: "positive",
  tier: 3,
  defectClass: "multi-defect-single-diff",
  description:
    "One diff, two unrelated bugs: cache.ts inverts the TTL comparison (only expired entries are served), and queue.ts removes items with splice inside forEach (skips the element after every removal).",
  baseFiles: {
    "src/cache.ts": `export interface Entry {
  value: string;
  storedAt: number;
}

export class TtlCache {
  private entries = new Map<string, Entry>();

  constructor(private ttlMs: number) {}

  set(key: string, value: string): void {
    this.entries.set(key, { value, storedAt: Date.now() });
  }

  get(key: string): string | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (Date.now() - entry.storedAt < this.ttlMs) {
      return entry.value;
    }
    this.entries.delete(key);
    return null;
  }
}
`,
    "src/queue.ts": `export interface Job {
  id: string;
  done: boolean;
}

export function pruneDone(jobs: Job[]): Job[] {
  return jobs.filter((job) => !job.done);
}
`,
  },
  headFiles: {
    "src/cache.ts": `export interface Entry {
  value: string;
  storedAt: number;
}

export class TtlCache {
  private entries = new Map<string, Entry>();

  constructor(private ttlMs: number) {}

  set(key: string, value: string): void {
    this.entries.set(key, { value, storedAt: Date.now() });
  }

  get(key: string): string | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (Date.now() - entry.storedAt > this.ttlMs) {
      return entry.value;
    }
    this.entries.delete(key);
    return null;
  }
}
`,
    "src/queue.ts": `export interface Job {
  id: string;
  done: boolean;
}

export function pruneDone(jobs: Job[]): Job[] {
  jobs.forEach((job, index) => {
    if (job.done) {
      jobs.splice(index, 1);
    }
  });
  return jobs;
}
`,
  },
  expected: {
    verdict: "changes_requested",
    mustFind: [
      { pattern: "ttl|expir|invert|revers|comparison|stale|fresh", file: "src/cache.ts", lineRange: [15, 24] },
      { pattern: "splice|forEach|skip|mutat.{0,24}(iterat|loop|array)|remov.{0,24}(iterat|loop|during)", file: "src/queue.ts", lineRange: [6, 13] },
    ],
  },
};

export default spec;
