import express from "express";
import request from "supertest";

type Row = Record<string, any>;

const tables: Record<"offrampOrder" | "ngnOrder", Row[]> = {
  offrampOrder: [],
  ngnOrder: [],
};

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (expected !== null && typeof expected === "object") {
      return Object.entries(expected as Row).every(
        ([field, value]) => row[field] === value,
      );
    }
    return row[key] === expected;
  });
}

function model(table: keyof typeof tables) {
  return {
    findUnique: jest.fn(async ({ where }: { where: Row }) => {
      await new Promise((resolve) => setImmediate(resolve));
      return tables[table].find((row) => matches(row, where)) ?? null;
    }),
    findFirst: jest.fn(() => {
      throw new Error("webhook lookups must use the compound key");
    }),
    update: jest.fn(async ({ where, data }: { where: Row; data: Row }) => {
      await new Promise((resolve) => setImmediate(resolve));
      const row = tables[table].find((candidate) => matches(candidate, where));
      if (!row) throw new Error("Record not found");
      Object.assign(row, data);
      return row;
    }),
  };
}

jest.mock("../../db", () => ({
  prisma: {
    offrampOrder: model("offrampOrder"),
    ngnOrder: model("ngnOrder"),
  },
}));

import { createLinqWebhookRouter } from "../../api/linqWebhook";
import { prisma } from "../../db";
import { computeSignature, SIGNATURE_HEADER } from "../../linq/webhook";

const SECRET = "whsec_stub_293";
const ORDER_ID = "stub-order-collision-293";
const WALLET = "GSTUBWALLET293";
const CUSTOMER_REF = "stub-customer-293";

function seedNgn(network: string): Row {
  const row: Row = {
    id: tables.ngnOrder.length + 1,
    network,
    kind: "onramp",
    orderId: ORDER_ID,
    customerRef: CUSTOMER_REF,
    walletAddress: WALLET,
    coin: "usdc",
    amountStableCoin: "25",
    amountNGN: "41250",
    rate: "1650",
    status: "initiated",
  };
  tables.ngnOrder.push(row);
  return row;
}

function seedOfframp(network: string): Row {
  const row: Row = {
    id: tables.offrampOrder.length + 1,
    network,
    orderId: ORDER_ID,
    publicId: `stub-public-${network}`,
    idempotencyKey: `stub-idem-${network}`,
    walletAddress: WALLET,
    chain: "stellar",
    coin: "usdc",
    depositAddress: `stub-deposit-${network}`,
    amountStableCoin: "25",
    amountNGN: "41250",
    rate: "1650",
    status: "initiated",
  };
  tables.offrampOrder.push(row);
  return row;
}

function makeApp(): express.Express {
  const app = express();
  app.use("/webhooks/linq", createLinqWebhookRouter());
  app.use(express.json());
  return app;
}

function deliver(app: express.Express, event: Record<string, unknown>) {
  const raw = JSON.stringify(event);
  return request(app)
    .post("/webhooks/linq")
    .set("Content-Type", "application/json")
    .set(SIGNATURE_HEADER, computeSignature(raw, SECRET))
    .send(raw);
}

async function reconciled(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const originalNetwork = process.env.STELLAR_NETWORK;

beforeEach(() => {
  tables.offrampOrder.length = 0;
  tables.ngnOrder.length = 0;
  process.env.LINQ_WEBHOOK_SECRET = SECRET;
  delete process.env.STELLAR_NETWORK;
  jest.clearAllMocks();
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(() => {
  delete process.env.LINQ_WEBHOOK_SECRET;
  if (originalNetwork === undefined) {
    delete process.env.STELLAR_NETWORK;
  } else {
    process.env.STELLAR_NETWORK = originalNetwork;
  }
});

describe("Linq webhook order resolution", () => {
  it("reconciles only the NGN row whose network matches the event", async () => {
    const testnet = seedNgn("testnet");
    const mainnet = seedNgn("mainnet");

    const res = await deliver(makeApp(), {
      event: "order.completed",
      orderId: ORDER_ID,
      network: "mainnet",
      status: "completed",
      amountStableCoin: 25,
      amountNGN: 41250,
      txHash: "stub-mainnet-tx",
    });

    expect(res.status).toBe(200);
    await reconciled();

    expect(mainnet).toMatchObject({
      status: "completed",
      settledStableCoin: "25",
      settledNGN: "41250",
      txHash: "stub-mainnet-tx",
    });
    expect(testnet).toMatchObject({ status: "initiated" });
    expect(testnet.settledStableCoin).toBeUndefined();
    expect(testnet.settledNGN).toBeUndefined();
    expect(testnet.txHash).toBeUndefined();
    expect(prisma.ngnOrder.findFirst).not.toHaveBeenCalled();
    expect(prisma.ngnOrder.findUnique).toHaveBeenCalledWith({
      where: { network_orderId: { network: "mainnet", orderId: ORDER_ID } },
    });
  });

  it("reconciles only the offramp row whose network matches the event", async () => {
    const testnet = seedOfframp("testnet");
    const mainnet = seedOfframp("mainnet");

    const res = await deliver(makeApp(), {
      event: "order.completed",
      orderId: ORDER_ID,
      network: "testnet",
      status: "completed",
      amountStableCoin: 25,
      amountNGN: 41250,
      txHash: "stub-testnet-tx",
    });

    expect(res.status).toBe(200);
    await reconciled();

    expect(testnet).toMatchObject({
      status: "completed",
      settledStableCoin: "25",
      settledNGN: "41250",
      depositTxHash: "stub-testnet-tx",
    });
    expect(mainnet).toMatchObject({ status: "initiated" });
    expect(mainnet.settledStableCoin).toBeUndefined();
    expect(mainnet.settledNGN).toBeUndefined();
    expect(mainnet.depositTxHash).toBeUndefined();
    expect(prisma.offrampOrder.findFirst).not.toHaveBeenCalled();
    expect(prisma.offrampOrder.findUnique).toHaveBeenCalledWith({
      where: { network_orderId: { network: "testnet", orderId: ORDER_ID } },
    });
    expect(prisma.ngnOrder.findUnique).not.toHaveBeenCalled();
  });

  it("uses the configured network when the event omits one", async () => {
    process.env.STELLAR_NETWORK = "mainnet";
    const testnet = seedNgn("testnet");
    const mainnet = seedNgn("mainnet");

    const res = await deliver(makeApp(), {
      event: "order.completed",
      orderId: ORDER_ID,
      status: "completed",
      amountStableCoin: 25,
      amountNGN: 41250,
      txHash: "stub-default-network-tx",
    });

    expect(res.status).toBe(200);
    await reconciled();

    expect(mainnet).toMatchObject({
      status: "completed",
      txHash: "stub-default-network-tx",
    });
    expect(testnet).toMatchObject({ status: "initiated" });
    expect(testnet.txHash).toBeUndefined();
    expect(prisma.ngnOrder.findUnique).toHaveBeenCalledWith({
      where: { network_orderId: { network: "mainnet", orderId: ORDER_ID } },
    });
  });

  it("does not act on an event that names an invalid network", async () => {
    process.env.STELLAR_NETWORK = "mainnet";
    const mainnet = seedNgn("mainnet");

    const res = await deliver(makeApp(), {
      event: "order.completed",
      orderId: ORDER_ID,
      network: "devnet",
      status: "completed",
      amountStableCoin: 25,
      amountNGN: 41250,
      txHash: "stub-invalid-network-tx",
    });

    expect(res.status).toBe(200);
    await reconciled();

    expect(mainnet).toMatchObject({ status: "initiated" });
    expect(mainnet.txHash).toBeUndefined();
    expect(prisma.offrampOrder.findUnique).not.toHaveBeenCalled();
    expect(prisma.ngnOrder.findUnique).not.toHaveBeenCalled();
  });
});
