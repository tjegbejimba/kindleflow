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

interface ArticleFetchResult {
  kind: "article";
  sourceUrl: string;
  article: ExtractedArticle;
}

interface PdfFetchResult {
  kind: "pdf";
  sourceUrl: string;
  title: string;
  generated: {
    filename: string;
    mimeType: "application/pdf";
    downloadUrl: string;
    sentToKindle: boolean;
    delivery?: KindleDelivery;
  };
}

type FetchResult = ArticleFetchResult | PdfFetchResult;

interface ExtensionImportPayload {
  sourceUrl: string;
  html: string;
}

interface GeneratedFile {
  filename: string;
  mimeType: "application/epub+zip" | "application/pdf";
  downloadUrl: string;
  sentToKindle: boolean;
  delivery?: KindleDelivery;
}

interface Subscription {
  id: string;
  title: string;
  feedUrl: string;
  status: string;
  lastCheckedAt?: string;
}

interface KindleDelivery {
  id: string;
  title: string;
  filename: string;
  kindleEmail: string;
  trigger: "auto" | "manual" | "subscription" | "test" | "retry";
  status: "pending" | "sent" | "failed";
  attempts: number;
  messageId?: string;
  response?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

function App() {
  const [config, setConfig] = React.useState<AppConfig | null>(null);
  const [authLoaded, setAuthLoaded] = React.useState(false);
  const [user, setUser] = React.useState<UserProfile | null>(null);
  const [subscriptions, setSubscriptions] = React.useState<Subscription[]>([]);
  const [deliveries, setDeliveries] = React.useState<KindleDelivery[]>([]);
  const [opdsUrl, setOpdsUrl] = React.useState("");
  const [loginEmail, setLoginEmail] = React.useState("");
  const [loginCode, setLoginCode] = React.useState("");
  const [loginCodeSent, setLoginCodeSent] = React.useState(false);
  const [inviteCode, setInviteCode] = React.useState("");
  const [kindleEmail, setKindleEmail] = React.useState("");
  const [autoSendToKindle, setAutoSendToKindle] = React.useState(true);
  const [subscriptionRetentionDays, setSubscriptionRetentionDays] = React.useState(30);
  const [url, setUrl] = React.useState("");
  const [subscriptionUrl, setSubscriptionUrl] = React.useState("");
  const [result, setResult] = React.useState<FetchResult | null>(null);
  const [generatedFile, setGeneratedFile] = React.useState<GeneratedFile | null>(null);
  const [pendingExtensionImport, setPendingExtensionImport] = React.useState<ExtensionImportPayload | null>(null);
  const [status, setStatus] = React.useState("");
  const [error, setError] = React.useState("");
  const [toast, setToast] = React.useState<{ id: number; kind: "success" | "error"; message: string } | null>(null);
  const toastTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const flashToast = React.useCallback((kind: "success" | "error", message: string) => {
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
    }
    setToast({ id: Date.now(), kind, message });
    toastTimerRef.current = setTimeout(() => setToast(null), 5000);
  }, []);

  const flashDeliveryToast = React.useCallback(
    (delivery: KindleDelivery | undefined, action: string) => {
      if (!delivery) return;
      if (delivery.status === "sent") {
        flashToast("success", `${action} sent to ${delivery.kindleEmail}.`);
      } else if (delivery.status === "failed") {
        flashToast("error", `${action} failed: ${delivery.error ?? "unknown error"}`);
      }
    },
    [flashToast]
  );

  React.useEffect(
    () => () => {
      if (toastTimerRef.current) {
        clearTimeout(toastTimerRef.current);
      }
    },
    []
  );
  const [busyAction, setBusyAction] = React.useState<
    | "login"
    | "profile"
    | "opds"
    | "fetch"
    | "import"
    | "generate"
    | "send"
    | "testDelivery"
    | "latestDelivery"
    | "retryDelivery"
    | "subscribe"
    | "poll"
    | "logout"
    | null
  >(null);

  const isBusy = busyAction !== null;

  function getFileTypeLabel(mimeType: "application/epub+zip" | "application/pdf"): string {
    return mimeType === "application/pdf" ? "PDF" : "EPUB";
  }

  React.useEffect(() => {
    Promise.all([apiGet<AppConfig>("/api/config"), apiGet<{ user: UserProfile | null }>("/api/me")])
      .then(([appConfig, me]) => {
        setConfig(appConfig);
        applyUser(me.user);
        setAuthLoaded(true);
        if (me.user) {
          void loadSubscriptions();
          void loadOpdsUrl();
          void loadDeliveries();
        }
      })
      .catch((err) => {
        setAuthLoaded(true);
        setError(errorMessage(err));
      });
  }, []);

  React.useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.source !== window) {
        return;
      }

      const payload = parseExtensionImportMessage(event.data);
      if (!payload) {
        return;
      }

      setPendingExtensionImport(payload);
      setStatus("Article received from the KindleFlow extension...");
      setError("");
    }

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  React.useEffect(() => {
    if (!pendingExtensionImport || !authLoaded) {
      return;
    }

    if (!user) {
      setPendingExtensionImport(null);
      setStatus("");
      setError("Sign in to KindleFlow, then click the extension button again to import this article.");
      return;
    }

    void importExtensionArticle(pendingExtensionImport);
  }, [authLoaded, pendingExtensionImport, user]);

  function applyUser(nextUser: UserProfile | null) {
    setUser(nextUser);
    setKindleEmail(nextUser?.kindleEmail ?? "");
    setAutoSendToKindle(nextUser?.autoSendToKindle ?? true);
    setSubscriptionRetentionDays(nextUser?.subscriptionRetentionDays ?? 30);
  }

  async function requestLoginCode(event: React.FormEvent) {
    event.preventDefault();
    setBusyAction("login");
    setError("");
    setStatus("Sending login code...");

    try {
      await apiPost("/api/auth/request-code", { email: loginEmail, inviteCode });
      setLoginCodeSent(true);
      setStatus("Check your email for a 6-digit KindleFlow login code, then enter it here.");
    } catch (err) {
      setStatus("");
      setError(errorMessage(err));
    } finally {
      setBusyAction(null);
    }
  }

  async function verifyLoginCode(event: React.FormEvent) {
    event.preventDefault();
    setBusyAction("login");
    setError("");
    setStatus("Verifying login code...");

    try {
      const response = await apiPost<{ user: UserProfile }>("/api/auth/verify-code", { email: loginEmail, code: loginCode });
      applyUser(response.user);
      setLoginCode("");
      setLoginCodeSent(false);
      await loadSubscriptions();
      await loadOpdsUrl();
      await loadDeliveries();
      setStatus("You are signed in.");
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
      setDeliveries([]);
      setResult(null);
      setGeneratedFile(null);
      setOpdsUrl("");
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
      if (response.kind === "pdf") {
        setResult(null);
        setGeneratedFile({
          filename: response.generated.filename,
          mimeType: response.generated.mimeType,
          downloadUrl: response.generated.downloadUrl,
          sentToKindle: response.generated.sentToKindle,
          delivery: response.generated.delivery
        });
        await loadDeliveries();
        setStatus(deliveryStatusMessage(response.generated.delivery, "PDF imported."));
        flashDeliveryToast(response.generated.delivery, "PDF");
      } else {
        setResult(response);
        setStatus("Article extracted. Review the preview, then generate your Kindle file.");
      }
    } catch (err) {
      setResult(null);
      setStatus("");
      setError(errorMessage(err));
    } finally {
      setBusyAction(null);
    }
  }

  async function importExtensionArticle(payload: ExtensionImportPayload) {
    setPendingExtensionImport(null);
    setBusyAction("import");
    setError("");
    setStatus("Importing article from browser extension...");
    setGeneratedFile(null);

    try {
      const response = await apiPost<ArticleFetchResult>("/api/articles/import", payload);
      setResult(response);
      setUrl(response.sourceUrl);
      setStatus("Article imported. Review the preview, then generate your Kindle file.");
    } catch (err) {
      setResult(null);
      setStatus("");
      setError(errorMessage(err));
    } finally {
      setBusyAction(null);
    }
  }

  async function generateFile() {
    if (!result || result.kind !== "article") return;
    setBusyAction("generate");
    setError("");
    setStatus("Generating EPUB...");

    try {
      const response = await apiPost<GeneratedFile>("/api/articles/generate", {
        ...result.article,
        sourceUrl: result.sourceUrl
      });
      setGeneratedFile(response);
      await loadDeliveries();
      setStatus(deliveryStatusMessage(response.delivery, "EPUB generated."));
      flashDeliveryToast(response.delivery, "EPUB");
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
      const response = await apiPost<{ sent: boolean; delivery: KindleDelivery }>("/api/articles/send", {
        filename: generatedFile.filename
      });
      await loadDeliveries();
      setStatus(deliveryStatusMessage(response.delivery, "Sent to Kindle."));
      flashDeliveryToast(response.delivery, "EPUB");
      setGeneratedFile({ ...generatedFile, sentToKindle: response.sent, delivery: response.delivery });
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
      await loadDeliveries();
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

  async function loadDeliveries() {
    const response = await apiGet<{ deliveries: KindleDelivery[] }>("/api/deliveries");
    setDeliveries(response.deliveries);
  }

  async function loadOpdsUrl() {
    const response = await apiGet<{ opdsUrl: string }>("/api/me/opds");
    setOpdsUrl(response.opdsUrl);
  }

  async function rotateOpdsUrl() {
    setBusyAction("opds");
    setError("");
    setStatus("Rotating OPDS URL...");

    try {
      const response = await apiPost<{ opdsUrl: string }>("/api/me/opds/rotate", {});
      setOpdsUrl(response.opdsUrl);
      setStatus("Reader sync URL rotated. Update any OPDS readers with the new URL.");
    } catch (err) {
      setStatus("");
      setError(errorMessage(err));
    } finally {
      setBusyAction(null);
    }
  }

  async function sendLatestToKindle() {
    setBusyAction("latestDelivery");
    setError("");
    setStatus("Sending latest EPUB to Kindle...");

    try {
      const response = await apiPost<{ delivery: KindleDelivery }>("/api/deliveries/latest", {});
      await loadDeliveries();
      setStatus(deliveryStatusMessage(response.delivery, "Latest EPUB sent to Kindle."));
      flashDeliveryToast(response.delivery, "Latest EPUB");
    } catch (err) {
      setStatus("");
      setError(errorMessage(err));
    } finally {
      setBusyAction(null);
    }
  }

  async function sendTestToKindle() {
    setBusyAction("testDelivery");
    setError("");
    setStatus("Sending a test EPUB to Kindle...");

    try {
      const response = await apiPost<{ delivery: KindleDelivery }>("/api/deliveries/test", {});
      await loadDeliveries();
      setStatus(deliveryStatusMessage(response.delivery, "Test EPUB sent to Kindle."));
      flashDeliveryToast(response.delivery, "Test EPUB");
    } catch (err) {
      setStatus("");
      setError(errorMessage(err));
    } finally {
      setBusyAction(null);
    }
  }

  async function retryDelivery(deliveryId: string) {
    setBusyAction("retryDelivery");
    setError("");
    setStatus("Retrying Kindle delivery...");

    try {
      const response = await apiPost<{ delivery: KindleDelivery }>(`/api/deliveries/${deliveryId}/retry`, {});
      await loadDeliveries();
      setStatus(deliveryStatusMessage(response.delivery, "Delivery retry sent to Kindle."));
      flashDeliveryToast(response.delivery, "Retry");
    } catch (err) {
      setStatus("");
      setError(errorMessage(err));
    } finally {
      setBusyAction(null);
    }
  }

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
            KindleFlow emails a one-time code so you can finish signing in from this browser. New users need the invite
            code, and email sending must be configured on the server.
          </p>
          {config && !config.emailDeliveryEnabled ? (
            <p className="error">Email delivery is not configured yet. Add Gmail SMTP settings before logging in.</p>
          ) : null}
          <form onSubmit={loginCodeSent ? verifyLoginCode : requestLoginCode}>
            <label htmlFor="login-email">Email</label>
            <input
              id="login-email"
              type="email"
              value={loginEmail}
              onChange={(event) => setLoginEmail(event.target.value)}
              disabled={loginCodeSent}
              required
            />
            {config?.inviteRequired && !loginCodeSent ? (
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
            {loginCodeSent ? (
              <>
                <label htmlFor="login-code">Login code</label>
                <input
                  id="login-code"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  autoComplete="one-time-code"
                  placeholder="123456"
                  value={loginCode}
                  onChange={(event) => setLoginCode(event.target.value)}
                  required
                />
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    setLoginCodeSent(false);
                    setLoginCode("");
                    setStatus("");
                  }}
                  disabled={isBusy}
                >
                  Use a different email
                </button>
              </>
            ) : null}
            <button type="submit" disabled={isBusy || !config?.emailDeliveryEnabled}>
              {busyAction === "login"
                ? loginCodeSent
                  ? "Verifying..."
                  : "Sending..."
                : loginCodeSent
                  ? "Verify code"
                  : "Email me a login code"}
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

          <section className="card extension-callout">
            <div>
              <p className="eyebrow">Best for paid Substack</p>
              <h2>Use the KindleFlow browser extension</h2>
              <p className="muted">
                Paid Substack posts need your browser login. The extension captures the article you can already read,
                generates the EPUB, and sends it to Kindle without copying Substack cookies.
              </p>
            </div>
            <div className="extension-steps">
              <span>1. Sign in here</span>
              <span>2. Open the paid post</span>
              <span>3. Click the extension</span>
            </div>
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
            <div className="delivery-actions">
              <button
                type="button"
                className="secondary"
                onClick={sendTestToKindle}
                disabled={isBusy || !config?.emailDeliveryEnabled || !user.kindleEmail}
              >
                {busyAction === "testDelivery" ? "Sending test..." : "Send test EPUB"}
              </button>
              <button
                type="button"
                className="secondary"
                onClick={sendLatestToKindle}
                disabled={isBusy || !config?.emailDeliveryEnabled || !user.kindleEmail}
              >
                {busyAction === "latestDelivery" ? "Sending latest..." : "Send latest EPUB now"}
              </button>
            </div>
            <p className="muted">
              Delivery history shows whether Gmail accepted the message. Amazon can still reject it later if the sender is
              not approved or the Kindle address is wrong.
            </p>
          </section>

          <section className="card">
            <div className="preview-heading">
              <div>
                <h2>Kindle delivery history</h2>
                <p className="muted">Recent send attempts, SMTP responses, and errors for Kindle email delivery.</p>
              </div>
              <button type="button" className="secondary" onClick={loadDeliveries} disabled={isBusy}>
                Refresh
              </button>
            </div>
            {deliveries.length > 0 ? (
              <div className="delivery-list">
                {deliveries.map((delivery) => (
                  <article className={`delivery delivery-${delivery.status}`} key={delivery.id}>
                    <div>
                      <strong>{delivery.title}</strong>
                      <span>{delivery.filename}</span>
                      <small>
                        {deliveryStatusLabel(delivery)} · {delivery.trigger} · {formatDate(delivery.updatedAt)}
                      </small>
                      {delivery.response ? <small>SMTP: {delivery.response}</small> : null}
                      {delivery.messageId ? <small>Message ID: {delivery.messageId}</small> : null}
                      {delivery.error ? <small className="delivery-error">Error: {delivery.error}</small> : null}
                    </div>
                    {delivery.status === "failed" ? (
                      <button type="button" onClick={() => retryDelivery(delivery.id)} disabled={isBusy}>
                        {busyAction === "retryDelivery" ? "Retrying..." : "Retry"}
                      </button>
                    ) : null}
                  </article>
                ))}
              </div>
            ) : (
              <p className="muted">No Kindle delivery attempts yet.</p>
            )}
          </section>

          <section className="card">
            <h2>Reader sync</h2>
            <p className="muted">
              Use this private OPDS catalog URL in KOReader or another OPDS reader to browse generated KindleFlow EPUBs.
              Keep it private; rotating it invalidates the old URL.
            </p>
            <label htmlFor="opds-url">Private OPDS URL</label>
            <div className="input-row">
              <input id="opds-url" value={opdsUrl} readOnly />
              <button type="button" onClick={() => navigator.clipboard.writeText(opdsUrl)} disabled={!opdsUrl}>
                Copy
              </button>
            </div>
            <div className="action-buttons reader-actions">
              <button type="button" className="secondary" onClick={rotateOpdsUrl} disabled={isBusy}>
                {busyAction === "opds" ? "Rotating..." : "Rotate OPDS URL"}
              </button>
            </div>
            <p className="muted">
              KOReader path: OPDS catalog → add catalog → paste this URL → open Recent or Subscriptions → download EPUBs.
            </p>
          </section>

          <form className="card url-form" onSubmit={fetchArticle}>
            <label htmlFor="article-url">Article URL</label>
            <p className="muted">
              Works best for public articles. For paid Substack posts, use the browser extension so KindleFlow can import
              the article from your logged-in browser session.
            </p>
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

          {result && result.kind === "article" ? (
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
                <h2>Your {getFileTypeLabel(generatedFile.mimeType)} is ready</h2>
                <p>{generatedFile.filename}</p>
              </div>
              <div className="action-buttons">
                <a className="button" href={generatedFile.downloadUrl}>
                  Download {getFileTypeLabel(generatedFile.mimeType)}
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

      {toast ? (
        <div className={`toast toast-${toast.kind}`} role="status" aria-live="polite" key={toast.id}>
          {toast.message}
        </div>
      ) : null}
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

function parseExtensionImportMessage(value: unknown): ExtensionImportPayload | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const message = value as { source?: unknown; kind?: unknown; payload?: unknown };
  if (message.source !== "kindleflow-extension" || message.kind !== "article-html") {
    return null;
  }

  const payload = message.payload as { sourceUrl?: unknown; html?: unknown } | undefined;
  if (!payload || typeof payload.sourceUrl !== "string" || typeof payload.html !== "string") {
    return null;
  }

  return {
    sourceUrl: payload.sourceUrl,
    html: payload.html
  };
}

function deliveryStatusMessage(delivery: KindleDelivery | undefined, fallback: string): string {
  if (!delivery) {
    return fallback;
  }
  if (delivery.status === "sent") {
    return `${fallback} Gmail accepted the Kindle email; check Amazon delivery if it does not appear soon.`;
  }
  if (delivery.status === "failed") {
    return `${fallback} Kindle email failed: ${delivery.error ?? "unknown error"}`;
  }
  return fallback;
}

function deliveryStatusLabel(delivery: KindleDelivery): string {
  if (delivery.status === "sent") {
    return `SMTP accepted after ${delivery.attempts} attempt(s)`;
  }
  if (delivery.status === "failed") {
    return `Failed after ${delivery.attempts} attempt(s)`;
  }
  return "Pending";
}

function formatDate(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "short",
    timeStyle: "short"
  }).format(parsed);
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // The app works normally without install support.
    });
  });
}
