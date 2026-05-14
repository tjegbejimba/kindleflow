import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { createReadStream } from "node:fs";
import { access, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AuthStore, type KindleDelivery, type LibraryItem, type UserProfile } from "./authStore.js";
import { importRenderedArticle } from "./articleImport.js";
import { fetchAndExtractArticle } from "./articleFetcher.js";
import { isEmailDeliveryEnabled, loadConfig, type SmtpConfig } from "./config.js";
import { fetchFeed } from "./feed.js";
import { FileInviteCodes } from "./inviteCodes.js";
import { generateKindleFile, saveKindlePdf } from "./kindleFile.js";
import { sendFileToKindle, sendLoginCode } from "./mailer.js";
import { renderOpdsAcquisitionFeed, renderOpdsNavigationFeed } from "./opds.js";
import { pollSubscriptions, startDailySubscriptionPoller } from "./subscriptionPoller.js";
import { shouldAutoSendPdf } from "./pdfAnalyzer.js";

const config = loadConfig();
const app = Fastify({ logger: true });
const store = new AuthStore(config.dbPath, { sessionTtlMs: daysToMs(config.sessionTtlDays) });
const inviteCodes = new FileInviteCodes(config.inviteCodesFile);
const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const clientDist = path.join(projectRoot, "client", "dist");
const SESSION_COOKIE = "kf_session";
const MAX_IMPORTED_HTML_BYTES = 5 * 1024 * 1024;

await mkdir(config.dataDir, { recursive: true });

await app.register(fastifyCookie);

await app.register(fastifyStatic, {
  root: config.dataDir,
  prefix: "/files/",
  decorateReply: false,
  index: false
});

try {
  await access(clientDist);
  await app.register(fastifyStatic, {
    root: clientDist,
    prefix: "/",
    wildcard: false
  });
  app.setNotFoundHandler(async (_request, reply) => reply.sendFile("index.html"));
} catch {
  app.get("/", async () => ({
    name: "KindleFlow",
    message: "Build the client with npm run build, or use npm run dev:client during development."
  }));
}

app.get("/api/config", async () => ({
  emailDeliveryEnabled: isEmailDeliveryEnabled(config),
  inviteRequired: await inviteCodes.hasInviteRequirement(config.inviteCode),
  authRequired: true,
  kindleApprovedSender: config.smtp?.from,
  kindleSettingsUrl: "https://www.amazon.com/hz/mycd/myx#/home/settings/payment"
}));

app.post("/api/auth/request-code", async (request) => {
  const body = request.body as { email?: unknown; inviteCode?: unknown };
  if (typeof body.email !== "string") {
    throw new Error("Email is required.");
  }

  if (!config.smtp) {
    const error = new Error("Email delivery is not configured. Set SMTP_HOST and SMTP_FROM before logging in.");
    Object.assign(error, { statusCode: 400 });
    throw error;
  }

  if (!store.userExists(body.email)) {
    await inviteCodes.consume(
      typeof body.inviteCode === "string" ? body.inviteCode : undefined,
      body.email,
      config.inviteCode
    );
  }

  const code = store.createLoginCode(body.email, "__already_invited__", undefined);
  await sendLoginCode(config.smtp, body.email, code);
  return { sent: true };
});

app.post("/api/auth/verify-code", async (request, reply) => {
  const body = request.body as { email?: unknown; code?: unknown };
  if (typeof body.email !== "string" || typeof body.code !== "string") {
    throw new Error("Email and login code are required.");
  }

  const sessionToken = store.consumeLoginCode(body.email, body.code);
  reply.setCookie(SESSION_COOKIE, sessionToken, sessionCookieOptions(config.cookieSecure, config.sessionTtlDays));
  return { user: store.getUserBySession(sessionToken) };
});

app.post("/api/auth/logout", async (request, reply) => {
  store.destroySession(request.cookies[SESSION_COOKIE]);
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
  return { loggedOut: true };
});

app.get("/api/me", async (request, reply) => {
  const sessionToken = request.cookies[SESSION_COOKIE];
  const user = store.getUserBySession(sessionToken);
  if (user && sessionToken) {
    store.refreshSession(sessionToken);
    reply.setCookie(SESSION_COOKIE, sessionToken, sessionCookieOptions(config.cookieSecure, config.sessionTtlDays));
  }
  return { user };
});

app.patch("/api/me", async (request) => {
  const user = requireUser(request);
  const body = request.body as {
    kindleEmail?: unknown;
    autoSendToKindle?: unknown;
    subscriptionRetentionDays?: unknown;
  };

  return {
    user: store.updateUserProfile(user.id, {
      kindleEmail:
        typeof body.kindleEmail === "string" && body.kindleEmail.trim() ? body.kindleEmail : body.kindleEmail === "" ? null : undefined,
      autoSendToKindle: typeof body.autoSendToKindle === "boolean" ? body.autoSendToKindle : undefined,
      subscriptionRetentionDays:
        typeof body.subscriptionRetentionDays === "number" ? body.subscriptionRetentionDays : undefined
    })
  };
});

app.get("/api/me/opds", async (request) => {
  const user = requireUser(request);
  const token = store.ensureOpdsToken(user.id);
  return { opdsUrl: `${config.appBaseUrl}/opds/${encodeURIComponent(token)}/catalog.xml` };
});

app.post("/api/me/opds/rotate", async (request) => {
  const user = requireUser(request);
  const token = store.rotateOpdsToken(user.id);
  return { opdsUrl: `${config.appBaseUrl}/opds/${encodeURIComponent(token)}/catalog.xml` };
});

app.post("/api/articles/fetch", async (request) => {
  const user = requireUser(request);
  const body = request.body as { url?: unknown };
  if (typeof body.url !== "string") {
    throw new Error("URL is required.");
  }

  const fetched = await fetchAndExtractArticle(body.url, { substackAuth: config.substackAuth });

  if (fetched.kind === "pdf") {
    const generated = await saveKindlePdf({
      buffer: fetched.pdfBuffer,
      title: fetched.title,
      dataDir: config.dataDir,
      sourceUrl: fetched.sourceUrl
    });
    const libraryItem = store.addLibraryItem(user.id, {
      type: "article",
      title: fetched.title,
      sourceUrl: fetched.sourceUrl,
      filename: generated.filename,
      mimeType: generated.mimeType
    });
    
    // Check if auto-send should proceed based on analysis verdict
    const shouldAutoSend = shouldAutoSendPdf(fetched.analysis.verdict);
    const delivery =
      config.smtp && user.kindleEmail && user.autoSendToKindle && shouldAutoSend
        ? await sendKindleDelivery(user, libraryItem, "auto")
        : undefined;

    return {
      kind: "pdf" as const,
      sourceUrl: fetched.sourceUrl,
      title: fetched.title,
      analysis: fetched.analysis,
      generated: {
        filename: generated.filename,
        mimeType: generated.mimeType,
        downloadUrl: `/files/${encodeURIComponent(generated.filename)}`,
        sentToKindle: delivery?.status === "sent",
        delivery
      }
    };
  }

  return {
    kind: "article" as const,
    sourceUrl: fetched.sourceUrl,
    article: fetched.article
  };
});

app.post("/api/articles/import", { bodyLimit: MAX_IMPORTED_HTML_BYTES }, async (request) => {
  requireUser(request);
  const body = request.body as { sourceUrl?: unknown; html?: unknown };
  if (typeof body.sourceUrl !== "string" || typeof body.html !== "string") {
    throw new Error("Source URL and rendered HTML are required.");
  }

  const imported = importRenderedArticle({
    sourceUrl: body.sourceUrl,
    html: body.html
  });
  return { kind: "article" as const, ...imported };
});

app.post("/api/articles/generate", async (request) => {
  const user = requireUser(request);
  const body = request.body as {
    title?: unknown;
    contentHtml?: unknown;
    textContent?: unknown;
    sourceUrl?: unknown;
  };

  if (typeof body.title !== "string" || typeof body.contentHtml !== "string" || typeof body.textContent !== "string") {
    throw new Error("Article title, contentHtml, and textContent are required.");
  }

  const generated = await generateKindleFile(
    {
      title: body.title,
      contentHtml: body.contentHtml,
      textContent: body.textContent
    },
    {
      dataDir: config.dataDir,
      sourceUrl: typeof body.sourceUrl === "string" ? body.sourceUrl : undefined
    }
  );
  const libraryItem = store.addLibraryItem(user.id, {
    type: "article",
    title: body.title,
    sourceUrl: typeof body.sourceUrl === "string" ? body.sourceUrl : undefined,
    filename: generated.filename,
    mimeType: generated.mimeType
  });
  const delivery =
    config.smtp && user.kindleEmail && user.autoSendToKindle
      ? await sendKindleDelivery(user, libraryItem, "auto")
      : undefined;

  return {
    ...generated,
    absolutePath: undefined,
    downloadUrl: `/files/${encodeURIComponent(generated.filename)}`,
    sentToKindle: delivery?.status === "sent",
    delivery
  };
});

app.post("/api/articles/send", async (request) => {
  const user = requireUser(request);
  getKindleDeliveryConfig(user);

  const body = request.body as { filename?: unknown };
  if (typeof body.filename !== "string") {
    throw new Error("Generated filename is required.");
  }

  const safeFilename = path.basename(body.filename);
  if (safeFilename !== body.filename || !isAllowedKindleFilename(safeFilename)) {
    const error = new Error("Invalid generated file name.");
    Object.assign(error, { statusCode: 400 });
    throw error;
  }

  const libraryItem = store.getLibraryItemForUserByFilename(user.id, safeFilename);
  if (!libraryItem) {
    const error = new Error("Generated file is not in your library yet.");
    Object.assign(error, { statusCode: 404 });
    throw error;
  }

  const delivery = await sendKindleDelivery(user, libraryItem, "manual");
  return { sent: delivery.status === "sent", delivery };
});

app.post("/api/articles/convert-pdf", async (request) => {
  const user = requireUser(request);

  const body = request.body as { filename?: unknown; forceConvert?: unknown };
  if (typeof body.filename !== "string") {
    throw new Error("PDF filename is required.");
  }

  const safeFilename = path.basename(body.filename);
  if (safeFilename !== body.filename || !isAllowedKindleFilename(safeFilename)) {
    const error = new Error("Invalid file name.");
    Object.assign(error, { statusCode: 400 });
    throw error;
  }

  // Look up the library item
  const libraryItem = store.getLibraryItemForUserByFilename(user.id, safeFilename);
  if (!libraryItem) {
    const error = new Error("PDF file is not in your library.");
    Object.assign(error, { statusCode: 404 });
    throw error;
  }

  // Verify it's actually a PDF
  if (libraryItem.mimeType !== "application/pdf") {
    const error = new Error("This file is not a PDF.");
    Object.assign(error, { statusCode: 400 });
    throw error;
  }

  // Read the PDF from disk
  const pdfPath = path.join(config.dataDir, safeFilename);
  const pdfBuffer = await readFile(pdfPath);

  // Re-analyze to get the verdict
  const { analyzePdf } = await import("./pdfAnalyzer.js");
  const analysis = await analyzePdf(pdfBuffer);

  // Check if conversion is allowed based on verdict
  const forceConvert = body.forceConvert === true;
  const isGoodOrMixed = analysis.verdict === "good-epub-candidate" || analysis.verdict === "mixed-conversion-quality";
  
  if (!isGoodOrMixed && !forceConvert) {
    const error = new Error("This PDF is not recommended for EPUB conversion. Set forceConvert=true to convert anyway.");
    Object.assign(error, { statusCode: 400, verdict: analysis.verdict, reasons: analysis.reasons });
    throw error;
  }

  // Perform the conversion
  const { convertPdfToEpub } = await import("./pdfConverter.js");
  const generated = await convertPdfToEpub({
    pdfBuffer,
    title: libraryItem.title,
    sourceUrl: libraryItem.sourceUrl,
    dataDir: config.dataDir
  });

  // Add converted EPUB to library as a new item
  const epubLibraryItem = store.addLibraryItem(user.id, {
    type: "article",
    title: `${libraryItem.title} (Converted)`,
    sourceUrl: libraryItem.sourceUrl,
    filename: generated.filename,
    mimeType: generated.mimeType
  });

  return {
    filename: generated.filename,
    mimeType: generated.mimeType,
    downloadUrl: `/files/${encodeURIComponent(generated.filename)}`,
    libraryItemId: epubLibraryItem.id,
    verdict: analysis.verdict
  };
});

app.get("/api/deliveries", async (request) => {
  const user = requireUser(request);
  return { deliveries: store.listKindleDeliveries(user.id) };
});

app.post("/api/deliveries/latest", async (request) => {
  const user = requireUser(request);
  getKindleDeliveryConfig(user);
  const libraryItem = store.getLatestLibraryItem(user.id);
  if (!libraryItem) {
    const error = new Error("Generate an EPUB before sending the latest item.");
    Object.assign(error, { statusCode: 404 });
    throw error;
  }

  return { delivery: await sendKindleDelivery(user, libraryItem, "manual") };
});

app.post("/api/deliveries/test", async (request) => {
  const user = requireUser(request);
  getKindleDeliveryConfig(user);
  const generated = await generateKindleFile(
    {
      title: "KindleFlow Delivery Test",
      contentHtml:
        "<p>If this EPUB appeared on your Kindle, KindleFlow SMTP delivery and Amazon's approved sender settings are working.</p>",
      textContent:
        "If this EPUB appeared on your Kindle, KindleFlow SMTP delivery and Amazon's approved sender settings are working."
    },
    {
      dataDir: config.dataDir,
      sourceUrl: config.appBaseUrl
    }
  );
  const libraryItem = store.addLibraryItem(user.id, {
    type: "article",
    title: "KindleFlow Delivery Test",
    sourceUrl: config.appBaseUrl,
    filename: generated.filename,
    mimeType: generated.mimeType
  });

  return { delivery: await sendKindleDelivery(user, libraryItem, "test") };
});

app.post("/api/deliveries/:deliveryId/retry", async (request) => {
  const user = requireUser(request);
  getKindleDeliveryConfig(user);
  const { deliveryId } = request.params as { deliveryId: string };
  const previousDelivery = store.getKindleDeliveryForUser(user.id, deliveryId);
  if (!previousDelivery) {
    const error = new Error("Delivery not found.");
    Object.assign(error, { statusCode: 404 });
    throw error;
  }
  if (previousDelivery.status !== "failed") {
    const error = new Error("Only failed deliveries can be retried.");
    Object.assign(error, { statusCode: 400 });
    throw error;
  }

  return { delivery: await retryKindleDelivery(user, previousDelivery) };
});

app.get("/api/subscriptions", async (request) => {
  const user = requireUser(request);
  return { subscriptions: store.listSubscriptions(user.id) };
});

app.post("/api/subscriptions", async (request) => {
  const user = requireUser(request);
  const body = request.body as { url?: unknown };
  if (typeof body.url !== "string") {
    throw new Error("Subscription URL is required.");
  }

  const feed = await fetchFeed(body.url, { substackAuth: config.substackAuth });
  const subscription = store.addSubscription(user.id, {
    feedUrl: feed.feedUrl,
    sourceUrl: body.url,
    title: feed.feedTitle
  });

  for (const item of feed.items) {
    store.markPostDelivered(subscription.id, {
      url: item.url,
      guid: item.guid,
      title: item.title
    });
  }

  return { subscription };
});

app.post("/api/subscriptions/poll", async (request) => {
  const user = requireUser(request);
  return pollSubscriptions(store, config, app.log, user.id);
});

app.get("/opds/:token/catalog.xml", async (request, reply) => {
  const { token } = request.params as { token: string };
  const user = requireOpdsUser(token);
  return sendOpdsXml(
    reply,
    renderOpdsNavigationFeed({
      id: `kindleflow:user:${user.id}:root`,
      title: "KindleFlow",
      updated: new Date().toISOString(),
      entries: [
        {
          id: `kindleflow:user:${user.id}:recent`,
          title: "Recent",
          href: `/opds/${encodeURIComponent(token)}/recent.xml`
        },
        {
          id: `kindleflow:user:${user.id}:subscriptions`,
          title: "Subscriptions",
          href: `/opds/${encodeURIComponent(token)}/subscriptions.xml`
        }
      ]
    })
  );
});

app.get("/opds/:token/recent.xml", async (request, reply) => {
  const { token } = request.params as { token: string };
  const user = requireOpdsUser(token);
  return sendOpdsXml(
    reply,
    renderOpdsAcquisitionFeed({
      id: `kindleflow:user:${user.id}:recent`,
      title: "Recent KindleFlow EPUBs",
      updated: new Date().toISOString(),
      entries: store.listRecentLibraryItems(user.id).map((item) => ({
        id: item.id,
        title: item.title,
        updated: item.createdAt,
        sourceUrl: item.sourceUrl,
        href: `/opds/${encodeURIComponent(token)}/files/${encodeURIComponent(item.filename)}`,
        mimeType: item.mimeType
      }))
    })
  );
});

app.get("/opds/:token/subscriptions.xml", async (request, reply) => {
  const { token } = request.params as { token: string };
  const user = requireOpdsUser(token);
  return sendOpdsXml(
    reply,
    renderOpdsNavigationFeed({
      id: `kindleflow:user:${user.id}:subscriptions`,
      title: "KindleFlow Subscriptions",
      updated: new Date().toISOString(),
      entries: store.listLibrarySubscriptions(user.id).map((subscription) => ({
        id: subscription.id,
        title: `${subscription.title} (${subscription.itemCount})`,
        href: `/opds/${encodeURIComponent(token)}/subscriptions/${encodeURIComponent(subscription.id)}.xml`
      }))
    })
  );
});

app.get("/opds/:token/subscriptions/:subscriptionId.xml", async (request, reply) => {
  const { token, subscriptionId } = request.params as { token: string; subscriptionId: string };
  const user = requireOpdsUser(token);
  const subscription = store.listSubscriptions(user.id).find((candidate) => candidate.id === subscriptionId);
  if (!subscription) {
    return reply.code(404).send({ message: "Subscription not found." });
  }

  return sendOpdsXml(
    reply,
    renderOpdsAcquisitionFeed({
      id: `kindleflow:user:${user.id}:subscription:${subscriptionId}`,
      title: subscription.title,
      updated: new Date().toISOString(),
      entries: store.listLibraryItemsBySubscription(user.id, subscriptionId).map((item) => ({
        id: item.id,
        title: item.title,
        updated: item.createdAt,
        sourceUrl: item.sourceUrl,
        href: `/opds/${encodeURIComponent(token)}/files/${encodeURIComponent(item.filename)}`,
        mimeType: item.mimeType
      }))
    })
  );
});

app.get("/opds/:token/files/:filename", async (request, reply) => {
  const { token, filename } = request.params as { token: string; filename: string };
  requireOpdsUser(token);
  const safeFilename = path.basename(filename);
  if (safeFilename !== filename || !isAllowedKindleFilename(safeFilename)) {
    return reply.code(400).send({ message: "Invalid filename." });
  }

  const item = store.getLibraryItemForOpdsToken(token, safeFilename);
  if (!item) {
    return reply.code(404).send({ message: "File not found." });
  }

  const resolvedDataDir = path.resolve(config.dataDir);
  const absolutePath = path.resolve(resolvedDataDir, safeFilename);
  if (!absolutePath.startsWith(`${resolvedDataDir}${path.sep}`)) {
    return reply.code(400).send({ message: "Invalid filename." });
  }

  return reply
    .type(item.mimeType)
    .header("content-disposition", `attachment; filename="${safeFilename.replaceAll('"', "")}"`)
    .send(createReadStream(absolutePath));
});

startDailySubscriptionPoller(store, config, app.log);

await app.listen({ host: config.host, port: config.port });

function getCurrentUser(request: FastifyRequest): UserProfile | null {
  return store.getUserBySession(request.cookies[SESSION_COOKIE]);
}

function requireUser(request: FastifyRequest): UserProfile {
  const user = getCurrentUser(request);
  if (!user) {
    const error = new Error("Please sign in to continue.");
    Object.assign(error, { statusCode: 401 });
    throw error;
  }
  return user;
}

function requireOpdsUser(token: string): UserProfile {
  const user = store.getUserByOpdsToken(token);
  if (!user) {
    const error = new Error("Invalid OPDS token.");
    Object.assign(error, { statusCode: 401 });
    throw error;
  }
  return user;
}

function getKindleDeliveryConfig(user: UserProfile): { smtp: SmtpConfig; kindleEmail: string } {
  if (!config.smtp) {
    const error = new Error("Kindle email delivery is not configured.");
    Object.assign(error, { statusCode: 400 });
    throw error;
  }
  if (!user.kindleEmail) {
    const error = new Error("Add your Kindle email address before sending files.");
    Object.assign(error, { statusCode: 400 });
    throw error;
  }
  return { smtp: config.smtp, kindleEmail: user.kindleEmail };
}

async function sendKindleDelivery(
  user: UserProfile,
  libraryItem: LibraryItem,
  trigger: "auto" | "manual" | "subscription" | "test"
): Promise<KindleDelivery> {
  const deliveryConfig = getKindleDeliveryConfig(user);
  const delivery = store.createKindleDelivery(user.id, {
    libraryItemId: libraryItem.id,
    title: libraryItem.title,
    filename: libraryItem.filename,
    kindleEmail: deliveryConfig.kindleEmail,
    trigger
  });

  return finishKindleDelivery(delivery, deliveryConfig.smtp);
}

async function retryKindleDelivery(user: UserProfile, previousDelivery: KindleDelivery): Promise<KindleDelivery> {
  const deliveryConfig = getKindleDeliveryConfig(user);
  const retry = store.createKindleDelivery(user.id, {
    libraryItemId: previousDelivery.libraryItemId,
    title: previousDelivery.title,
    filename: previousDelivery.filename,
    kindleEmail: deliveryConfig.kindleEmail,
    trigger: "retry"
  });

  return finishKindleDelivery(retry, deliveryConfig.smtp);
}

async function finishKindleDelivery(delivery: KindleDelivery, smtp: SmtpConfig): Promise<KindleDelivery> {
  try {
    const result = await sendFileToKindle(smtp, config.dataDir, delivery.filename, delivery.kindleEmail);
    return store.recordKindleDeliveryResult(delivery.id, {
      status: "sent",
      messageId: result.messageId,
      response: result.response
    });
  } catch (error) {
    const failed = store.recordKindleDeliveryResult(delivery.id, {
      status: "failed",
      error: error instanceof Error ? error.message : "Kindle delivery failed."
    });
    app.log.warn({ err: error, deliveryId: delivery.id }, "kindle delivery failed");
    return failed;
  }
}

function sendOpdsXml(reply: FastifyReply, xml: string) {
  return reply.type("application/atom+xml;profile=opds-catalog").send(xml);
}

function sessionCookieOptions(secure: boolean, ttlDays: number) {
  return {
    path: "/",
    httpOnly: true,
    sameSite: "lax" as const,
    secure,
    maxAge: ttlDays * 24 * 60 * 60
  };
}

function daysToMs(days: number): number {
  return days * 24 * 60 * 60 * 1000;
}

function isAllowedKindleFilename(filename: string): boolean {
  const lower = filename.toLowerCase();
  return lower.endsWith(".epub") || lower.endsWith(".pdf");
}
