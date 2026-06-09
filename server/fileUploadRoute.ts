import fastifyMultipart from "@fastify/multipart";
import type { FastifyInstance } from "fastify";
import type { AuthHelpers } from "./auth.js";
import type { AuthStore } from "./authStore.js";
import { saveUploadedFile } from "./fileUpload.js";

export async function registerFileUploadRoute(
  app: FastifyInstance,
  dataDir: string,
  store: AuthStore,
  auth: AuthHelpers
): Promise<void> {
  await app.register(fastifyMultipart, {
    limits: {
      fileSize: 50 * 1024 * 1024 // 50 MB
    }
  });

  app.post("/api/files/upload", async (request, reply) => {
    const user = auth.getCurrentUser(request);
    if (!user) {
      return reply.code(401).send({ error: "Authentication required." });
    }

    try {
      const data = await request.file();
      if (!data) {
        return reply.code(400).send({ error: "File is required." });
      }

      const fileBuffer = await data.toBuffer();
      const titleField = data.fields.title;
      const title = titleField && typeof titleField.value === "string" ? titleField.value : undefined;

      const result = await saveUploadedFile(
        {
          userId: user.id,
          fileBuffer,
          originalFilename: data.filename,
          title
        },
        { dataDir, store }
      );

      return reply.send({
        libraryItemId: result.libraryItemId,
        storedFilename: result.storedFilename,
        title: result.title,
        mimeType: result.mimeType
      });
    } catch (error) {
      if (error instanceof Error) {
        return reply.code(400).send({ error: error.message });
      }
      throw error;
    }
  });
}
