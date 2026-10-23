/**
 * What `/status` knows about the providers we depend on.
 *
 * Observed, never probed: an outcome is recorded by the code that was already
 * making a provider call, so `/status` costs nothing and cannot itself spend
 * Linq's shared rate limit. A handler that probed its dependencies per request
 * would turn a status page into a second source of load, and the thing most
 * likely to scrape it is a monitor.
 *
 * Nothing here gates startup. One provider being down is not a reason to refuse
 * to serve: the indexer and every read path work without the rails.
 */

/**
 * How long an observation still describes the present.
 *
 * An outcome older than this is dropped rather than reported, because a
 * provider nothing has called since yesterday is unknown — not healthy, and not
 * broken. Without the bound a single failure pins `railsUsable` false for as
 * long as the process lives, since only another call to the same dependency can
 * overwrite it.
 */
export const dependencyStatusBoundMs: number = 15 * 60 * 1000;

/** A fixed vocabulary, so a reason can never carry provider text. */
export type DependencyFailure = "timeout" | "error";

export interface DependencyOutcome {
  status: "healthy" | "unavailable";
  lastChecked: string | null;
  latencyMs?: number;
  error?: DependencyFailure;
}

interface StoredOutcome extends DependencyOutcome {
  /** Epoch millis, for the age bound; `lastChecked` is for humans. */
  at: number;
}

const dependencyOutcomes = new Map<string, StoredOutcome>();

/**
 * Record how a provider call went.
 *
 * `error` is one of two words, never a message. A provider error string can
 * contain the request URL, and an API key lives in the path or query of some of
 * ours — `/status` is the last place that should repeat one back.
 */
export function recordDependencyOutcome(
  name: string,
  success: boolean,
  latencyMs?: number,
  error?: DependencyFailure,
): void {
  const at = Date.now();
  dependencyOutcomes.set(name, {
    status: success ? "healthy" : "unavailable",
    lastChecked: new Date(at).toISOString(),
    at,
    ...(latencyMs !== undefined ? { latencyMs } : {}),
    ...(success ? {} : { error: error ?? "error" }),
  });
}

export function getDependencyStatus(now: number = Date.now()): {
  railsUsable: boolean;
  dependencies: Record<string, DependencyOutcome>;
  boundMs: number;
} {
  const dependencies: Record<string, DependencyOutcome> = {};
  let sawUnavailable = false;

  for (const [name, dep] of dependencyOutcomes) {
    if (now - dep.at > dependencyStatusBoundMs) continue;
    const { at: _at, ...reported } = dep;
    dependencies[name] = reported;
    if (reported.status !== "healthy") sawUnavailable = true;
  }

  // Nothing recent to go on means usable: the rails are not known to be broken,
  // and a fresh process has made no calls yet. A recent observed failure is what
  // flips it.
  return { railsUsable: !sawUnavailable, dependencies, boundMs: dependencyStatusBoundMs };
}

/** Test seam. */
export function _resetDependencyOutcomes(): void {
  dependencyOutcomes.clear();
}
