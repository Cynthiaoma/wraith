/**
 * Indexer degradation, crash-restarts and shutdown (#318).
 *
 * The loop is made to crash on its first await by failing the token-cache warm
 * up, so every case drives the real `startAllIndexers` restart path without a
 * live RPC or database. Fake timers stand in for the 10s restart wait.
 */

jest.mock("../tokenCache", () => ({
  initTokenCache: jest.fn(),
}));

jest.mock("../db", () => ({
  getLastIndexedLedger: jest.fn(async () => null),
  setLastIndexedLedger: jest.fn(),
  pruneOldTransfers: jest.fn(),
}));

import { initTokenCache } from "../tokenCache";
import {
  startAllIndexers,
  stopIndexerLoops,
  isIndexerRunning,
  getIndexerUnstartedReason,
  _pendingRestarts,
  _resetIndexerLoops,
} from "../indexer";
import { _resetRpcClients } from "../rpc";

const mockInit = initTokenCache as jest.Mock;
const RESTART_MS = 10_000;

const ENV_KEYS = ["NETWORKS", "STELLAR_NETWORK", "SOROBAN_RPC_URL", "STELLAR_RPC_URL", "SOROBAN_RPC_URL_TESTNET", "SOROBAN_RPC_URL_MAINNET"];

/** Let a rejected `startIndexer` reach its `.catch` and schedule the restart. */
const settle = () => jest.advanceTimersByTimeAsync(0);

let errorSpy: jest.SpyInstance;
let logSpy: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  for (const key of ENV_KEYS) delete process.env[key];
  _resetRpcClients();
  _resetIndexerLoops();
  mockInit.mockReset();
  mockInit.mockRejectedValue(new Error("boom"));
  errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  _resetIndexerLoops();
  jest.useRealTimers();
  errorSpy.mockRestore();
  logSpy.mockRestore();
});

describe("an unconfigured network", () => {
  it("does not stop the configured one, and does not throw out to the API", async () => {
    // testnet has a public default endpoint; mainnet has none.
    let started: string[] = [];
    expect(() => {
      started = startAllIndexers(["testnet", "mainnet"]);
    }).not.toThrow();
    await settle();

    expect(started).toEqual(["testnet"]);
    expect(getIndexerUnstartedReason("mainnet")).toMatch(/SOROBAN_RPC_URL_MAINNET is required/);
    expect(isIndexerRunning("mainnet")).toBe(false);
    // The configured network's loop really started.
    expect(mockInit).toHaveBeenCalledTimes(1);
    expect(mockInit).toHaveBeenCalledWith("testnet");
    // And only the configured network is ever scheduled to restart.
    expect(_pendingRestarts()).toEqual(["testnet"]);
  });
});

describe("crash-restarts", () => {
  it("schedules one restart after a crash, and runs exactly one loop when it fires", async () => {
    startAllIndexers(["testnet"]);
    await settle();
    expect(_pendingRestarts()).toEqual(["testnet"]);

    await jest.advanceTimersByTimeAsync(RESTART_MS - 1);
    expect(mockInit).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(1);
    expect(mockInit).toHaveBeenCalledTimes(2);
    // The restarted loop crashed again and holds one timer, not two.
    expect(_pendingRestarts()).toEqual(["testnet"]);
  });

  it("never queues two restarts for one network", async () => {
    startAllIndexers(["testnet"]);
    startAllIndexers(["testnet"]);
    await settle();

    expect(mockInit).toHaveBeenCalledTimes(2);
    expect(_pendingRestarts()).toEqual(["testnet"]);

    await jest.advanceTimersByTimeAsync(RESTART_MS);
    // One restart fired, so one new loop — not one per earlier crash.
    expect(mockInit).toHaveBeenCalledTimes(3);
  });

  it("cancels a pending restart when the network is started again, so it never runs twice", async () => {
    startAllIndexers(["testnet"]);
    await settle();
    expect(_pendingRestarts()).toEqual(["testnet"]);

    // This time the loop stays parked on its warm-up rather than crashing.
    mockInit.mockImplementation(() => new Promise(() => {}));
    startAllIndexers(["testnet"]);
    expect(_pendingRestarts()).toEqual([]);

    await jest.advanceTimersByTimeAsync(RESTART_MS * 3);
    expect(mockInit).toHaveBeenCalledTimes(2);
  });
});

describe("clean shutdown", () => {
  it("clears pending restarts, and nothing runs after it", async () => {
    startAllIndexers(["testnet"]);
    await settle();
    expect(_pendingRestarts()).toEqual(["testnet"]);

    stopIndexerLoops();

    expect(_pendingRestarts()).toEqual([]);
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(RESTART_MS * 3);
    expect(mockInit).toHaveBeenCalledTimes(1);
  });

  it("schedules nothing for a loop that crashes after it was stopped", async () => {
    let fail!: (err: Error) => void;
    mockInit.mockImplementation(() => new Promise((_resolve, reject) => (fail = reject)));
    startAllIndexers(["testnet"]);
    await settle();

    stopIndexerLoops();
    fail(new Error("torn down"));
    await settle();

    expect(_pendingRestarts()).toEqual([]);
    expect(jest.getTimerCount()).toBe(0);
    expect(errorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("restarting in 10s"),
      expect.anything(),
    );
  });
});
