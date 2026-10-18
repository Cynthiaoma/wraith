export const dependencyStatusBoundMs: number = 15 * 60 * 1000;

const dependencyOutcomes = new Map<string, { status: string; lastChecked: string | null; latencyMs?: number; error?: string }>();

export function recordDependencyOutcome(
  name: string,
  success: boolean,
  latencyMs?: number,
  error?: string,
): void {
  const now = new Date().toISOString();
  const status = success ? "healthy" : "unavailable";
  dependencyOutcomes.set(name, { status, lastChecked: now, latencyMs, error });
}

export function getDependencyStatus(): {
  railsUsable: boolean;
  dependencies: Record<string, { status: string; lastChecked: string | null; latencyMs?: number; error?: string }>;
  boundMs: number;
} {
  const allHealthy = Array.from(dependencyOutcomes.values()).every(
    (dep) => dep.status === "healthy",
  );
  // With no recorded outcomes, rails are assumed usable; an observed failure
  // flips this to degraded.
  const railsUsable = dependencyOutcomes.size === 0 || allHealthy;

  const dependencies: Record<string, {
    status: string;
    lastChecked: string | null;
    latencyMs?: number;
    error?: string;
  }> = {};

  for (const [name, dep] of dependencyOutcomes) {
    dependencies[name] = {
      status: dep.status,
      lastChecked: dep.lastChecked ?? null,
      latencyMs: dep.latencyMs,
      error: dep.error,
    };
  }

  return { railsUsable, dependencies, boundMs: dependencyStatusBoundMs };
}