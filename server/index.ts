import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyRequest } from "fastify";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AuthStore, type UserProfile } from "./authStore.js";
import { fetchAndExtractArticle } from "./articleFetcher.js";
import { isEmailDeliveryEnabled, loadConfig } from "./config.js";
import { fetchFeed } from "./feed.js";
import { generateKindleFile } from "./kindleFile.js";
import { sendFileToKindle, sendMagicLink } from "./mailer.js";
import { pollSubscriptions, startDailySubscriptionPoller } from "./subscriptionPoller.js";

const config = loadConfig();
const app = Fastify({ logger: true });
const store = new AuthStore(config.dbPath);
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
  inviteRequired: Boolean(config.inviteCode),
  authRequired: true
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

  const token = store.createLoginToken(
    body.email,
    typeof body.inviteCode === "string" ? body.inviteCode : undefined,
    config.inviteCode
  );
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
  reply.setCookie(SESSION_COOKIE, sessionToken, sessionCookieOptions(config.cookieSecure));
  return reply.redirect("/?verified=1");
});

app.post("/api/auth/logout", async (request, reply) => {
  store.destroySession(request.cookies[SESSION_COOKIE]);
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
  return { loggedOut: true };
});

app.get("/api/me", async (request) => ({
  user: getCurrentUser(request)
}));

app.patch("/api/me", async (request) => {
  const user = requireUser(request);
  const body = request.body as { kindleEmail?: unknown; autoSendToKindle?: unknown };

  return {
    user: store.updateUserProfile(user.id, {
      kindleEmail:
        typeof body.kindleEmail === "string" && body.kindleEmail.trim() ? body.kindleEmail : body.kindleEmail === "" ? null : undefined,
      autoSendToKindle: typeof body.autoSendToKindle === "boolean" ? body.autoSendToKindle : undefined
    })
  };
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

function sessionCookieOptions(secure: boolean) {
  return {
    path: "/",
    httpOnly: true,
    sameSite: "lax" as const,
    secure,
    maxAge: 30 * 24 * 60 * 60
  };
}
