import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";
import { access } from "node:fs/promises";

const AUTH_BRIDGE_PATH = "/__auth";

export async function registerClientStaticRoutes(app: FastifyInstance, clientDist: string): Promise<void> {
  await access(clientDist);
  await app.register(fastifyStatic, {
    root: clientDist,
    prefix: "/",
    wildcard: false
  });
  app.setNotFoundHandler(async (request, reply) => {
    const pathname = request.url.split("?", 1)[0];
    if (pathname === AUTH_BRIDGE_PATH || pathname.startsWith(`${AUTH_BRIDGE_PATH}/`)) {
      return reply
        .code(404)
        .header("cache-control", "no-store")
        .send({ message: "Authentication bridge route is handled by the reverse proxy." });
    }
    return reply.sendFile("index.html");
  });
}
