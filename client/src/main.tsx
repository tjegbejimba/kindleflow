import React from "react";
import { createRoot } from "react-dom/client";
import { GeneratedFileActions } from "./GeneratedFileActions.js";
import { KindleDeviceList, KindleTargetPicker } from "./KindleDeviceSettings.js";
import {
  defaultKindleIds,
  deliveryToast,
  kindleSelectionForRequest,
  type KindleDeviceView
} from "./kindleDevices.js";
import { visibleGeneratedFileAfterDelivery } from "./generatedFileVisibility.js";
import { OnboardingGate } from "./OnboardingGate.js";
import {
  computeOnboardingState,
  hasSuccessfulDelivery,
  onboardingSenderConfirmedKey
} from "./onboarding.js";
import "./styles.css";

interface AppConfig {
  emailDeliveryEnabled: boolean;
  authRequired: boolean;
  authMode: "header-trust";
  authDevBypassActive: boolean;
  kindleApprovedSender?: string;
  kindleSettingsUrl: string;
}

interface UserProfile {
  id: string;
  email: string;
  displayName?: string;
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

interface PdfAnalysis {
  verdict:
    | "good-epub-candidate"
    | "mixed-conversion-quality"
    | "better-as-pdf"
    | "not-convertible"
    | "analysis-unavailable";
  reasons: string[];
}

interface PdfFetchResult {
  kind: "pdf";
  sourceUrl: string;
  title: string;
  analysis: PdfAnalysis;
  generated: {
    filename: string;
    mimeType: "application/pdf";
    downloadUrl: string;
    sentToKindle: boolean;
    delivery?: KindleDelivery;
    deliveries?: KindleDelivery[];
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
  deliveries?: KindleDelivery[];
}

interface DeliveryResponse {
  delivery?: KindleDelivery;
  deliveries?: KindleDelivery[];
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

// oxlint-disable-next-line react-doctor/prefer-useReducer
function ApiTokensCard(): React.JSX.Element {
  interface TokenSummary {
    id: string;
    name: string;
    createdAt: string;
    lastUsedAt?: string;
  }
  const [tokens, setTokens] = React.useState<TokenSummary[]>([]);
  const [newName, setNewName] = React.useState("");
  const [justMinted, setJustMinted] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loaded, setLoaded] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const res = await fetch("/api/tokens", { credentials: "include" });
      if (!res.ok) throw new Error((await res.json()).message ?? `HTTP ${res.status}`);
      const data = await res.json();
      setTokens(data.tokens);
      setLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setJustMinted(null);
    try {
      const res = await fetch("/api/tokens", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: newName })
      });
      if (!res.ok) throw new Error((await res.json()).message ?? `HTTP ${res.status}`);
      const data = await res.json();
      setJustMinted(data.token.token as string);
      setNewName("");
      void load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const revoke = async (id: string) => {
    if (!confirm("Revoke this token? Any CLI / MCP client using it will stop working immediately.")) return;
    try {
      const res = await fetch(`/api/tokens/${encodeURIComponent(id)}`, {
        method: "DELETE",
        credentials: "include"
      });
      if (!res.ok) throw new Error((await res.json()).message ?? `HTTP ${res.status}`);
      void load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <section className="card">
      <h2>API tokens</h2>
      <p className="muted">
        Personal tokens for the KindleFlow CLI and MCP server. Tokens grant your account full access except for
        managing tokens themselves (you'll always need to come back here to mint or revoke).
      </p>
      <form onSubmit={create} style={{ display: "flex", gap: "0.5em", flexWrap: "wrap" }}>
        <input
          type="text"
          aria-label="API token name"
          placeholder="Token name (e.g. Laptop CLI)"
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          required
        />
        <button type="submit">Mint token</button>
      </form>
      {justMinted ? (
        <div className="sender-help" style={{ marginTop: "0.75em" }}>
          <p>
            <strong>Copy this now, it will not be shown again:</strong>
          </p>
          <code style={{ wordBreak: "break-all" }}>{justMinted}</code>
          <div className="action-buttons">
            <button type="button" className="secondary" onClick={() => navigator.clipboard.writeText(justMinted)}>
              Copy token
            </button>
            <button type="button" className="secondary" onClick={() => setJustMinted(null)}>
              Dismiss
            </button>
          </div>
        </div>
      ) : null}
      {error ? <p className="muted" style={{ color: "var(--error, #c00)" }}>Error: {error}</p> : null}
      {loaded && tokens.length === 0 ? <p className="muted">No tokens yet.</p> : null}
      {tokens.length > 0 ? (
        <ul style={{ listStyle: "none", padding: 0 }}>
          {tokens.map((token) => (
            <li
              key={token.id}
              style={{
                display: "flex",
                gap: "1em",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "0.5em 0",
                borderBottom: "1px solid rgba(0,0,0,0.08)"
              }}
            >
              <span>
                <strong>{token.name}</strong>
                <br />
                <span className="muted" style={{ fontSize: "0.85em" }}>
                  created {token.createdAt}
                  {token.lastUsedAt ? ` · last used ${token.lastUsedAt}` : " · never used"}
                </span>
              </span>
              <button type="button" className="secondary" onClick={() => revoke(token.id)}>
                Revoke
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

// oxlint-disable-next-line react-doctor/no-giant-component, react-doctor/prefer-useReducer
function App() {
  const [config, setConfig] = React.useState<AppConfig | null>(null);
  // oxlint-disable-next-line react-doctor/rerender-state-only-in-handlers
  const [authLoaded, setAuthLoaded] = React.useState(false);
  const [user, setUser] = React.useState<UserProfile | null>(null);
  const [subscriptions, setSubscriptions] = React.useState<Subscription[]>([]);
  const [deliveries, setDeliveries] = React.useState<KindleDelivery[]>([]);
  const [opdsUrl, setOpdsUrl] = React.useState("");
  const [kindleEmail, setKindleEmail] = React.useState("");
  const [kindleDevices, setKindleDevices] = React.useState<KindleDeviceView[]>([]);
  const [selectedKindleIds, setSelectedKindleIds] = React.useState<string[]>([]);
  const [autoSendToKindle, setAutoSendToKindle] = React.useState(true);
  const [subscriptionRetentionDays, setSubscriptionRetentionDays] = React.useState(30);
  const [url, setUrl] = React.useState("");
  const [subscriptionUrl, setSubscriptionUrl] = React.useState("");
  const [result, setResult] = React.useState<FetchResult | null>(null);
  const [generatedFile, setGeneratedFile] = React.useState<GeneratedFile | null>(null);
  const [isGeneratedFileExpanded, setGeneratedFileExpanded] = React.useState(true);
  const [pdfAnalysis, setPdfAnalysis] = React.useState<PdfAnalysis | null>(null);
  // oxlint-disable-next-line react-doctor/rerender-state-only-in-handlers
  const [pendingExtensionImport, setPendingExtensionImport] = React.useState<ExtensionImportPayload | null>(null);
  const [selectedFile, setSelectedFile] = React.useState<File | null>(null);
  const [uploadTitle, setUploadTitle] = React.useState("");
  const [status, setStatus] = React.useState("");
  const [error, setError] = React.useState("");
  const [toast, setToast] = React.useState<{ id: number; kind: "success" | "error"; message: string } | null>(null);
  const toastTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const [senderConfirmed, setSenderConfirmed] = React.useState(false);

  const flashToast = React.useCallback((kind: "success" | "error", message: string) => {
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
    }
    setToast({ id: Date.now(), kind, message });
    toastTimerRef.current = setTimeout(() => setToast(null), 5000);
  }, []);

  const flashDeliveryToast = React.useCallback(
    (response: DeliveryResponse, action: string) => {
      const toastContent = deliveryToast(deliveriesFrom(response), action);
      if (toastContent) flashToast(toastContent.kind, toastContent.message);
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
    | "upload"
    | "kindles"
    | null
  >(null);

  const isBusy = busyAction !== null;

  function getFileTypeLabel(mimeType: "application/epub+zip" | "application/pdf"): string {
    return mimeType === "application/pdf" ? "PDF" : "EPUB";
  }

  function getVerdictLabel(verdict: PdfAnalysis["verdict"]): string {
    switch (verdict) {
      case "good-epub-candidate":
        return "Good EPUB candidate";
      case "mixed-conversion-quality":
        return "Mixed conversion quality";
      case "better-as-pdf":
        return "Better as PDF";
      case "not-convertible":
        return "Not convertible";
      case "analysis-unavailable":
        return "Analysis unavailable";
    }
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
          void loadKindles();
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

  // oxlint-disable-next-line react-doctor/no-cascading-set-state
  React.useEffect(() => {
    if (!pendingExtensionImport || !authLoaded) {
      return;
    }

    if (!user) {
      // oxlint-disable-next-line react-doctor/no-chain-state-updates
      setPendingExtensionImport(null);
      // oxlint-disable-next-line react-doctor/no-chain-state-updates
      setStatus("");
      // oxlint-disable-next-line react-doctor/no-chain-state-updates
      setError("Sign in to KindleFlow through your SSO proxy, then click the extension button again to import this article.");
      return;
    }

    void importExtensionArticle(pendingExtensionImport);
  }, [authLoaded, pendingExtensionImport, user]);

  function applyUser(nextUser: UserProfile | null) {
    setUser(nextUser);
    setKindleEmail(nextUser?.kindleEmail ?? "");
    setAutoSendToKindle(nextUser?.autoSendToKindle ?? true);
    setSubscriptionRetentionDays(nextUser?.subscriptionRetentionDays ?? 30);
    if (nextUser) {
      setSenderConfirmed(readLocalFlag(onboardingSenderConfirmedKey(nextUser.id)));
    } else {
      setSenderConfirmed(false);
    }
  }

  function changeSenderConfirmed(confirmed: boolean) {
    setSenderConfirmed(confirmed);
    if (user) {
      writeLocalFlag(onboardingSenderConfirmedKey(user.id), confirmed);
    }
  }

  function copyApprovedSender() {
    if (config?.kindleApprovedSender) {
      void navigator.clipboard.writeText(config.kindleApprovedSender);
    }
  }

  async function persistProfile({ includeKindleEmail }: { includeKindleEmail: boolean }) {
    setBusyAction("profile");
    setError("");
    setStatus("Saving profile...");

    try {
      // Kindle addresses are managed via /api/kindles once onboarding is done.
      const response = await apiPatch<{ user: UserProfile }>("/api/me", {
        ...(includeKindleEmail ? { kindleEmail } : {}),
        autoSendToKindle,
        subscriptionRetentionDays
      });
      applyUser(response.user);
      if (includeKindleEmail) await loadKindles();
      setStatus("Profile saved.");
    } catch (err) {
      setStatus("");
      setError(errorMessage(err));
    } finally {
      setBusyAction(null);
    }
  }

  async function saveProfile(event: React.FormEvent) {
    event.preventDefault();
    await persistProfile({ includeKindleEmail: false });
  }

  async function fetchArticle(event: React.FormEvent) {
    event.preventDefault();
    setBusyAction("fetch");
    setError("");
    setStatus("Fetching and extracting article...");
    setGeneratedFile(null);
    setGeneratedFileExpanded(true);

    try {
      const response = await apiPost<FetchResult>("/api/articles/fetch", { url });
      if (response.kind === "pdf") {
        setResult(null);
        setPdfAnalysis(response.analysis);
        setGeneratedFile({
          filename: response.generated.filename,
          mimeType: response.generated.mimeType,
          downloadUrl: response.generated.downloadUrl,
          sentToKindle: response.generated.sentToKindle,
          delivery: response.generated.delivery,
          deliveries: response.generated.deliveries
        });
        setGeneratedFileExpanded(true);
        await loadDeliveries();
        setStatus(deliveryStatusMessage(deliveriesFrom(response.generated), "PDF imported."));
        flashDeliveryToast(response.generated, "PDF");
      } else {
        setResult(response);
        setPdfAnalysis(null);
        setStatus("Article extracted. Review the preview, then generate your Kindle file.");
      }
    } catch (err) {
      setResult(null);
      setPdfAnalysis(null);
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
    setGeneratedFileExpanded(true);

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
      const visibleFile = visibleGeneratedFileAfterDelivery(response);
      setGeneratedFile(visibleFile);
      setGeneratedFileExpanded(Boolean(visibleFile));
      await loadDeliveries();
      setStatus(deliveryStatusMessage(deliveriesFrom(response), "EPUB generated."));
      flashDeliveryToast(response, "EPUB");
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
      const response = await apiPost<{ sent: boolean } & DeliveryResponse>("/api/articles/send", {
        filename: generatedFile.filename,
        ...kindleSelectionForRequest(kindleDevices, selectedKindleIds)
      });
      await loadDeliveries();
      setStatus(deliveryStatusMessage(deliveriesFrom(response), "Sent to Kindle."));
      flashDeliveryToast(response, getFileTypeLabel(generatedFile.mimeType));
      const visibleFile = visibleGeneratedFileAfterDelivery({
        ...generatedFile,
        sentToKindle: response.sent,
        delivery: response.delivery,
        deliveries: response.deliveries
      });
      setGeneratedFile(visibleFile);
      setGeneratedFileExpanded(Boolean(visibleFile));
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
      await Promise.all([loadSubscriptions(), loadDeliveries()]);
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

  async function loadKindles() {
    const response = await apiGet<{ devices: KindleDeviceView[] }>("/api/kindles");
    setKindleDevices(response.devices);
    setSelectedKindleIds(defaultKindleIds(response.devices));
  }

  async function changeKindles(work: () => Promise<{ devices: KindleDeviceView[] }>, progress: string, done: string) {
    setBusyAction("kindles");
    setError("");
    setStatus(progress);
    try {
      const response = await work();
      setKindleDevices(response.devices);
      setSelectedKindleIds(defaultKindleIds(response.devices));
      // The primary Kindle is mirrored onto the profile, which gates the send buttons.
      const me = await apiGet<{ user: UserProfile | null }>("/api/me");
      applyUser(me.user);
      setStatus(done);
      return true;
    } catch (err) {
      setStatus("");
      setError(errorMessage(err));
      return false;
    } finally {
      setBusyAction(null);
    }
  }

  function addKindle(name: string, email: string) {
    return changeKindles(
      () => apiPost("/api/kindles", { name: name || undefined, email }),
      "Adding Kindle...",
      "Kindle added. Make sure the approved sender is on its Amazon account."
    );
  }

  function removeKindle(device: KindleDeviceView) {
    if (!window.confirm(`Remove ${device.name} (${device.email})?`)) return;
    void changeKindles(() => apiDelete(`/api/kindles/${device.id}`), "Removing Kindle...", `${device.name} removed.`);
  }

  function toggleKindleDefault(device: KindleDeviceView, sendByDefault: boolean) {
    void changeKindles(
      () => apiPatch(`/api/kindles/${device.id}`, { sendByDefault }),
      "Saving Kindle...",
      sendByDefault ? `${device.name} will receive automatic sends.` : `${device.name} will only receive manual sends.`
    );
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
      const response = await apiPost<DeliveryResponse>(
        "/api/deliveries/latest",
        kindleSelectionForRequest(kindleDevices, selectedKindleIds)
      );
      await loadDeliveries();
      setStatus(deliveryStatusMessage(deliveriesFrom(response), "Latest EPUB sent to Kindle."));
      flashDeliveryToast(response, "Latest EPUB");
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
      const response = await apiPost<DeliveryResponse>(
        "/api/deliveries/test",
        kindleSelectionForRequest(kindleDevices, selectedKindleIds)
      );
      await loadDeliveries();
      setStatus(deliveryStatusMessage(deliveriesFrom(response), "Test EPUB sent to Kindle."));
      flashDeliveryToast(response, "Test EPUB");
    } catch (err) {
      setStatus("");
      setError(errorMessage(err));
    } finally {
      setBusyAction(null);
    }
  }

  async function uploadFile(event: React.FormEvent) {
    event.preventDefault();
    if (!selectedFile) return;

    setBusyAction("upload");
    setError("");
    setStatus("Uploading file...");

    try {
      // Text fields must precede the file part so the server's multipart parser sees them.
      const formData = new FormData();
      if (uploadTitle.trim()) {
        formData.append("title", uploadTitle.trim());
      }
      const { kindles } = kindleSelectionForRequest(kindleDevices, selectedKindleIds);
      if (kindles) {
        formData.append("kindles", kindles.join(","));
      }
      formData.append("file", selectedFile);

      const res = await fetch("/api/files/upload", {
        method: "POST",
        credentials: "include",
        body: formData
      });

      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error ?? `HTTP ${res.status}`);
      }

      const data = (await res.json()) as { title: string } & DeliveryResponse;
      setStatus(deliveryStatusMessage(deliveriesFrom(data), `File uploaded: ${data.title}.`));
      flashDeliveryToast(data, "Upload");
      setSelectedFile(null);
      setUploadTitle("");
      await loadDeliveries();
    } catch (err) {
      setError(errorMessage(err));
      setStatus("");
    } finally {
      setBusyAction(null);
    }
  }

  async function retryDelivery(deliveryId: string) {
    setBusyAction("retryDelivery");
    setError("");
    setStatus("Retrying Kindle delivery...");

    try {
      const response = await apiPost<DeliveryResponse>(`/api/deliveries/${deliveryId}/retry`, {});
      await loadDeliveries();
      setStatus(deliveryStatusMessage(deliveriesFrom(response), "Delivery retry sent to Kindle."));
      flashDeliveryToast(response, "Retry");
    } catch (err) {
      setStatus("");
      setError(errorMessage(err));
    } finally {
      setBusyAction(null);
    }
  }

  const onboarding = computeOnboardingState({
    emailDeliveryEnabled: Boolean(config?.emailDeliveryEnabled),
    kindleEmailSet: Boolean(user?.kindleEmail),
    senderConfirmed,
    testDeliverySucceeded: hasSuccessfulDelivery(deliveries)
  });

  const canSendManually = Boolean(config?.emailDeliveryEnabled && user?.kindleEmail);
  const hasKindleSelection = kindleDevices.length <= 1 || selectedKindleIds.length > 0;

  if (user && onboarding.visible) {
    return (
      <main>
        <OnboardingGate
          state={onboarding}
          emailDeliveryEnabled={Boolean(config?.emailDeliveryEnabled)}
          kindleApprovedSender={config?.kindleApprovedSender}
          kindleSettingsUrl={config?.kindleSettingsUrl ?? "https://www.amazon.com/hz/mycd/myx#/home/settings/payment"}
          kindleEmail={kindleEmail}
          onKindleEmailChange={setKindleEmail}
          onSaveKindleEmail={() => void persistProfile({ includeKindleEmail: true })}
          savingEmail={busyAction === "profile"}
          senderConfirmed={senderConfirmed}
          onSenderConfirmedChange={changeSenderConfirmed}
          onCopySender={copyApprovedSender}
          onSendTest={sendTestToKindle}
          sendingTest={busyAction === "testDelivery"}
          isBusy={isBusy}
          status={status}
          error={error}
        />
      </main>
    );
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
          <h2>Not signed in</h2>
          <p className="muted">
              KindleFlow relies on its upstream reverse proxy (Tinyauth/Pocket-ID) to authenticate you. Make sure
              you reached this app through that proxy.
          </p>
          {config?.authDevBypassActive ? (
            <p className="muted">
              Dev bypass is enabled but the server has not yet treated you as the dev user. Refresh the page;
              if that fails, check the server logs.
            </p>
          ) : (
            <p className="muted">
              For local development, set <code>AUTH_DEV_BYPASS=true</code> and run with{" "}
              <code>NODE_ENV=development</code>.
            </p>
          )}
        </section>
      ) : (
        <>
          <section className="card account-card">
            <div>
              <p className="eyebrow">Signed in</p>
              <h2>{user.displayName ?? user.email}</h2>
              {user.displayName ? <p className="muted">{user.email}</p> : null}
            </div>
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
              <span>1. Open KindleFlow</span>
              <span>2. Open the paid post</span>
              <span>3. Click the extension</span>
            </div>
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
                aria-label="Article URL"
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

              {/* Article HTML is sanitized server-side via sanitize-html before being returned. */}
              {/* oxlint-disable-next-line react-doctor/no-danger */}
              <article className="article-body" dangerouslySetInnerHTML={{ __html: result.article.contentHtml }} />
            </section>
          ) : null}

          {pdfAnalysis ? (
            <section className="card pdf-analysis">
              <div>
                <p className="eyebrow">PDF Analysis</p>
                <h3>{getVerdictLabel(pdfAnalysis.verdict)}</h3>
                <ul className="analysis-reasons">
                  {pdfAnalysis.reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              </div>
            </section>
          ) : null}

          {generatedFile && canSendManually && !generatedFile.sentToKindle ? (
            <KindleTargetPicker
              idPrefix="generated-target"
              devices={kindleDevices}
              selectedIds={selectedKindleIds}
              onChange={setSelectedKindleIds}
              disabled={isBusy}
            />
          ) : null}

          {generatedFile ? (
            <GeneratedFileActions
              file={generatedFile}
              fileTypeLabel={getFileTypeLabel(generatedFile.mimeType)}
              canSendToKindle={Boolean(canSendManually && hasKindleSelection && !generatedFile.sentToKindle)}
              isBusy={isBusy}
              isExpanded={isGeneratedFileExpanded}
              onExpandedChange={setGeneratedFileExpanded}
              onSendToKindle={sendToKindle}
              sendButtonLabel={busyAction === "send" ? "Sending..." : "Send to Kindle"}
            />
          ) : null}

          <form className="card upload-form" onSubmit={uploadFile}>
            <h2>Upload local PDF or EPUB</h2>
            <p className="muted">
              Upload a single PDF or EPUB file you already have on your device. File is saved to your library and can be sent to Kindle.
            </p>
            {!config?.emailDeliveryEnabled ? (
              <p className="muted warning">
                Email delivery is not configured. Files will be saved to your library and available through OPDS, but cannot be sent to Kindle.
                {!config?.kindleApprovedSender && " Configure SMTP settings in the server environment to enable delivery."}
              </p>
            ) : !user?.kindleEmail ? (
              <p className="muted warning">
                Set your Kindle email address below to enable delivery after upload.
              </p>
            ) : null}
            <label htmlFor="upload-file">Choose file (PDF or EPUB, max 50 MB)</label>
            <input
              id="upload-file"
              type="file"
              accept=".pdf,.epub"
              onChange={(e) => setSelectedFile(e.target.files?.[0] ?? null)}
            />
            {selectedFile && canSendManually ? (
              <KindleTargetPicker
                idPrefix="upload-target"
                devices={kindleDevices}
                selectedIds={selectedKindleIds}
                onChange={setSelectedKindleIds}
                disabled={isBusy}
              />
            ) : null}
            {selectedFile ? (
              <>
                <label htmlFor="upload-title">Title (optional)</label>
                <input
                  id="upload-title"
                  type="text"
                  placeholder={`Defaults to: ${selectedFile.name.replace(/\.[^.]+$/, "")}`}
                  value={uploadTitle}
                  onChange={(e) => setUploadTitle(e.target.value)}
                />
              </>
            ) : null}
            <button type="submit" disabled={isBusy || !selectedFile || (canSendManually && !hasKindleSelection)}>
              {busyAction === "upload" ? "Uploading..." : "Upload file"}
            </button>
          </form>

          <section className="card">
            <h2>Kindle settings</h2>
            <p className="muted">
              Add each Kindle’s Send-to-Kindle address and approve the SMTP sender in Amazon’s “Approved Personal
              Document E-mail List.” Kindles marked auto-send receive automatic and subscription deliveries.
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
            <KindleDeviceList
              devices={kindleDevices}
              isBusy={isBusy}
              onAdd={addKindle}
              onRemove={removeKindle}
              onToggleDefault={toggleKindleDefault}
            />
            <form onSubmit={saveProfile}>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  aria-label="Automatically send generated EPUBs to my Kindle"
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
                  aria-label="Subscription retention days"
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
            {canSendManually ? (
              <KindleTargetPicker
                idPrefix="settings-target"
                devices={kindleDevices}
                selectedIds={selectedKindleIds}
                onChange={setSelectedKindleIds}
                disabled={isBusy}
              />
            ) : null}
            <div className="delivery-actions">
              <button
                type="button"
                className="secondary"
                onClick={sendTestToKindle}
                disabled={isBusy || !canSendManually || !hasKindleSelection}
              >
                {busyAction === "testDelivery" ? "Sending test..." : "Send test EPUB"}
              </button>
              <button
                type="button"
                className="secondary"
                onClick={sendLatestToKindle}
                disabled={isBusy || !canSendManually || !hasKindleSelection}
              >
                {busyAction === "latestDelivery" ? "Sending latest..." : "Send latest EPUB now"}
              </button>
            </div>
          </section>

          <ApiTokensCard />

          <section className="card">
            <h2>Reader sync</h2>
            <p className="muted">
              Use this private OPDS catalog URL in KOReader or another OPDS reader to browse generated KindleFlow EPUBs.
              Keep it private; rotating it invalidates the old URL.
            </p>
            <label htmlFor="opds-url">Private OPDS URL</label>
            <div className="input-row">
              <input id="opds-url" aria-label="Private OPDS URL" value={opdsUrl} readOnly />
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
                aria-label="Subscription feed URL"
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

          <details className="card delivery-history">
            <summary>
              <span className="history-summary-copy">
                <span className="history-title">Kindle delivery history</span>
                <span className="muted">Recent send attempts, SMTP responses, and errors.</span>
              </span>
              <span className="history-summary-meta">
                <span className="history-count">{deliveries.length}</span>
                <span className="history-toggle" aria-hidden="true" />
              </span>
            </summary>
            <div className="delivery-history-content">
              <div className="preview-heading">
                <p className="muted">
                  Delivery history shows whether Gmail accepted the message. Amazon can still reject it later if the
                  sender is not approved or the Kindle address is wrong.
                </p>
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
                          {deliveryStatusLabel(delivery)} · {delivery.trigger} · {delivery.kindleEmail} ·{" "}
                          {formatDate(delivery.updatedAt)}
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
            </div>
          </details>
        </>
      )}

      {toast ? (
        <output className={`toast toast-${toast.kind}`} aria-live="polite" key={toast.id}>
          {toast.message}
        </output>
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

async function apiDelete<T = unknown>(url: string): Promise<T> {
  const response = await fetch(url, { method: "DELETE" });
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

function readLocalFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "true";
  } catch {
    return false;
  }
}

function writeLocalFlag(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, value ? "true" : "false");
  } catch {
    // Persisting onboarding state is best-effort; the app works without it.
  }
}

function deliveriesFrom(response: DeliveryResponse): KindleDelivery[] {
  if (response.deliveries) return response.deliveries;
  return response.delivery ? [response.delivery] : [];
}

function deliveryStatusMessage(deliveries: KindleDelivery[], fallback: string): string {
  const failed = deliveries.filter((delivery) => delivery.status === "failed");
  const sent = deliveries.filter((delivery) => delivery.status === "sent");
  if (failed.length > 0) {
    const details = failed.map((delivery) => `${delivery.kindleEmail}: ${delivery.error ?? "unknown error"}`).join("; ");
    if (sent.length > 0) {
      return `Sent to ${sent.length} of ${deliveries.length} Kindles. Failed: ${details}. Retry from delivery history.`;
    }
    return `${fallback} Kindle email failed (${details}).`;
  }
  if (sent.length > 0) {
    return `${fallback} Gmail accepted the Kindle email; check Amazon delivery if it does not appear soon.`;
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

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "short",
  timeStyle: "short"
});

function formatDate(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return value;
  }
  return dateTimeFormatter.format(parsed);
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
