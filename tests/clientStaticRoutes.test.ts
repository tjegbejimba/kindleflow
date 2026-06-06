import Fastify, { type FastifyInstance } from "fastify";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerClientStaticRoutes } from "../server/clientStaticRoutes.js";

let tempDir: string;
let clientDist: string;
let app: FastifyInstance;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "kindleflow-client-static-"));
  clientDist = path.join(tempDir, "client-dist");
  await mkdir(clientDist, { recursive: true });
  await writeFile(path.join(clientDist, "index.html"), "<!doctype html><title>KindleFlow</title>");
  app = Fastify();
  await registerClientStaticRoutes(app, clientDist);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("client static routes", () => {
  it("serves the SPA fallback for app routes", async () => {
    const res = await app.inject({ method: "GET", url: "/library/recent" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("KindleFlow");
  });

  it("does not serve the SPA fallback for auth bridge routes", async () => {
    const res = await app.inject({ method: "GET", url: "/__auth/login?next=%2F" });
    expect(res.statusCode).toBe(404);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.json()).toEqual({ message: "Authentication bridge route is handled by the reverse proxy." });
  });
});
