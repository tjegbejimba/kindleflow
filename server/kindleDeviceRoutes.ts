import type { FastifyInstance } from "fastify";
import type { AuthHelpers } from "./auth.js";
import type { AuthStore, KindleDevice } from "./authStore.js";

export type PublicKindleDevice = Omit<KindleDevice, "userId">;

export function toPublicKindleDevice({ userId: _userId, ...device }: KindleDevice): PublicKindleDevice {
  return device;
}

export function registerKindleDeviceRoutes(app: FastifyInstance, store: AuthStore, auth: AuthHelpers): void {
  const list = (userId: string) => store.listKindleDevices(userId).map(toPublicKindleDevice);

  app.get("/api/kindles", async (request) => {
    const user = auth.requireUser(request);
    return { devices: list(user.id) };
  });

  app.post("/api/kindles", async (request) => {
    const user = auth.requireUser(request);
    const body = (request.body ?? {}) as { name?: unknown; email?: unknown; sendByDefault?: unknown };
    const device = store.addKindleDevice(user.id, {
      name: typeof body.name === "string" ? body.name : "",
      email: typeof body.email === "string" ? body.email : "",
      sendByDefault: typeof body.sendByDefault === "boolean" ? body.sendByDefault : undefined
    });
    return { device: toPublicKindleDevice(device), devices: list(user.id) };
  });

  app.patch("/api/kindles/:deviceId", async (request) => {
    const user = auth.requireUser(request);
    const { deviceId } = request.params as { deviceId: string };
    const body = (request.body ?? {}) as { name?: unknown; email?: unknown; sendByDefault?: unknown };
    const device = store.updateKindleDevice(user.id, deviceId, {
      name: typeof body.name === "string" ? body.name : undefined,
      email: typeof body.email === "string" ? body.email : undefined,
      sendByDefault: typeof body.sendByDefault === "boolean" ? body.sendByDefault : undefined
    });
    return { device: toPublicKindleDevice(device), devices: list(user.id) };
  });

  app.delete("/api/kindles/:deviceId", async (request) => {
    const user = auth.requireUser(request);
    const { deviceId } = request.params as { deviceId: string };
    if (!store.deleteKindleDevice(user.id, deviceId)) {
      throw Object.assign(new Error("Kindle not found."), { statusCode: 404 });
    }
    return { deleted: true, devices: list(user.id) };
  });
}
