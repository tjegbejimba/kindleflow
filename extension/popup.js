const DEFAULT_APP_URL = "https://kindleflow.tail217062.ts.net";
const MAX_CAPTURE_BYTES = 4.5 * 1024 * 1024;

const appUrlInput = document.querySelector("#app-url");
const sendButton = document.querySelector("#send-button");
const statusElement = document.querySelector("#status");

document.addEventListener("DOMContentLoaded", async () => {
  const options = await storageGet({ appUrl: DEFAULT_APP_URL });
  appUrlInput.value = options.appUrl || DEFAULT_APP_URL;
});

sendButton.addEventListener("click", () => {
  sendCurrentPage().catch((error) => {
    setStatus(error instanceof Error ? error.message : "Could not send this page.", true);
  });
});

async function sendCurrentPage() {
  setWorking(true);
  setStatus("Capturing current page...");

  try {
    const appUrl = normalizeAppUrl(appUrlInput.value);
    await storageSet({ appUrl });
    await ensureHostPermission(appUrl);

    const activeTab = await getActiveTab();
    const payload = await captureTab(activeTab.id);

    setStatus("Opening KindleFlow...");
    const kindleFlowTab = await tabsCreate({ url: appUrl });
    await waitForTabComplete(kindleFlowTab.id);
    await deliverToKindleFlow(kindleFlowTab.id, payload);
    setStatus("Opened KindleFlow preview. Generate the EPUB there.");
  } finally {
    setWorking(false);
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

async function deliverToKindleFlow(tabId, payload) {
  await chromeCall(chrome.scripting, "executeScript", {
    target: { tabId },
    func: postArticleToKindleFlow,
    args: [payload]
  });
}

function postArticleToKindleFlow(payload) {
  const send = () => {
    window.postMessage(
      {
        source: "kindleflow-extension",
        kind: "article-html",
        payload
      },
      window.location.origin
    );
  };

  const waitForApp = () => {
    if (document.querySelector("main.shell")) {
      window.setTimeout(send, 100);
      return;
    }
    window.setTimeout(waitForApp, 100);
  };

  waitForApp();
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

async function waitForTabComplete(tabId) {
  const tab = await chromeCall(chrome.tabs, "get", tabId);
  if (tab.status === "complete") {
    return;
  }

  await new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("KindleFlow took too long to open."));
    }, 15_000);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") {
        return;
      }

      window.clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
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

function setWorking(isWorking) {
  sendButton.disabled = isWorking;
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

function tabsCreate(options) {
  return chromeCall(chrome.tabs, "create", options);
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
