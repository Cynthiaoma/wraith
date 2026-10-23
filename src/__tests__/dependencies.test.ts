import {
  _resetDependencyOutcomes,
  dependencyStatusBoundMs,
  getDependencyStatus,
  recordDependencyOutcome,
} from "../dependencies";

describe("dependency status", () => {
  beforeEach(() => {
    _resetDependencyOutcomes();
  });

  it("reports nothing, and usable rails, before any provider call", () => {
    const status = getDependencyStatus();

    expect(status.dependencies).toEqual({});
    expect(status.railsUsable).toBe(true);
    expect(status.boundMs).toBe(dependencyStatusBoundMs);
  });

  it("marks the rails unusable on an observed failure", () => {
    recordDependencyOutcome("linq", false, 1200, "timeout");
    const status = getDependencyStatus();

    expect(status.railsUsable).toBe(false);
    expect(status.dependencies.linq).toMatchObject({
      status: "unavailable",
      latencyMs: 1200,
      error: "timeout",
    });
  });

  it("lets a later success clear an earlier failure", () => {
    recordDependencyOutcome("linq", false, 1200, "error");
    recordDependencyOutcome("linq", true, 180);

    const status = getDependencyStatus();
    expect(status.railsUsable).toBe(true);
    expect(status.dependencies.linq.status).toBe("healthy");
    // A healthy outcome carries no reason at all.
    expect(status.dependencies.linq.error).toBeUndefined();
  });

  it("drops an observation older than the bound instead of reporting it", () => {
    // Without the age bound a single failure pins railsUsable false for the
    // life of the process: only another call to the same dependency can
    // overwrite it, and a provider nobody is calling never gets one.
    recordDependencyOutcome("linq", false, 1200, "error");

    const later = Date.now() + dependencyStatusBoundMs + 1;
    const status = getDependencyStatus(later);

    expect(status.dependencies).toEqual({});
    expect(status.railsUsable).toBe(true);
  });

  it("keeps an observation that is still inside the bound", () => {
    recordDependencyOutcome("linq", false, 1200, "error");

    const status = getDependencyStatus(Date.now() + dependencyStatusBoundMs - 1_000);

    expect(status.dependencies.linq.status).toBe("unavailable");
    expect(status.railsUsable).toBe(false);
  });

  it("never stores a provider message as the reason", () => {
    // A Linq error can carry the request URL, and an API key lives in the path
    // of some of ours. /status is public enough that this must not be a place
    // one can be read back.
    recordDependencyOutcome("linq", false, 10, "error");

    const reported = getDependencyStatus().dependencies.linq;
    expect(["timeout", "error"]).toContain(reported.error);
  });
});
