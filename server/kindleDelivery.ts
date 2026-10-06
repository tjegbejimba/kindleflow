import { randomUUID } from "node:crypto";
import type { AuthStore, KindleDelivery, KindleDevice } from "./authStore.js";
import type { SmtpConfig } from "./config.js";
import { sendFileToKindle } from "./mailer.js";

export interface DeliveryLogger {
  warn: (obj: unknown, msg?: string) => void;
}

export interface DeliveryFile {
  libraryItemId?: string;
  title: string;
  filename: string;
  displayFilename?: string;
}

export interface DeliverToKindlesInput {
  store: AuthStore;
  smtp: SmtpConfig;
  dataDir: string;
  log?: DeliveryLogger;
  send?: typeof sendFileToKindle;
  userId: string;
  targets: readonly string[];
  file: DeliveryFile;
  trigger: KindleDelivery["trigger"];
}

export interface DeliverySummary {
  total: number;
  sent: number;
  failed: number;
  allSent: boolean;
  anySent: boolean;
}

export const MISSING_KINDLE_MESSAGE = "Add your Kindle email address before sending files.";

/**
 * Resolves which Kindles a send should target and enforces the shared
 * preconditions (SMTP configured, at least one Kindle). Errors carry
 * statusCode 400 so routes surface them to the client.
 */
export function requireKindleTargets(args: {
  store: AuthStore;
  smtp: SmtpConfig | undefined;
  userId: string;
  selectors?: readonly string[];
}): KindleDevice[] {
  if (!args.smtp) {
    throw Object.assign(new Error("Kindle email delivery is not configured."), { statusCode: 400 });
  }
  const targets = args.store.resolveKindleTargets(args.userId, args.selectors);
  if (targets.length === 0) {
    throw Object.assign(new Error(MISSING_KINDLE_MESSAGE), { statusCode: 400 });
  }
  return targets;
}

/** Sends one file to every target email sequentially, recording one delivery row per Kindle under a shared batch id. */
export async function deliverToKindles(input: DeliverToKindlesInput): Promise<KindleDelivery[]> {
  const send = input.send ?? sendFileToKindle;
  const batchId = randomUUID();
  const deliveries: KindleDelivery[] = [];

  for (const kindleEmail of input.targets) {
    const delivery = input.store.createKindleDelivery(input.userId, {
      batchId,
      libraryItemId: input.file.libraryItemId,
      title: input.file.title,
      filename: input.file.filename,
      kindleEmail,
      trigger: input.trigger
    });
    try {
      const result =
        input.file.displayFilename === undefined
          ? await send(input.smtp, input.dataDir, delivery.filename, delivery.kindleEmail)
          : await send(input.smtp, input.dataDir, delivery.filename, delivery.kindleEmail, input.file.displayFilename);
      deliveries.push(
        input.store.recordKindleDeliveryResult(delivery.id, {
          status: "sent",
          messageId: result.messageId,
          response: result.response
        })
      );
    } catch (error) {
      deliveries.push(
        input.store.recordKindleDeliveryResult(delivery.id, {
          status: "failed",
          error: error instanceof Error ? error.message : "Kindle delivery failed."
        })
      );
      input.log?.warn({ err: error, deliveryId: delivery.id }, "kindle delivery failed");
    }
  }

  return deliveries;
}

export function summarizeDeliveries(deliveries: readonly KindleDelivery[]): DeliverySummary {
  const sent = deliveries.filter((delivery) => delivery.status === "sent").length;
  const failed = deliveries.filter((delivery) => delivery.status === "failed").length;
  return {
    total: deliveries.length,
    sent,
    failed,
    allSent: deliveries.length > 0 && sent === deliveries.length,
    anySent: sent > 0
  };
}

export function parseKindleSelectors(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : null;
  if (!raw || raw.some((entry) => typeof entry !== "string")) {
    throw Object.assign(new Error("kindles must be a list of Kindle names, emails, or ids."), { statusCode: 400 });
  }
  const selectors = (raw as string[]).map((entry) => entry.trim()).filter(Boolean);
  return selectors.length > 0 ? selectors : undefined;
}
