import request from "supertest";
import { createApp } from "../api";
import {
  ledgersIndexedTotal,
  transfersStoredTotal,
  lastIndexedLedger,
  observeDbQuery,
  recordRpcError,
  recordSkippedLedger,
  recordOrderCreated,
  recordOrderTerminal,
  terminalStatusOf,
  registry,
  _resetMetrics,
  httpRequestsTotal,
  httpRequestDurationSeconds,
} from "../metrics";

jest.mock("../db", () => ({
  getLastIndexedLedger: jest.fn().mockResolvedValue(1000),
  getLastIndexedState: jest.fn(),
  queryTransfers: jest.fn(),
  queryAllTransfers: jest.fn(),
  queryByTxHash: jest.fn(),
  querySummary: jest.fn(),
  queryNftTransfers: jest.fn(),
  getNftOwner: jest.fn(),
  getNftMetadata: jest.fn(),
  prisma: { $queryRaw: jest.fn().mockResolvedValue([{ 1: 1 }]) },
}));

jest.mock("../rpc", () => ({
  getLatestLedger: jest.fn().mockResolvedValue(1050),
}));

jest.mock("../indexer", () => ({
  getAllIndexerStats: jest.fn().mockReturnValue({}),
  runningNetworks: jest.fn().mockReturnValue([]),
  getIndexerStats: jest
    .fn()
    .mockReturnValue({ startedAt: "2024-01-01T00:00:00.000Z", uptimeSeconds: 100, totalIndexed: 50 }),
}));

describe("Prometheus metrics (#39)", () => {
  const app = createApp();

  beforeEach(() => {
    _resetMetrics();
  });

  describe("GET /metrics", () => {
    it("serves Prometheus text exposition format", async () => {
      const res = await request(app).get("/metrics");

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/plain");
      // Every series in the exposition format is preceded by its HELP and TYPE
      // lines; a body without them is not something Prometheus will scrape.
      expect(res.text).toMatch(/^# HELP /m);
      expect(res.text).toMatch(/^# TYPE /m);
    });

    it("exports every custom metric, declared with the right type", async () => {
      const res = await request(app).get("/metrics");

      expect(res.text).toContain("# TYPE ledgers_indexed_total counter");
      expect(res.text).toContain("# TYPE ledgers_skipped_total counter");
      expect(res.text).toContain("# TYPE transfers_stored_total counter");
      expect(res.text).toContain("# TYPE rpc_errors_total counter");
      expect(res.text).toContain("# TYPE last_indexed_ledger gauge");
      expect(res.text).toContain("# TYPE db_query_duration_seconds histogram");
    });

    it("reports recorded samples with their labels", async () => {
      ledgersIndexedTotal.inc({ network: "testnet" }, 12);
      transfersStoredTotal.inc({ network: "testnet", type: "fungible" }, 5);
      transfersStoredTotal.inc({ network: "testnet", type: "nft" }, 2);
      lastIndexedLedger.set({ network: "testnet" }, 987_654);
      recordRpcError("retry");

      const res = await request(app).get("/metrics");

      expect(res.text).toContain('ledgers_indexed_total{network="testnet"} 12');
      expect(res.text).toContain('transfers_stored_total{network="testnet",type="fungible"} 5');
      expect(res.text).toContain('transfers_stored_total{network="testnet",type="nft"} 2');
      expect(res.text).toContain('last_indexed_ledger{network="testnet"} 987654');
      expect(res.text).toContain('rpc_errors_total{outcome="retry"} 1');
    });

    it("does not depend on the database or RPC being up", async () => {
      // The scrape must still answer when the things it reports on are broken —
      // otherwise monitoring goes dark exactly when it is needed.
      const { prisma } = jest.requireMock("../db");
      const { getLatestLedger } = jest.requireMock("../rpc");
      prisma.$queryRaw.mockRejectedValueOnce(new Error("db down"));
      getLatestLedger.mockRejectedValueOnce(new Error("rpc down"));

      const res = await request(app).get("/metrics");

      expect(res.status).toBe(200);
      expect(res.text).toContain("# TYPE ledgers_indexed_total counter");
    });
  });

  describe("observeDbQuery", () => {
    it("times a successful query under its operation label", async () => {
      const value = await observeDbQuery("someQuery", async () => "result");

      expect(value).toBe("result");
      const text = await registry.metrics();
      expect(text).toContain('db_query_duration_seconds_count{operation="someQuery"} 1');
    });

    it("still times a query that throws, and rethrows it", async () => {
      // A query that takes eight seconds and then fails is the one worth
      // seeing; dropping it would make the histogram describe only good runs.
      await expect(
        observeDbQuery("failingQuery", async () => {
          throw new Error("boom");
        })
      ).rejects.toThrow("boom");

      const text = await registry.metrics();
      expect(text).toContain('db_query_duration_seconds_count{operation="failingQuery"} 1');
    });
  });

  describe("recordRpcError", () => {
    it("separates a retried attempt from an exhausted one", async () => {
      recordRpcError("retry");
      recordRpcError("retry");
      recordRpcError("exhausted");

      const res = await request(app).get("/metrics");
      expect(res.text).toContain('rpc_errors_total{outcome="retry"} 2');
      expect(res.text).toContain('rpc_errors_total{outcome="exhausted"} 1');
    });
  });

  describe("recordSkippedLedger", () => {
    it("counts skipped ledgers per network, with no ledger-sized label", async () => {
      // A skipped ledger is permanent loss, and the ledger number is the value
      // that would blow the series count up — the counter has to answer without
      // it, or an operator ends up paying for a cardinality accident.
      recordSkippedLedger("testnet");
      recordSkippedLedger("testnet");
      recordSkippedLedger("mainnet");

      const res = await request(app).get("/metrics");

      expect(res.text).toContain('ledgers_skipped_total{network="testnet"} 2');
      expect(res.text).toContain('ledgers_skipped_total{network="mainnet"} 1');

      const skipped = res.text
        .split("\n")
        .filter((line) => line.startsWith("ledgers_skipped_total{"));
      expect(skipped).toHaveLength(2);
      expect(skipped.join("\n")).not.toMatch(/ledger=|contract=|address=|url=/);
    });
  });

  describe("order counters (#271)", () => {
    it("counts creation per rail", async () => {
      recordOrderCreated("offramp");
      recordOrderCreated("onramp");
      recordOrderCreated("onramp");
      recordOrderCreated("bills");

      const res = await request(app).get("/metrics");

      expect(res.text).toContain('orders_created_total{rail="offramp"} 1');
      expect(res.text).toContain('orders_created_total{rail="onramp"} 2');
      expect(res.text).toContain('orders_created_total{rail="bills"} 1');
    });

    it("counts terminal outcomes by rail and normalised status", async () => {
      recordOrderTerminal("offramp", "settled");
      recordOrderTerminal("offramp", "completed");
      recordOrderTerminal("onramp", "order.failed");
      recordOrderTerminal("bills", "refunded");

      const res = await request(app).get("/metrics");

      expect(res.text).toContain('orders_terminal_total{rail="offramp",status="settled"} 1');
      expect(res.text).toContain('orders_terminal_total{rail="offramp",status="completed"} 1');
      expect(res.text).toContain('orders_terminal_total{rail="onramp",status="failed"} 1');
      expect(res.text).toContain('orders_terminal_total{rail="bills",status="refunded"} 1');
    });

    it("does not count in-flight or unrecognised statuses", async () => {
      recordOrderTerminal("onramp", "awaiting payment");
      recordOrderTerminal("onramp", "processing");
      recordOrderTerminal("onramp", "something-new");

      const res = await request(app).get("/metrics");

      expect(res.text).not.toContain("orders_terminal_total{");
    });

    it("keeps labels bounded to rail and terminal status", async () => {
      recordOrderTerminal("offramp", "failed");

      const lines = (await registry.metrics())
        .split("\n")
        .filter((line) => line.startsWith("orders_terminal_total{"));

      expect(lines).toHaveLength(1);
      expect(lines[0]).toBe('orders_terminal_total{rail="offramp",status="failed"} 1');
    });

    it("maps provider and webhook spellings to one terminal vocabulary", () => {
      expect(terminalStatusOf("order.completed")).toBe("completed");
      expect(terminalStatusOf("Order Failed")).toBe("failed");
      expect(terminalStatusOf("expired")).toBe("expired");
      expect(terminalStatusOf("canceled")).toBe("cancelled");
      expect(terminalStatusOf("reversed")).toBe("reversed");
      expect(terminalStatusOf("awaiting payment")).toBeNull();
    });

    it("does not read a pending status as the ending it names", () => {
      // These each contain an ending-word. Counting one as terminal would
      // inflate orders_terminal_total and then suppress the real ending,
      // because a transition is only recorded when the previous status was
      // not terminal.
      expect(terminalStatusOf("refund_pending")).toBeNull();
      expect(terminalStatusOf("reversal_pending")).toBeNull();
      expect(terminalStatusOf("cancellation_pending")).toBeNull();
      expect(terminalStatusOf("disbursement_queued")).toBeNull();
      expect(terminalStatusOf("settlement_processing")).toBeNull();

      // The endings themselves still map.
      expect(terminalStatusOf("refunded")).toBe("refunded");
      expect(terminalStatusOf("order.cancelled")).toBe("cancelled");
      expect(terminalStatusOf("payment_failed")).toBe("failed");
    });
  });

  describe("GET /status", () => {
    it("reports last_indexed_ledger alongside the camelCase field", async () => {
      const res = await request(app).get("/status");

      expect(res.status).toBe(200);
      expect(res.body.last_indexed_ledger).toBe(1000);
      expect(res.body.lastIndexedLedger).toBe(1000);
    });
  });

  describe("HTTP metrics middleware", () => {
    it("increments http_requests_total with method, route pattern, and status", async () => {
      await request(app).get("/healthz");
      await request(app).get("/healthz");
      await request(app).post("/healthz"); // 404 since only GET exists

      const res = await request(app).get("/metrics");

      expect(res.text).toContain('http_requests_total{method="GET",route="/healthz",status="200"} 2');
      expect(res.text).toContain('http_requests_total{method="POST",route="unknown",status="404"} 1');
    });

    it("records http_request_duration_seconds with method and route pattern", async () => {
      await request(app).get("/healthz");

      const res = await request(app).get("/metrics");

      expect(res.text).toContain('http_request_duration_seconds_count{method="GET",route="/healthz"} 1');
      expect(res.text).toMatch(/http_request_duration_seconds_sum\{method="GET",route="\/healthz"\} \d+(\.\d+)?/);
    });

    it("uses Express route pattern for parameterized routes", async () => {
      const { queryTransfers } = jest.requireMock("../db");
      queryTransfers.mockResolvedValue({ total: 0, transfers: [], nextCursor: null });

      await request(app).get("/transfers/incoming/GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF");

      const res = await request(app).get("/metrics");

      expect(res.text).toContain('http_requests_total{method="GET",route="/transfers/incoming/:address",status="200"} 1');
    });

    it("excludes /metrics from its own counters", async () => {
      // Reset and hit /metrics a few times
      _resetMetrics();
      await request(app).get("/metrics");
      await request(app).get("/metrics");
      await request(app).get("/metrics");

      const res = await request(app).get("/metrics");

      // /metrics should not appear in the http_requests_total output
      expect(res.text).not.toContain('route="/metrics"');
    });

    it("includes /metrics in the metrics output (the scrape still works)", async () => {
      const res = await request(app).get("/metrics");

      expect(res.status).toBe(200);
      expect(res.text).toContain("# TYPE http_requests_total counter");
      expect(res.text).toContain("# TYPE http_request_duration_seconds histogram");
    });
  });
});
