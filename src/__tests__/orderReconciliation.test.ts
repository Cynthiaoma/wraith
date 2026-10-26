type Row = Record<string, any>;

const tables: { ngnOrder: Row[]; offrampOrder: Row[] } = {
  ngnOrder: [],
  offrampOrder: [],
};

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (key === "OR") return (expected as Row[]).some((part) => matches(row, part));
    if (expected !== null && typeof expected === "object") {
      if ("lt" in expected) {
        const actual = row[key];
        return actual != null && new Date(actual).getTime() < new Date(expected.lt).getTime();
      }
      if ("notIn" in expected) return !(expected.notIn as unknown[]).includes(row[key]);
      throw new Error(`unsupported where operator for ${key}`);
    }
    return row[key] === expected;
  });
}

function model(table: keyof typeof tables) {
  return {
    findMany: jest.fn(async ({ where, orderBy, take }: Row) => {
      const rows = tables[table]
        .filter((row) => matches(row, where))
        .sort((a, b) => {
          if (orderBy?.createdAt === "asc") {
            return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
          }
          return 0;
        });
      return typeof take === "number" ? rows.slice(0, take) : rows;
    }),
    findUnique: jest.fn(async ({ where }: Row) => {
      return (
        tables[table].find((row) =>
          matches(row, {
            network: where.network_orderId.network,
            orderId: where.network_orderId.orderId,
          }),
        ) ?? null
      );
    }),
    update: jest.fn(async ({ where, data }: Row) => {
      const row = tables[table].find((candidate) =>
        matches(candidate, {
          network: where.network_orderId.network,
          orderId: where.network_orderId.orderId,
        }),
      );
      if (!row) throw new Error("Record not found");
      Object.assign(row, data);
      return row;
    }),
  };
}

jest.mock("../db", () => ({
  prisma: { ngnOrder: model("ngnOrder"), offrampOrder: model("offrampOrder") },
}));

jest.mock("../linq/onramp", () => ({ getOnrampStatus: jest.fn() }));
jest.mock("../linq/bills", () => ({ getBillStatus: jest.fn() }));
jest.mock("../linq/client", () => ({ getOfframpStatus: jest.fn() }));

import { getBillStatus } from "../linq/bills";
import { getOfframpStatus } from "../linq/client";
import { getOnrampStatus } from "../linq/onramp";
import {
  isTerminalOrderStatus,
  runOrderReconciliationJob,
} from "../jobs/orderReconciliation";

const mockOnramp = getOnrampStatus as jest.Mock;
const mockBill = getBillStatus as jest.Mock;
const mockOfframp = getOfframpStatus as jest.Mock;

const NOW = new Date("2026-10-23T12:00:00.000Z");
const OLD = new Date("2026-10-23T10:00:00.000Z");

function seedNgn(over: Row = {}): Row {
  const row: Row = {
    id: tables.ngnOrder.length + 1,
    network: "testnet",
    kind: "onramp",
    orderId: `ngn-order-${tables.ngnOrder.length + 1}`,
    customerRef: "customer-ref",
    walletAddress: "GSTUB",
    coin: "xlm",
    amountStableCoin: "25",
    amountNGN: "41250",
    rate: "1650",
    billCategory: null,
    provider: null,
    status: "initiated",
    settledStableCoin: null,
    settledNGN: null,
    txHash: null,
    reconciliationAttempts: 0,
    lastReconciledAt: null,
    needsHuman: false,
    createdAt: OLD,
    updatedAt: OLD,
    ...over,
  };
  tables.ngnOrder.push(row);
  return row;
}

function seedOfframp(over: Row = {}): Row {
  const row: Row = {
    id: tables.offrampOrder.length + 1,
    network: "testnet",
    orderId: `offramp-order-${tables.offrampOrder.length + 1}`,
    publicId: "public-id",
    idempotencyKey: "idem",
    walletAddress: "GSTUB",
    chain: "stellar",
    coin: "usdc",
    depositAddress: "GSTUB",
    amountStableCoin: "25",
    amountNGN: "41250",
    rate: "1650",
    status: "initiated",
    settledStableCoin: null,
    settledNGN: null,
    depositTxHash: null,
    reconciliationAttempts: 0,
    lastReconciledAt: null,
    needsHuman: false,
    createdAt: OLD,
    updatedAt: OLD,
    ...over,
  };
  tables.offrampOrder.push(row);
  return row;
}

const run = (over: Record<string, unknown> = {}) =>
  runOrderReconciliationJob({ now: NOW, ageMs: 1000, ...over });

beforeEach(() => {
  tables.ngnOrder.length = 0;
  tables.offrampOrder.length = 0;
  process.env.STELLAR_NETWORK = "testnet";
  jest.clearAllMocks();
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("order reconciliation sweep", () => {
  it("resolves an order through the webhook's reconciliation path exactly once", async () => {
    const row = seedNgn();
    mockOnramp.mockResolvedValue({
      status: "completed",
      amount: 25,
      amountNgn: 41250,
    });

    const first = await run();

    expect(first).toMatchObject({ checked: 1, resolved: 1 });
    expect(row).toMatchObject({
      status: "completed",
      settledStableCoin: "25",
      settledNGN: "41250",
      reconciliationAttempts: 0,
      lastReconciledAt: NOW,
    });
    expect(mockOnramp).toHaveBeenCalledTimes(1);

    const second = await run();

    expect(second).toMatchObject({ checked: 0, resolved: 0 });
    expect(mockOnramp).toHaveBeenCalledTimes(1);
  });

  it("leaves a still-pending order pending and gives up after the attempt ceiling", async () => {
    const row = seedNgn();
    mockOnramp.mockResolvedValue({
      status: "processing",
      amount: 25,
      amountNgn: 41250,
    });

    const first = await run({ maxAttempts: 3 });
    expect(first).toMatchObject({ checked: 1, pending: 1, flagged: 0 });
    expect(row).toMatchObject({
      status: "processing",
      reconciliationAttempts: 1,
      needsHuman: false,
    });

    const second = await run({ maxAttempts: 3 });
    expect(second).toMatchObject({ checked: 1, pending: 1 });
    expect(row).toMatchObject({ reconciliationAttempts: 2, needsHuman: false });

    const third = await run({ maxAttempts: 3 });
    expect(third).toMatchObject({ checked: 1, flagged: 1 });
    expect(row).toMatchObject({ reconciliationAttempts: 3, needsHuman: true });

    const fourth = await run({ maxAttempts: 3 });
    expect(fourth).toMatchObject({ checked: 0 });
    expect(mockOnramp).toHaveBeenCalledTimes(3);
  });

  it("records a provider outage and flags the order instead of polling forever", async () => {
    const row = seedNgn();
    mockOnramp.mockRejectedValue(new Error("provider unavailable"));

    const first = await run({ maxAttempts: 2 });
    expect(first).toMatchObject({ checked: 1, unavailable: 1, flagged: 0 });
    expect(row).toMatchObject({ reconciliationAttempts: 1, needsHuman: false });

    const second = await run({ maxAttempts: 2 });
    expect(second).toMatchObject({ checked: 1, unavailable: 0, flagged: 1 });
    expect(row).toMatchObject({ reconciliationAttempts: 2, needsHuman: true });

    const third = await run({ maxAttempts: 2 });
    expect(third).toMatchObject({ checked: 0 });
    expect(mockOnramp).toHaveBeenCalledTimes(2);
  });

  it("uses the shared offramp reconciliation and its status endpoint", async () => {
    const row = seedOfframp();
    mockOfframp.mockResolvedValue({
      status: "settled",
      amountStableCoin: 50,
      amountNGN: 82500,
    });

    const result = await run();

    expect(result).toMatchObject({ checked: 1, resolved: 1 });
    expect(row).toMatchObject({
      status: "settled",
      settledStableCoin: "50",
      settledNGN: "82500",
    });
    expect(mockOnramp).not.toHaveBeenCalled();
  });

  it("never spends more provider calls than the configured ceiling", async () => {
    seedNgn({ orderId: "a", createdAt: new Date(OLD.getTime()) });
    seedNgn({ orderId: "b", createdAt: new Date(OLD.getTime() + 1000) });
    seedNgn({ orderId: "c", createdAt: new Date(OLD.getTime() + 2000) });
    mockOnramp.mockResolvedValue({ status: "processing", amount: 1, amountNgn: 1 });

    const result = await run({ pageSize: 10, maxProviderCalls: 2 });

    expect(result).toMatchObject({ scanned: 3, checked: 2 });
    expect(mockOnramp).toHaveBeenCalledTimes(2);
    expect(tables.ngnOrder[0].reconciliationAttempts).toBe(1);
    expect(tables.ngnOrder[1].reconciliationAttempts).toBe(1);
    expect(tables.ngnOrder[2].reconciliationAttempts).toBe(0);
  });

  it("treats a bill through its own status endpoint", async () => {
    const row = seedNgn({ kind: "bill", orderId: "bill-1" });
    mockBill.mockResolvedValue({
      status: "completed",
      amountStableCoin: 10,
      amountNgn: 16500,
    });

    const result = await run();

    expect(result).toMatchObject({ checked: 1, resolved: 1 });
    expect(mockBill).toHaveBeenCalledWith(row.customerRef, row.orderId);
    expect(mockOnramp).not.toHaveBeenCalled();
    expect(row).toMatchObject({ status: "completed", settledNGN: "16500" });
  });

  it("recognises the provider's terminal vocabulary", () => {
    for (const status of ["completed", "settled", "disbursed", "failed", "expired", "refunded", "cancelled"]) {
      expect(isTerminalOrderStatus(status)).toBe(true);
    }
    for (const status of ["initiated", "pending", "waiting_for_deposit", "processing"]) {
      expect(isTerminalOrderStatus(status)).toBe(false);
    }
  });

  it("does not read a still-moving status as terminal for a word inside it", () => {
    // A substring match called every one of these terminal. A terminal status
    // resets the attempt counter, so each would have been re-checked on every
    // sweep forever and never reached needsHuman.
    for (const status of [
      "incomplete",
      "refund_pending",
      "reversal_pending",
      "cancellation_pending",
      "awaiting_settlement",
      "disbursement_queued",
    ]) {
      expect(isTerminalOrderStatus(status)).toBe(false);
    }

    // Still terminal, including compound and upper-case forms.
    for (const status of ["payment_failed", "successful", "disbursement_complete", "REFUNDED"]) {
      expect(isTerminalOrderStatus(status)).toBe(true);
    }
  });
});
