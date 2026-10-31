import type { FastifyInstance } from "fastify";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import type { AuthHelpers } from "./auth.js";
import type { AuthStore } from "./authStore.js";

export async function registerFileDownloadRoute(
  app: FastifyInstance,
  dataDir: string,
  store: AuthStore,
  auth: AuthHelpers
): Promise<void> {
  app.get<{ Params: { filename: string } }>("/files/:filename", async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    const user = auth.requireUser(request);
    const { filename } = request.params;
    if (path.basename(filename) !== filename || !/\.(epub|pdf)$/i.test(filename)) {
      return reply.code(404).send({ message: "File not found." });
    }

    const item = store.getLibraryItemForUserByFilename(user.id, filename)
      ?? store.getTemporaryFileByFilename(user.id, filename);
    if (!item) {
      return reply.code(404).send({ message: "File not found." });
    }

    let file;
    try {
      file = await open(path.resolve(dataDir, filename), constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (["ENOENT", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        return reply.code(404).send({ message: "File not found." });
      }
      throw error;
    }
    if (!(await file.stat()).isFile()) {
      await file.close();
      return reply.code(404).send({ message: "File not found." });
    }

    return reply
      .type(item.mimeType)
      .header("content-disposition", `attachment; filename="${filename.replaceAll('"', "")}"`)
      .send(file.createReadStream());
  });
}
