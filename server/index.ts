import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { createReadStream } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AuthStore, type UserProfile } from "./authStore.js";
import { fetchAndExtractArticle } from "./articleFetcher.js";
import { isEmailDeliveryEnabled, loadConfig } from "./config.js";
import { fetchFeed } from "./feed.js";
import { FileInviteCodes } from "./inviteCodes.js";
import { generateKindleFile } from "./kindleFile.js";
import { sendFileToKindle, sendMagicLink } from "./mailer.js";
import { renderOpdsAcquisitionFeed, renderOpdsNavigationFeed } from "./opds.js";
import { pollSubscriptions, startDailySubscriptionPoller } from "./subscriptionPoller.js";

const config = loadConfig();
const app = Fastify({ logger: true });
const store = new AuthStore(config.dbPath, { sessionTtlMs: daysToMs(config.sessionTtlDays) });
const inviteCodes = new FileInviteCodes(config.inviteCodesFile);
const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const clientDist = path.join(projectRoot, "client", "dist");
const SESSION_COOKIE = "kf_session";

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

app.post("/api/auth/request-link", async (request) => {
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

  const token = store.createLoginToken(body.email, "__already_invited__", undefined);
  const magicLink = `${config.appBaseUrl}/api/auth/verify?token=${encodeURIComponent(token)}`;

  await sendMagicLink(config.smtp, body.email, magicLink);
  return { sent: true };
});

app.get("/api/auth/verify", async (request, reply) => {
  const query = request.query as { token?: unknown };
  if (typeof query.token !== "string") {
    throw new Error("Login token is required.");
  }

  const sessionToken = store.consumeMagicToken(query.token);
  reply.setCookie(SESSION_COOKIE, sessionToken, sessionCookieOptions(config.cookieSecure, config.sessionTtlDays));
  return reply.redirect("/?verified=1");
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
  requireUser(request);
  const body = request.body as { url?: unknown };
  if (typeof body.url !== "string") {
    throw new Error("URL is required.");
  }

  return fetchAndExtractArticle(body.url);
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
  let sentToKindle = false;
  if (config.smtp && user.kindleEmail && user.autoSendToKindle) {
    await sendFileToKindle(config.smtp, config.dataDir, generated.filename, user.kindleEmail);
    sentToKindle = true;
  }
  store.addLibraryItem(user.id, {
    type: "article",
    title: body.title,
    sourceUrl: typeof body.sourceUrl === "string" ? body.sourceUrl : undefined,
    filename: generated.filename,
    mimeType: generated.mimeType
  });

  return {
    ...generated,
    absolutePath: undefined,
    downloadUrl: `/files/${encodeURIComponent(generated.filename)}`,
    sentToKindle
  };
});

app.post("/api/articles/send", async (request) => {
  const user = requireUser(request);
  if (!config.smtp) {
    const error = new Error("Kindle email delivery is not configured.");
    Object.assign(error, { statusCode: 400 });
    throw error;
  }

  const body = request.body as { filename?: unknown };
  if (typeof body.filename !== "string") {
    throw new Error("Generated filename is required.");
  }

  if (!user.kindleEmail) {
    const error = new Error("Add your Kindle email address before sending files.");
    Object.assign(error, { statusCode: 400 });
    throw error;
  }

  await sendFileToKindle(config.smtp, config.dataDir, body.filename, user.kindleEmail);
  return { sent: true };
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

  const feed = await fetchFeed(body.url);
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
  if (safeFilename !== filename || !safeFilename.endsWith(".epub")) {
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
