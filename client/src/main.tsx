import React from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

interface AppConfig {
  emailDeliveryEnabled: boolean;
  inviteRequired: boolean;
  authRequired: boolean;
  kindleApprovedSender?: string;
  kindleSettingsUrl: string;
}

interface UserProfile {
  id: string;
  email: string;
  verified: boolean;
  kindleEmail?: string;
  autoSendToKindle: boolean;
  subscriptionRetentionDays: number;
}

interface ExtractedArticle {
  title: string;
  contentHtml: string;
  textContent: string;
  byline?: string;
  excerpt?: string;
  siteName?: string;
}

interface FetchResult {
  sourceUrl: string;
  article: ExtractedArticle;
}

interface GeneratedFile {
  filename: string;
  downloadUrl: string;
  sentToKindle: boolean;
}

interface Subscription {
  id: string;
  title: string;
  feedUrl: string;
  status: string;
  lastCheckedAt?: string;
}

function App() {
  const [config, setConfig] = React.useState<AppConfig | null>(null);
  const [user, setUser] = React.useState<UserProfile | null>(null);
  const [subscriptions, setSubscriptions] = React.useState<Subscription[]>([]);
  const [loginEmail, setLoginEmail] = React.useState("");
  const [inviteCode, setInviteCode] = React.useState("");
  const [kindleEmail, setKindleEmail] = React.useState("");
  const [autoSendToKindle, setAutoSendToKindle] = React.useState(true);
  const [subscriptionRetentionDays, setSubscriptionRetentionDays] = React.useState(30);
  const [url, setUrl] = React.useState("");
  const [subscriptionUrl, setSubscriptionUrl] = React.useState("");
  const [result, setResult] = React.useState<FetchResult | null>(null);
  const [generatedFile, setGeneratedFile] = React.useState<GeneratedFile | null>(null);
  const [status, setStatus] = React.useState("");
  const [error, setError] = React.useState("");
  const [busyAction, setBusyAction] = React.useState<
    "login" | "profile" | "fetch" | "generate" | "send" | "subscribe" | "poll" | "logout" | null
  >(null);

  React.useEffect(() => {
    Promise.all([apiGet<AppConfig>("/api/config"), apiGet<{ user: UserProfile | null }>("/api/me")])
      .then(([appConfig, me]) => {
        setConfig(appConfig);
        applyUser(me.user);
        if (me.user) {
          void loadSubscriptions();
        }
        if (new URLSearchParams(window.location.search).get("verified") === "1") {
          setStatus("You are signed in.");
          window.history.replaceState({}, "", "/");
        }
      })
      .catch((err) => setError(errorMessage(err)));
  }, []);

  function applyUser(nextUser: UserProfile | null) {
    setUser(nextUser);
    setKindleEmail(nextUser?.kindleEmail ?? "");
    setAutoSendToKindle(nextUser?.autoSendToKindle ?? true);
    setSubscriptionRetentionDays(nextUser?.subscriptionRetentionDays ?? 30);
  }

  async function requestLoginLink(event: React.FormEvent) {
    event.preventDefault();
    setBusyAction("login");
    setError("");
    setStatus("Sending login link...");

    try {
      await apiPost("/api/auth/request-link", { email: loginEmail, inviteCode });
      setStatus("Check your email for a KindleFlow login link.");
    } catch (err) {
      setStatus("");
      setError(errorMessage(err));
    } finally {
      setBusyAction(null);
    }
  }

  async function saveProfile(event: React.FormEvent) {
    event.preventDefault();
    setBusyAction("profile");
    setError("");
    setStatus("Saving profile...");

    try {
      const response = await apiPatch<{ user: UserProfile }>("/api/me", {
        kindleEmail,
        autoSendToKindle,
        subscriptionRetentionDays
      });
      applyUser(response.user);
      setStatus("Profile saved.");
    } catch (err) {
      setStatus("");
      setError(errorMessage(err));
    } finally {
      setBusyAction(null);
    }
  }

  async function logout() {
    setBusyAction("logout");
    setError("");
    try {
      await apiPost("/api/auth/logout", {});
      applyUser(null);
      setSubscriptions([]);
      setResult(null);
      setGeneratedFile(null);
      setStatus("Signed out.");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyAction(null);
    }
  }

  async function fetchArticle(event: React.FormEvent) {
    event.preventDefault();
    setBusyAction("fetch");
    setError("");
    setStatus("Fetching and extracting article...");
    setGeneratedFile(null);

    try {
      const response = await apiPost<FetchResult>("/api/articles/fetch", { url });
      setResult(response);
      setStatus("Article extracted. Review the preview, then generate your Kindle file.");
    } catch (err) {
      setResult(null);
      setStatus("");
      setError(errorMessage(err));
    } finally {
      setBusyAction(null);
    }
  }

  async function generateFile() {
    if (!result) return;
    setBusyAction("generate");
    setError("");
    setStatus("Generating EPUB...");

    try {
      const response = await apiPost<GeneratedFile>("/api/articles/generate", {
        ...result.article,
        sourceUrl: result.sourceUrl
      });
      setGeneratedFile(response);
      setStatus(response.sentToKindle ? "EPUB generated and sent to your Kindle." : "EPUB generated.");
    } catch (err) {
      setError(errorMessage(err));
      setStatus("");
    } finally {
      setBusyAction(null);
    }
  }

  async function sendToKindle() {
    if (!generatedFile) return;
    setBusyAction("send");
    setError("");
    setStatus("Sending to Kindle...");

    try {
      await apiPost("/api/articles/send", { filename: generatedFile.filename });
      setStatus("Sent to Kindle.");
      setGeneratedFile({ ...generatedFile, sentToKindle: true });
    } catch (err) {
      setError(errorMessage(err));
      setStatus("");
    } finally {
      setBusyAction(null);
    }
  }

  async function addSubscription(event: React.FormEvent) {
    event.preventDefault();
    setBusyAction("subscribe");
    setError("");
    setStatus("Adding subscription...");

    try {
      await apiPost("/api/subscriptions", { url: subscriptionUrl });
      setSubscriptionUrl("");
      await loadSubscriptions();
      setStatus("Subscription added. Existing feed posts were marked seen; new posts will send during daily polling.");
    } catch (err) {
      setStatus("");
      setError(errorMessage(err));
    } finally {
      setBusyAction(null);
    }
  }

  async function pollNow() {
    setBusyAction("poll");
    setError("");
    setStatus("Checking subscriptions...");

    try {
      const result = await apiPost<{ checked: number; delivered: number }>("/api/subscriptions/poll", {});
      await loadSubscriptions();
      setStatus(`Checked ${result.checked} subscription(s), delivered ${result.delivered} new post(s).`);
    } catch (err) {
      setStatus("");
      setError(errorMessage(err));
    } finally {
      setBusyAction(null);
    }
  }

  async function loadSubscriptions() {
    const response = await apiGet<{ subscriptions: Subscription[] }>("/api/subscriptions");
    setSubscriptions(response.subscriptions);
  }

  const isBusy = busyAction !== null;

  return (
    <main className="shell">
      <section className="hero">
        <p className="eyebrow">Self-hosted article to Kindle</p>
        <h1>KindleFlow</h1>
        <p className="lede">Paste articles, generate EPUBs, and send them to your Kindle automatically.</p>
      </section>

      {status ? <p className="status">{status}</p> : null}
      {error ? <p className="error">{error}</p> : null}

      {!user ? (
        <section className="card">
          <h2>Sign in</h2>
          <p className="muted">
            KindleFlow uses email magic links. New users need the invite code, and email sending must be configured on the
            server.
          </p>
          {config && !config.emailDeliveryEnabled ? (
            <p className="error">Email delivery is not configured yet. Add Gmail SMTP settings before logging in.</p>
          ) : null}
          <form onSubmit={requestLoginLink}>
            <label htmlFor="login-email">Email</label>
            <input
              id="login-email"
              type="email"
              value={loginEmail}
              onChange={(event) => setLoginEmail(event.target.value)}
              required
            />
            {config?.inviteRequired ? (
              <>
                <label htmlFor="invite-code">Invite code</label>
                <input
                  id="invite-code"
                  type="password"
                  value={inviteCode}
                  onChange={(event) => setInviteCode(event.target.value)}
                />
              </>
            ) : null}
            <button type="submit" disabled={isBusy || !config?.emailDeliveryEnabled}>
              {busyAction === "login" ? "Sending..." : "Email me a login link"}
            </button>
          </form>
        </section>
      ) : (
        <>
          <section className="card account-card">
            <div>
              <p className="eyebrow">Signed in</p>
              <h2>{user.email}</h2>
            </div>
            <button type="button" className="secondary" onClick={logout} disabled={isBusy}>
              {busyAction === "logout" ? "Signing out..." : "Sign out"}
            </button>
          </section>

          <section className="card">
            <h2>Kindle settings</h2>
            <p className="muted">
              Add your Kindle email address and approve the SMTP sender in Amazon’s “Approved Personal Document E-mail
              List.”
            </p>
            {config?.kindleApprovedSender ? (
              <div className="sender-help">
                <p>
                  Approved sender to add: <code>{config.kindleApprovedSender}</code>
                </p>
                <div className="action-buttons">
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => navigator.clipboard.writeText(config.kindleApprovedSender ?? "")}
                  >
                    Copy sender
                  </button>
                  <a className="button secondary-link" href={config.kindleSettingsUrl} target="_blank" rel="noreferrer">
                    Open Amazon Kindle settings
                  </a>
                </div>
              </div>
            ) : null}
            <form onSubmit={saveProfile}>
              <label htmlFor="kindle-email">Kindle email address</label>
              <input
                id="kindle-email"
                type="email"
                placeholder="name_123@kindle.com"
                value={kindleEmail}
                onChange={(event) => setKindleEmail(event.target.value)}
              />
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={autoSendToKindle}
                  onChange={(event) => setAutoSendToKindle(event.target.checked)}
                />
                Automatically send generated EPUBs to my Kindle
              </label>
              <label htmlFor="retention-days">Keep subscription posts for</label>
              <div className="retention-row">
                <input
                  id="retention-days"
                  type="number"
                  min="1"
                  max="365"
                  value={subscriptionRetentionDays}
                  onChange={(event) => setSubscriptionRetentionDays(Number(event.target.value))}
                  required
                />
                <span>days</span>
              </div>
              <button type="submit" disabled={isBusy}>
                {busyAction === "profile" ? "Saving..." : "Save Kindle settings"}
              </button>
            </form>
          </section>

          <form className="card url-form" onSubmit={fetchArticle}>
            <label htmlFor="article-url">Article URL</label>
            <div className="input-row">
              <input
                id="article-url"
                type="url"
                placeholder="https://example.com/great-post"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                required
              />
              <button type="submit" disabled={isBusy}>
                {busyAction === "fetch" ? "Fetching..." : "Fetch article"}
              </button>
            </div>
          </form>

          {result ? (
            <section className="card preview">
              <div className="preview-heading">
                <div>
                  <p className="eyebrow">{result.article.siteName ?? new URL(result.sourceUrl).hostname}</p>
                  <h2>{result.article.title}</h2>
                  {result.article.byline ? <p className="byline">{result.article.byline}</p> : null}
                </div>
                <button type="button" onClick={generateFile} disabled={isBusy}>
                  {busyAction === "generate" ? "Generating..." : "Generate EPUB"}
                </button>
              </div>

              <article className="article-body" dangerouslySetInnerHTML={{ __html: result.article.contentHtml }} />
            </section>
          ) : null}

          {generatedFile ? (
            <section className="card actions">
              <div>
                <h2>Your EPUB is ready</h2>
                <p>{generatedFile.filename}</p>
              </div>
              <div className="action-buttons">
                <a className="button" href={generatedFile.downloadUrl}>
                  Download EPUB
                </a>
                {config?.emailDeliveryEnabled && user.kindleEmail && !generatedFile.sentToKindle ? (
                  <button type="button" onClick={sendToKindle} disabled={isBusy}>
                    {busyAction === "send" ? "Sending..." : "Send to Kindle"}
                  </button>
                ) : null}
              </div>
            </section>
          ) : null}

          <section className="card">
            <div className="preview-heading">
              <div>
                <h2>Substack subscriptions</h2>
                <p className="muted">Add a Substack or RSS URL. New posts are checked daily and sent to your Kindle.</p>
              </div>
              <button type="button" className="secondary" onClick={pollNow} disabled={isBusy}>
                {busyAction === "poll" ? "Checking..." : "Check now"}
              </button>
            </div>

            <form className="input-row" onSubmit={addSubscription}>
              <input
                type="url"
                placeholder="https://example.substack.com"
                value={subscriptionUrl}
                onChange={(event) => setSubscriptionUrl(event.target.value)}
                required
              />
              <button type="submit" disabled={isBusy}>
                {busyAction === "subscribe" ? "Adding..." : "Subscribe"}
              </button>
            </form>

            {subscriptions.length > 0 ? (
              <div className="subscription-list">
                {subscriptions.map((subscription) => (
                  <article className="subscription" key={subscription.id}>
                    <strong>{subscription.title}</strong>
                    <span>{subscription.feedUrl}</span>
                    <small>{subscription.lastCheckedAt ? `Last checked ${subscription.lastCheckedAt}` : "Not checked yet"}</small>
                  </article>
                ))}
              </div>
            ) : (
              <p className="muted">No subscriptions yet.</p>
            )}
          </section>
        </>
      )}
    </main>
  );
}

async function apiGet<T>(url: string): Promise<T> {
  const response = await fetch(url);
  return readApiResponse<T>(response);
}

async function apiPost<T = unknown>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return readApiResponse<T>(response);
}

async function apiPatch<T = unknown>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return readApiResponse<T>(response);
}

async function readApiResponse<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof payload.message === "string" ? payload.message : "Request failed.";
    throw new Error(message);
  }
  return payload as T;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
