/**
 * Drift detection: the fake provider's actual responses must match the pinned
 * shapes in `fixtures/linq/provider-shapes.json`.
 *
 * ## Why this test exists
 *
 * Every belief about Linq's response shape lives in two places: the fixture
 * file (what the provider documents) and the fake provider (what we simulate).
 * They can silently diverge when someone corrects a field name in one place but
 * forgets the other. This file fails CI the moment that happens.
 *
 * The check is structural: every key listed in `successShape` must be present
 * in the fake's actual response, and its runtime value must be the correct
 * JavaScript type. No extra fields are forbidden — Linq may send more than the
 * minimum, and so may the fake — but the documented minimum must always be
 * there.
 *
 * ## What this does NOT test
 *
 * - Business logic (idempotency, deduplication). Those live in idempotency.test.ts.
 * - Error paths. The fake's fault injection is tested in idempotency.test.ts.
 * - Field *values*. The shapes pin field names and types, not specific values,
 *   because the fake uses generated UUIDs and counters for identifiers.
 */

import { createOfframpOrder } from "../../linq/client";
import { createOnrampOrder, provisionCustomer } from "../../linq/onramp";
import { payBill } from "../../linq/bills";
import {
  installFakeLinq,
  providerShapes,
  shapeFor,
  type FakeLinq,
} from "../fakes/linqProvider";

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Assert that `actual` contains every key listed in `shape`, and that each
 * value's JavaScript type matches the shape's type annotation.
 *
 * Fails with a descriptive message for each missing or wrongly-typed field, so
 * a reviewer reading the CI output immediately sees what drifted.
 */
function assertMatchesShape(
  actual: Record<string, unknown>,
  shape: Record<string, string>,
  label: string,
): void {
  for (const [field, expectedType] of Object.entries(shape)) {
    if (!(field in actual)) {
      throw new Error(`${label}: missing field "${field}" (expected type "${expectedType}")`);
    }
    const actualType = typeof actual[field];
    if (actualType !== expectedType) {
      throw new Error(
        `${label}.${field}: expected type "${expectedType}", got "${actualType}"`,
      );
    }
  }
}

/** Cast any typed value through `unknown` to `Record<string, unknown>` for shape checking. */
function toRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

// ── Test data ─────────────────────────────────────────────────────────────

// Plainly fake. None of these identify anyone.
const CUSTOMER_PARAMS = {
  customerRef: "fake_ref_shape_test_0001",
  firstName: "Shape",
  lastName: "Test",
  email: "shape.test@example.com",
  phone: "00000000000",
};

const OFFRAMP_PARAMS = {
  amountStableCoin: 50,
  bankAccount: "0000000000",
  bankCode: "000",
  bankName: "Fake Bank",
  accountName: "Shape Test",
  customerRef: "GFAKEWALLET0000000000000000000000000000000000000000000000000",
  idempotencyKey: "idem-shape-test-0001",
};

const ONRAMP_PARAMS = {
  customerRef: "fake_ref_shape_test_0001",
  amountStableCoin: 10,
  walletAddress: "GFAKEWALLET0000000000000000000000000000000000000000000000000",
  rate: 1500,
  coin: "usdc" as const,
};

const BILL_PARAMS = {
  customerRef: "fake_ref_shape_test_0001",
  billCategory: "airtime" as const,
  provider: "MTN",
  customerId: "00000000000",
  amountNgn: 1000,
  amountStableCoin: 0.67,
  rate: 1500,
  coin: "usdc" as const,
  refundAddress: "GFAKEWALLET0000000000000000000000000000000000000000000000000",
};

// ── Test suite ────────────────────────────────────────────────────────────

let linq: FakeLinq;

beforeEach(() => {
  process.env.LINQ_API_KEY = "biz_live_test";
  linq = installFakeLinq();
  // The fake logs warnings for injected faults; not this test's concern.
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  // Nothing in this suite should stray to an unimplemented path.
  expect(linq.unhandled).toEqual([]);
  linq.restore();
});

// ── Fixture file integrity ────────────────────────────────────────────────

describe("fixtures/linq/provider-shapes.json integrity", () => {
  it("contains an entry for every endpoint the fake implements", () => {
    const implementedEndpoints = [
      "POST /b2b/customers",
      "POST /b2b/offramp",
      "POST /b2b/onramp",
      "POST /b2b/bills/pay",
    ];
    for (const endpoint of implementedEndpoints) {
      expect(providerShapes.endpoints).toHaveProperty(endpoint);
      const ep = providerShapes.endpoints[endpoint];
      expect(typeof ep.provenance).toBe("string");
      expect(typeof ep.documentedOn).toBe("string");
      expect(typeof ep.source).toBe("string");
      expect(typeof ep.successShape).toBe("object");
      expect(typeof ep.examples).toBe("object");
    }
  });

  it("every successShape field maps to a valid JavaScript type name", () => {
    const validTypes = new Set(["string", "number", "boolean", "object", "array"]);
    for (const [endpoint, ep] of Object.entries(providerShapes.endpoints)) {
      for (const [field, type] of Object.entries(ep.successShape)) {
        expect(validTypes.has(type)).toBe(true);
        if (!validTypes.has(type)) {
          throw new Error(
            `${endpoint}.successShape.${field} has unknown type "${type}"`,
          );
        }
      }
    }
  });

  it("every endpoint has at least one example", () => {
    for (const [endpoint, ep] of Object.entries(providerShapes.endpoints)) {
      expect(Object.keys(ep.examples).length).toBeGreaterThan(0);
    }
  });

  it("no fixture contains a NIN (11-digit run or a 'nin' key)", () => {
    const raw = JSON.stringify(providerShapes);
    // An 11-digit run is the shape of a Nigerian NIN.
    expect(raw).not.toMatch(/\b\d{11}\b/);
    // The key name itself.
    expect(raw.toLowerCase()).not.toContain('"nin"');
  });

  it("no fixture contains an API key pattern", () => {
    const raw = JSON.stringify(providerShapes);
    // Linq API keys start with biz_live_ or biz_test_.
    expect(raw).not.toMatch(/biz_(live|test)_/);
  });

  it("every example satisfies its own successShape", () => {
    for (const [endpoint, ep] of Object.entries(providerShapes.endpoints)) {
      for (const [exampleName, example] of Object.entries(ep.examples)) {
        for (const [field, expectedType] of Object.entries(ep.successShape)) {
          if (!(field in example)) {
            throw new Error(
              `${endpoint}.examples.${exampleName} is missing field "${field}"`,
            );
          }
          const actualType = typeof example[field];
          if (actualType !== expectedType) {
            throw new Error(
              `${endpoint}.examples.${exampleName}.${field}: expected type "${expectedType}", got "${actualType}"`,
            );
          }
        }
      }
    }
  });

  it("shapeFor() returns the correct successShape for a known endpoint", () => {
    const shape = shapeFor("POST /b2b/customers");
    expect(shape).toEqual(providerShapes.endpoints["POST /b2b/customers"].successShape);
  });

  it("shapeFor() throws for an unknown endpoint", () => {
    expect(() => shapeFor("POST /b2b/nonexistent")).toThrow(
      "No fixture shape for endpoint: POST /b2b/nonexistent",
    );
  });
});

// ── Drift detection: fake response vs. fixture shape ────────────────────────

describe("POST /b2b/customers — fake response matches fixture shape", () => {
  it("new customer creation response has all successShape fields with correct types", async () => {
    const result = await provisionCustomer(CUSTOMER_PARAMS);
    assertMatchesShape(
      toRecord(result),
      shapeFor("POST /b2b/customers"),
      "POST /b2b/customers (created=true)",
    );
  });

  it("existing customer response (created:false) has all successShape fields with correct types", async () => {
    // Create once, then provision again to trigger the idempotent path.
    await provisionCustomer(CUSTOMER_PARAMS);
    const result = await provisionCustomer(CUSTOMER_PARAMS);

    assertMatchesShape(
      toRecord(result),
      shapeFor("POST /b2b/customers"),
      "POST /b2b/customers (created=false)",
    );
    expect(result.created).toBe(false);
  });
});

describe("POST /b2b/offramp — fake response matches fixture shape", () => {
  it("order creation response has all successShape fields with correct types", async () => {
    const result = await createOfframpOrder(OFFRAMP_PARAMS);
    assertMatchesShape(
      toRecord(result),
      shapeFor("POST /b2b/offramp"),
      "POST /b2b/offramp",
    );
  });

  it("idempotent response (same key) also satisfies the shape", async () => {
    const first = await createOfframpOrder(OFFRAMP_PARAMS);
    const second = await createOfframpOrder(OFFRAMP_PARAMS);

    assertMatchesShape(
      toRecord(second),
      shapeFor("POST /b2b/offramp"),
      "POST /b2b/offramp (idempotent)",
    );
    // Confirm deduplication: the returned order is identical.
    expect(second.id).toBe(first.id);
  });
});

describe("POST /b2b/onramp — fake response matches fixture shape", () => {
  it("order creation response has all successShape fields with correct types", async () => {
    const result = await createOnrampOrder(ONRAMP_PARAMS);
    assertMatchesShape(
      toRecord(result),
      shapeFor("POST /b2b/onramp"),
      "POST /b2b/onramp",
    );
  });
});

describe("POST /b2b/bills/pay — fake response matches fixture shape", () => {
  it("bill order creation response has all successShape fields with correct types", async () => {
    const result = await payBill(BILL_PARAMS);
    assertMatchesShape(
      toRecord(result),
      shapeFor("POST /b2b/bills/pay"),
      "POST /b2b/bills/pay",
    );
  });
});

// ── Completeness: every fixture endpoint is covered by a drift test ──────────

describe("completeness: every fixture endpoint has a drift test above", () => {
  // If a new endpoint is added to provider-shapes.json, this test reminds the
  // author to add a corresponding drift-detection describe block above.
  it("the set of fixture endpoints matches the set of endpoints tested here", () => {
    const fixtureEndpoints = Object.keys(providerShapes.endpoints).sort();
    const testedEndpoints = [
      "POST /b2b/bills/pay",
      "POST /b2b/customers",
      "POST /b2b/offramp",
      "POST /b2b/onramp",
    ].sort();
    expect(fixtureEndpoints).toEqual(testedEndpoints);
  });
});
