import fastifyMultipart from "@fastify/multipart";
import type { FastifyInstance } from "fastify";
import type { AuthHelpers } from "./auth.js";
import type { AuthStore } from "./authStore.js";
import type { SmtpConfig } from "./config.js";
import { sendUploadedFile } from "./fileUpload.js";
import { parseKindleSelectors } from "./kindleDelivery.js";
import type { KindleDelivery } from "./authStore.js";

export async function registerFileUploadRoute(
  app: FastifyInstance,
  dataDir: string,
  store: AuthStore,
  auth: AuthHelpers,
  smtp?: SmtpConfig
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
      const titleField = data.fields.title as { value: string } | undefined;
      const title = titleField && typeof titleField.value === "string" ? titleField.value : undefined;
      // Multipart fields are only visible here if they precede the file part.
      const kindlesField = data.fields.kindles as { value: unknown } | { value: unknown }[] | undefined;
      const kindleSelectors = parseKindleSelectors(
        Array.isArray(kindlesField) ? kindlesField.map((field) => field.value) : kindlesField?.value
      );
      const kindleEmails = smtp ? store.resolveKindleTargets(user.id, kindleSelectors).map((device) => device.email) : [];

      const result = await sendUploadedFile(
        {
          userId: user.id,
          fileBuffer,
          originalFilename: data.filename,
          title
        },
        { dataDir, store, smtp, kindleEmails }
      );

      return reply.send({
        libraryItemId: result.libraryItemId,
        storedFilename: result.storedFilename,
        title: result.title,
        mimeType: result.mimeType,
        delivery: result.delivery ? toUploadDelivery(result.delivery) : null,
        deliveries: result.deliveries.map(toUploadDelivery)
      });
    } catch (error) {
      if (error instanceof Error) {
        return reply.code(400).send({ error: error.message });
      }
      throw error;
    }
  });
}

function toUploadDelivery(delivery: KindleDelivery) {
  return {
    id: delivery.id,
    status: delivery.status,
    trigger: delivery.trigger,
    kindleEmail: delivery.kindleEmail,
    error: delivery.error
  };
}
