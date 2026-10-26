/**
 * Exact-shape tests for the JSON:API envelope (#321).
 *
 * `jsonApiMiddleware` sits in front of every route, so these assert whole
 * documents with `toEqual` rather than spot-checking a field: an extra or
 * missing key is a contract change for every JSON:API client.
 */
import request from "supertest";
import express, { Request, Response, NextFunction } from "express";
import { jsonApiMiddleware, transformToJsonApi } from "../middleware/jsonapi";

const JSONAPI = "application/vnd.api+json";

/**
 * The stale-read middleware from `api.ts`, reduced to what it does to a body.
 * Mounted after `jsonApiMiddleware`, exactly as in `createApp`, so its wrapper
 * runs first and the envelope sees the annotated body.
 */
function staleRead(req: Request, res: Response, next: NextFunction): void {
  res.setHeader("X-Data-Stale", "true");
  res.setHeader("X-As-Of-Ledger", "500");
  const originalJson = res.json.bind(res);
  res.json = (body: any) => {
    if (body && typeof body === "object" && !Array.isArray(body) && body.error === undefined) {
      if (body.stale === undefined) body.stale = true;
      if (body.indexer_running === undefined) body.indexer_running = false;
      if (body.as_of_ledger === undefined) body.as_of_ledger = 500;
    }
    return originalJson(body);
  };
  next();
}

function makeApp(opts: { stale?: boolean } = {}) {
  const app = express();
  app.use(express.json());
  app.use(jsonApiMiddleware);
  if (opts.stale) app.use(staleRead);
  return app;
}

describe("JSON:API envelope — exact shapes", () => {
  it("wraps a single object as one resource with empty meta", async () => {
    const app = makeApp();
    app.get("/status", (_req, res) => res.json({ ok: true, status: "healthy" }));

    const res = await request(app).get("/status").set("Accept", JSONAPI);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain(JSONAPI);
    expect(res.body).toEqual({
      data: { id: "", type: "status", attributes: { ok: true, status: "healthy" } },
      meta: {},
    });
  });

  it("wraps an object on an unknown route as a generic resource", async () => {
    const app = makeApp();
    app.get("/whatever", (_req, res) => res.json({ a: 1 }));

    const res = await request(app).get("/whatever").set("Accept", JSONAPI);

    expect(res.body).toEqual({ data: { id: "1", type: "generic", attributes: { a: 1 } }, meta: {} });
  });

  it("wraps a collection with every pagination field in meta", async () => {
    const app = makeApp();
    app.get("/transfers/address/:a", (_req, res) =>
      res.json({
        transfers: [{ eventId: "e1", amount: "1" }],
        total: 1,
        hasMore: false,
        limit: 10,
        offset: 0,
        nextCursor: "c1",
      }),
    );

    const res = await request(app).get("/transfers/address/G").set("Accept", JSONAPI);

    expect(res.body).toEqual({
      data: [{ id: "e1", type: "transfer", attributes: { eventId: "e1", amount: "1" } }],
      meta: { total: 1, hasMore: false, limit: 10, offset: 0, nextCursor: "c1" },
    });
  });

  it("answers an empty collection with an empty data array, not null", async () => {
    const app = makeApp();
    app.get("/transfers/address/:a", (_req, res) => res.json({ transfers: [], total: 0 }));

    const res = await request(app).get("/transfers/address/G").set("Accept", JSONAPI);

    expect(res.body).toEqual({ data: [], meta: { total: 0 } });
  });

  it("answers an error body with an errors array carrying the HTTP status", async () => {
    const app = makeApp();
    app.get("/accounts/:a", (_req, res) => res.status(404).json({ error: "Not found" }));

    const res = await request(app).get("/accounts/G").set("Accept", JSONAPI);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ errors: [{ status: "404", title: "Error", detail: "Not found" }] });
  });

  it("serialises Dates and bigints inside attributes", () => {
    const doc = transformToJsonApi(
      { transfers: [{ eventId: "e1", at: new Date("2026-01-01T00:00:00Z"), amount: 5n }] },
      "/transfers/tx/abc",
    );
    expect(doc).toEqual({
      data: [{ id: "e1", type: "transfer", attributes: { eventId: "e1", at: "2026-01-01T00:00:00.000Z", amount: "5" } }],
      meta: {},
    });
  });

  it("leaves non-GET and non-JSON:API requests untouched", async () => {
    const app = makeApp();
    app.get("/x", (_req, res) => res.json({ a: 1 }));
    app.post("/x", (_req, res) => res.json({ a: 1 }));

    expect((await request(app).get("/x")).body).toEqual({ a: 1 });
    expect((await request(app).post("/x").set("Accept", JSONAPI).send({})).body).toEqual({ a: 1 });
  });
});

describe("JSON:API envelope — bodies already in shape, or not objects", () => {
  it("passes a document that is already JSON:API through unchanged", async () => {
    const already = { data: [{ id: "1", type: "thing", attributes: { a: 1 } }], meta: { total: 1 } };
    const app = makeApp();
    app.get("/x", (_req, res) => res.json(already));

    const res = await request(app).get("/x").set("Accept", JSONAPI);

    expect(res.body).toEqual(already);
  });

  it("passes an existing errors document through unchanged", () => {
    const already = { errors: [{ status: "400", title: "Bad" }] };
    expect(transformToJsonApi(already, "/x", 400)).toEqual(already);
  });

  it("does not mistake an ordinary body with a `data` field for a document", () => {
    expect(transformToJsonApi({ data: 1, other: 2 }, "/x")).toEqual({
      data: { id: "1", type: "generic", attributes: { data: 1, other: 2 } },
      meta: {},
    });
  });

  it("wraps a bare array as a collection", () => {
    expect(transformToJsonApi([{ id: "a", v: 1 }, 7, null], "/x")).toEqual({
      data: [{ id: "a", type: "generic", attributes: { v: 1 } }],
    });
  });

  it.each([
    ["null", null],
    ["a string", "hello"],
    ["a number", 42],
    ["a boolean", true],
    ["an empty string", ""],
  ])("answers %s with data: null", (_label, value) => {
    expect(transformToJsonApi(value, "/status")).toEqual({ data: null });
  });

  it("answers a primitive over HTTP with data: null", async () => {
    const app = makeApp();
    app.get("/x", (_req, res) => res.json("hello"));

    const res = await request(app).get("/x").set("Accept", JSONAPI);

    expect(res.body).toEqual({ data: null });
  });
});

describe("JSON:API envelope with the stale-read wrapper", () => {
  it("moves the stale markers into meta on a single resource, out of attributes", async () => {
    const app = makeApp({ stale: true });
    app.get("/status", (_req, res) => res.json({ ok: true }));

    const res = await request(app).get("/status").set("Accept", JSONAPI);

    expect(res.headers["x-data-stale"]).toBe("true");
    expect(res.headers["x-as-of-ledger"]).toBe("500");
    expect(res.body).toEqual({
      data: { id: "", type: "status", attributes: { ok: true } },
      meta: { stale: true, indexer_running: false, as_of_ledger: 500 },
    });
  });

  it("keeps the stale markers on a collection, beside the pagination meta", async () => {
    const app = makeApp({ stale: true });
    app.get("/transfers/address/:a", (_req, res) => res.json({ transfers: [], total: 0 }));

    const res = await request(app).get("/transfers/address/G").set("Accept", JSONAPI);

    expect(res.body).toEqual({
      data: [],
      meta: { total: 0, stale: true, indexer_running: false, as_of_ledger: 500 },
    });
  });

  it("does not attach stale markers to an error", async () => {
    const app = makeApp({ stale: true });
    app.get("/accounts/:a", (_req, res) => res.status(400).json({ error: "bad" }));

    const res = await request(app).get("/accounts/G").set("Accept", JSONAPI);

    expect(res.body).toEqual({ errors: [{ status: "400", title: "Error", detail: "bad" }] });
  });

  it("leaves the plain-JSON stale body exactly as the wrapper wrote it", async () => {
    const app = makeApp({ stale: true });
    app.get("/status", (_req, res) => res.json({ ok: true }));

    const res = await request(app).get("/status");

    expect(res.body).toEqual({ ok: true, stale: true, indexer_running: false, as_of_ledger: 500 });
  });
});
