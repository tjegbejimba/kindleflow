const DEFAULT_APP_URL = "https://kindleflow.tail217062.ts.net";
const MAX_CAPTURE_BYTES = 4.5 * 1024 * 1024;

const appUrlInput = document.querySelector("#app-url");
const sendButton = document.querySelector("#send-button");
const manualSendButton = document.querySelector("#manual-send-button");
const statusElement = document.querySelector("#status");
const resultElement = document.querySelector("#result");
const resultTitleElement = document.querySelector("#result-title");
const resultFilenameElement = document.querySelector("#result-filename");
const downloadLink = document.querySelector("#download-link");
const openAppLink = document.querySelector("#open-app-link");

let latestGeneratedFile = null;
let latestAppUrl = DEFAULT_APP_URL;

document.addEventListener("DOMContentLoaded", async () => {
  const options = await storageGet({ appUrl: DEFAULT_APP_URL });
  appUrlInput.value = options.appUrl || DEFAULT_APP_URL;
});

sendButton.addEventListener("click", () => {
  sendCurrentPage().catch((error) => {
    setStatus(error instanceof Error ? error.message : "Could not send this page.", true);
  });
});

manualSendButton.addEventListener("click", () => {
  sendGeneratedFileToKindle().catch((error) => {
    setStatus(error instanceof Error ? error.message : "Could not send this EPUB to Kindle.", true);
  });
});

async function sendCurrentPage() {
  setWorking(true);
  hideResult();
  setStatus("Capturing current page...");

  try {
    const appUrl = normalizeAppUrl(appUrlInput.value);
    latestAppUrl = appUrl;
    await storageSet({ appUrl });
    await ensureHostPermission(appUrl);

    await requireKindleFlowSession(appUrl);

    const activeTab = await getActiveTab();
    const capturedPage = await captureTab(activeTab.id);

    setStatus("Importing article...");
    const imported = await apiPost(appUrl, "/api/articles/import", {
      sourceUrl: capturedPage.sourceUrl,
      html: capturedPage.html
    });

    setStatus("Generating EPUB...");
    const generated = await apiPost(appUrl, "/api/articles/generate", {
      ...imported.article,
      sourceUrl: imported.sourceUrl
    });

    latestGeneratedFile = generated;
    showResult(appUrl, imported.article.title, generated);
    if (generated.sentToKindle) {
      setStatus(deliveryMessage(generated.delivery, "EPUB generated and sent to Kindle."));
    } else if (generated.delivery?.status === "failed") {
      setStatus(deliveryMessage(generated.delivery, "EPUB generated, but Kindle email failed."), true);
    } else {
      setStatus("EPUB generated. Use the buttons below to download or send it.");
    }
  } finally {
    setWorking(false);
  }
}

async function sendGeneratedFileToKindle() {
  if (!latestGeneratedFile) {
    throw new Error("Generate an EPUB before sending to Kindle.");
  }

  setWorking(true);
  setStatus("Sending EPUB to Kindle...");

  try {
    const response = await apiPost(latestAppUrl, "/api/articles/send", {
      filename: latestGeneratedFile.filename
    });
    latestGeneratedFile = {
      ...latestGeneratedFile,
      sentToKindle: response.sent,
      delivery: response.delivery
    };
    manualSendButton.hidden = response.sent;
    setStatus(deliveryMessage(response.delivery, "Sent to Kindle."));
  } finally {
    setWorking(false);
  }
}

async function requireKindleFlowSession(appUrl) {
  const response = await apiGet(appUrl, "/api/me");
  if (!response.user) {
    throw new Error(`Sign in to KindleFlow first, then try again: ${appUrl}`);
  }
}

async function getActiveTab() {
  const tabs = await chromeCall(chrome.tabs, "query", { active: true, currentWindow: true });
  const [tab] = tabs;
  if (!tab?.id) {
    throw new Error("No active tab found.");
  }
  return tab;
}

async function captureTab(tabId) {
  const [injection] = await chromeCall(chrome.scripting, "executeScript", {
    target: { tabId },
    func: captureCurrentPage
  });
  const payload = injection?.result;
  if (!payload?.sourceUrl || !payload?.html) {
    throw new Error("Could not capture article HTML from this tab.");
  }

  if (new Blob([payload.html]).size > MAX_CAPTURE_BYTES) {
    throw new Error("This page is too large to send to KindleFlow.");
  }

  return payload;
}

function captureCurrentPage() {
  const clone = document.documentElement.cloneNode(true);
  clone.querySelectorAll("script, noscript, iframe").forEach((element) => element.remove());
  return {
    sourceUrl: window.location.href,
    title: document.title,
    html: `<!doctype html>\n${clone.outerHTML}`
  };
}

async function apiGet(appUrl, path) {
  const response = await fetch(`${appUrl}${path}`, {
    credentials: "include"
  });
  return readApiResponse(response);
}

async function apiPost(appUrl, path, body) {
  const response = await fetch(`${appUrl}${path}`, {
    method: "POST",
    credentials: "include",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
  return readApiResponse(response);
}

async function readApiResponse(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof payload.message === "string" ? payload.message : "Request failed.";
    throw new Error(message);
  }
  return payload;
}

async function ensureHostPermission(appUrl) {
  const origin = `${new URL(appUrl).origin}/*`;
  const hasPermission = await chromeCall(chrome.permissions, "contains", { origins: [origin] });
  if (hasPermission) {
    return;
  }

  const granted = await chromeCall(chrome.permissions, "request", { origins: [origin] });
  if (!granted) {
    throw new Error(`Allow extension access to ${new URL(appUrl).origin} before sending articles.`);
  }
}

function normalizeAppUrl(value) {
  const url = new URL(value || DEFAULT_APP_URL);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("KindleFlow URL must start with http:// or https://.");
  }
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/, "");
}

function showResult(appUrl, title, generatedFile) {
  resultTitleElement.textContent = title;
  resultFilenameElement.textContent = generatedFile.filename;
  downloadLink.href = absoluteAppUrl(appUrl, generatedFile.downloadUrl);
  openAppLink.href = appUrl;
  manualSendButton.hidden = generatedFile.sentToKindle;
  resultElement.hidden = false;
}

function hideResult() {
  latestGeneratedFile = null;
  resultElement.hidden = true;
  manualSendButton.hidden = true;
}

function absoluteAppUrl(appUrl, path) {
  return new URL(path, `${appUrl}/`).toString();
}

function deliveryMessage(delivery, fallback) {
  if (!delivery) {
    return fallback;
  }
  if (delivery.status === "sent") {
    return `${fallback} Gmail accepted the Kindle email.`;
  }
  if (delivery.status === "failed") {
    return `${fallback} ${delivery.error ?? "Unknown delivery error."}`;
  }
  return fallback;
}

function setWorking(isWorking) {
  sendButton.disabled = isWorking;
  manualSendButton.disabled = isWorking;
  sendButton.textContent = isWorking ? "Sending..." : "Send current page";
}

function setStatus(message, isError = false) {
  statusElement.textContent = message;
  statusElement.style.color = isError ? "#8a1f12" : "#5d5349";
}

function storageGet(defaults) {
  return chromeCall(chrome.storage.sync, "get", defaults);
}

function storageSet(values) {
  return chromeCall(chrome.storage.sync, "set", values);
}

function chromeCall(target, method, ...args) {
  return new Promise((resolve, reject) => {
    target[method](...args, (result) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(result);
    });
  });
}
