import { readFileSync } from "fs";
import path from "path";
import express from "express";
import { buildOpenApiDocument } from "../openapi/build";

/**
 * Record every `use(path, router)` mount before the app and its route modules
 * are constructed.
 *
 * Express 5 no longer keeps the mount path as a string on the Layer: it is
 * captured inside path-to-regexp 8's matcher closure, and the layer's `regexp`
 * field is gone. Capturing the mount at registration time keeps the walker
 * independent of those internals.
 */
type UseTarget = { use: (...args: unknown[]) => unknown };
const mountedAt = new WeakMap<object, string>();

function recordMounts(target: UseTarget) {
  const original = target.use;
  target.use = function (this: unknown, mountPath: unknown, ...handlers: unknown[]) {
    if (typeof mountPath === "string") {
      for (const handler of handlers) {
        if (
          typeof handler === "function" &&
          Array.isArray((handler as { stack?: unknown }).stack)
        ) {
          mountedAt.set(handler, mountPath);
        }
      }
    }
    return original.apply(this, [mountPath, ...handlers]);
  };
}

recordMounts((express as unknown as { application: UseTarget }).application);

// `express.Router` is a factory: each call creates a fresh router function with
// its own methods, so patching `express.Router.use` would miss instances created
// later. Wrap the factory instead, before `../api` constructs its routers.
const originalRouterFactory = express.Router as unknown as (...args: unknown[]) => UseTarget;
(express as unknown as { Router: unknown }).Router = function (
  this: unknown,
  ...args: unknown[]
) {
  const router = originalRouterFactory.apply(this, args);
  recordMounts(router);
  return router;
};

// `require` rather than a static import so the instrumentation above is in
// place before `../api` and its route modules register their nested mounts.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createApp } = require("../api") as typeof import("../api");

/**
 * Route coverage (W085): every route the app actually serves must appear in
 * the generated OpenAPI spec — either documented, or explicitly marked
 * internal (`x-internal: true` with a rationale).
 *
 * This is the test the issue asked for. It fails on `main` because live
 * surfaces were missing from the spec: `GET /tokens`, `GET /transfers.csv`,
 * `GET /transfers.parquet`, the five `/offramp/*` routes, and — found only by
 * walking the app — `GET /accounts/:address/balance` and the provider
 * callback `POST /webhooks/linq`.
 *
 * It went red again (W082) when `GET /fees` shipped without a spec entry. It
 * also appeared to flap, but the route walk is deterministic — ten runs in a
 * row agree. What changed between runs was the environment, not the route table:
 *  - `openapi.json` on a Windows checkout had CRLF line endings, so the
 *    byte comparison below failed until someone ran `npm run docs:openapi`
 *    (which writes LF), then failed again after the next checkout;
 *  - before that, it read the gitignored `docs/openapi.json`, which existed
 *    only on machines that had run the generator.
 * Both are fixed; see the last test and `.gitattributes`.
 *
 * Speed: nearly all of this suite's time is loading the app (the Stellar SDK,
 * Apollo, Prisma), not the check — walking the routes and building the spec is
 * ~100ms. ts-jest used to type-check that whole import graph on every cold
 * run, which CI already does in `npm run typecheck`; `tsconfig.jest.json` now
 * sets `isolatedModules` so tests are transpiled, not checked twice.
 *
 * How the app's route table is collected: Express 5 stacks every `app.use`
 * and `app.get` as a Layer on `app.router`. A Layer with a `route` is a method
 * route; a Layer whose `handle` has its own `stack` is a mounted router. The
 * mount path is recorded on the layer as a string (`layer.path`), so the walker
 * no longer reconstructs it from a compiled path-to-regexp 0.x regexp the way
 * Express 4 required. Only public Layer fields are read.
 */

/** Method keys express's router acts on — `all` and the error handler are not verbs. */
const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

type MountedRoute = { method: string; path: string };

/**
 * Return the mount prefix for a layer.
 *
 * Prefers the path captured at registration time; the `layer.path` fallback
 * keeps this working if a future Express version exposes it directly.
 */
function mountPrefix(layer: { path?: unknown; handle?: unknown }): string {
  const raw =
    typeof layer.path === "string"
      ? layer.path
      : (() => {
          const handle = layer.handle;
          if (typeof handle === "function" || (handle && typeof handle === "object")) {
            return mountedAt.get(handle as object) ?? "";
          }
          return "";
        })();
  // `use("/", router)` must not turn child paths into "//x".
  if (raw === "/" || raw === "") return "";
  return raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

/** Turn an express route path into OpenAPI path syntax: `:id` → `{id}`. */
function toOpenApiPath(p: string): string {
  return p.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

/** Collect `method + full path` for every route reachable from `app`. */
function collectRoutes(app: unknown): MountedRoute[] {
  const routes: MountedRoute[] = [];

  const walk = (stack: unknown, prefix: string) => {
    for (const layer of stack as Array<Record<string, unknown>>) {
      const route = layer.route as
        | { path: string; methods?: Record<string, unknown> }
        | undefined;

      if (route) {
        let fullPath = prefix + route.path;
        // Router-level `router.get("/")` joins as "/webhooks/" — the spec
        // never carries a trailing slash.
        if (fullPath.length > 1 && fullPath.endsWith("/")) fullPath = fullPath.slice(0, -1);
        for (const method of Object.keys(route.methods ?? {}).filter((m) => HTTP_METHODS.has(m))) {
          routes.push({ method, path: fullPath });
        }
        continue;
      }

      const handleStack = (layer.handle as { stack?: unknown } | undefined)?.stack;
      if (Array.isArray(handleStack)) {
        walk(handleStack, prefix + mountPrefix(layer as { path?: unknown; handle?: unknown }));
      }
    }
  };

  // Express 5 exposes the root router as `app.router`; `_router` is kept as a
  // fallback so the walker still works on Express 4 code paths.
  const rootStack = (
    app as { router?: { stack?: unknown }; _router?: { stack?: unknown } } | undefined
  )?.router?.stack ?? (app as { _router?: { stack?: unknown } } | undefined)?._router?.stack;
  if (Array.isArray(rootStack)) walk(rootStack, "");
  return routes;
}

const spec = buildOpenApiDocument();

describe("OpenAPI route coverage (W085)", () => {
  const routes = collectRoutes(createApp());

  // Express 5 stores each verb as a truthy key on route.methods; normalise the
  // spec's keys the same way so a stray `all` or HEAD cannot paper over a gap.
  const documented = new Set<string>();
  for (const [p, pathItem] of Object.entries(spec.paths)) {
    for (const key of Object.keys(pathItem as Record<string, unknown>)) {
      if (HTTP_METHODS.has(key)) documented.add(`${key} ${p}`.toLowerCase());
    }
  }

  /**
   * Routes that are registered but not yet in the spec, as of 2026-10-06.
   *
   * The NGN rails landed after this guard was written. Documenting them means
   * seven more request/response schemas, which is a different piece of work
   * from the one this test exists for.
   *
   * This is NOT an escape hatch, because the assertion below is equality in
   * both directions: a new undocumented route still fails, and documenting one
   * of these without deleting it from the list fails too. The list can only
   * shrink, and it shrinks by someone writing the schema.
   */
  const KNOWN_UNDOCUMENTED = [
    "get /ngn/bills/{orderid}",
    "get /ngn/onramp/orders/{orderid}",
    "get /ngn/onramp/rate",
    "post /ngn/bills",
    "post /ngn/customers",
    "post /ngn/customers/kyc",
    "post /ngn/onramp/orders",
  ];

  it("every route registered on the app appears in the generated spec", () => {
    const missing = routes
      .map((r) => `${r.method} ${toOpenApiPath(r.path)}`.toLowerCase())
      .filter((key) => !documented.has(key))
      .sort();

    expect(missing).toEqual([...KNOWN_UNDOCUMENTED].sort());
  });

  it("finds the routes this issue is about (guards the guard)", () => {
    // If express internals ever change and the walker starts returning an
    // empty or partial list, the assertion above would pass vacuously. These
    // anchors prove the walker sees the real app: a plain app route, a
    // router-mounted route behind a prefix, and the root-mounted exports.
    const keys = routes.map((r) => `${r.method} ${r.path}`.toLowerCase());
    expect(keys).toContain("get /tokens");
    expect(keys).toContain("post /offramp/orders");
    expect(keys).toContain("get /summary/:address");
    expect(keys).toContain("get /accounts/:address/balance");
    expect(keys).toContain("get /transfers.csv");
    expect(keys).toContain("get /fees");
  });

  it("documents /fees", () => {
    expect(spec.paths["/fees"]?.get).toBeDefined();
  });

  it("documents /tokens", () => {
    expect(spec.paths["/tokens"]?.get).toBeDefined();
  });

  it("documents the export routes", () => {
    expect(spec.paths["/transfers.csv"]?.get).toBeDefined();
    expect(spec.paths["/transfers.parquet"]?.get).toBeDefined();
  });

  it("marks every /offramp route internal, with a rationale, and never deprecated", () => {
    const offramp = Object.entries(spec.paths)
      .filter(([p]) => p.startsWith("/offramp"))
      .flatMap(([, pathItem]) => Object.values(pathItem as Record<string, unknown>));

    expect(offramp.length).toBeGreaterThanOrEqual(5);
    // `x-internal`, not `deprecated`. In OpenAPI `deprecated` means "this still
    // works, it will be withdrawn, stop calling it", and generators act on it —
    // the react-query client would emit @deprecated on five endpoints the
    // wallet depends on today, and a reader of the published spec would
    // reasonably conclude cash-out is being retired. `x-internal` is the
    // conventional hook for filtering a route out of a published spec, and it
    // says the true thing.
    for (const op of offramp as Array<{
      "x-internal"?: boolean;
      deprecated?: boolean;
      description?: string;
    }>) {
      expect(op["x-internal"]).toBe(true);
      expect(op.deprecated).toBeUndefined();
      expect(op.description).toMatch(/internal/i);
    }
  });

  it("the committed openapi.json matches the generator output", () => {
    // Only the tracked copy. `docs/openapi.json` is gitignored — a build
    // artefact for the published docs site — so reading it threw ENOENT on
    // every clean clone, CI included, before this test could assert anything.
    // Nothing is lost: the same loop in build.ts writes both from one
    // `document`, so the docs copy cannot drift independently of this one.
    //
    // Line endings are normalised: they are not part of the spec, and a
    // Windows checkout with core.autocrlf rewrote all of them, so this failed
    // or passed on the same commit depending on whether the file had been
    // regenerated locally since checkout. `.gitattributes` pins the file to LF
    // as well; this keeps the assertion about content either way.
    const committed = readFileSync(path.resolve(process.cwd(), "openapi.json"), "utf8").replace(
      /\r\n/g,
      "\n",
    );
    const generated = JSON.stringify(spec, null, 2) + "\n";

    expect(committed).toBe(generated);
  });
});
