// Background service worker (Manifest V3)
// - Keeps extension settings initialized.
// - Receives scraped invoice payload from content script.
// - Stores payload to chrome.storage.local and opens bundled print page.

const DEFAULT_SETTINGS = {
  idareAdi: "",
  muayeneEdilenYer: "",
  komisyonBaskani: "",
  uyeler: [""],
  okulMuduru: ""
};

const STORAGE_KEYS = {
  SETTINGS: "mkf_settings",
  PRINT_PAYLOAD: "mkf_print_payload"
};
const CONTENT_SCRIPT_FILE = "content.js";
const TARGET_PAGE_PATTERNS = [
  /^https:\/\/butunlesik\.hmb\.gov\.tr\/hys\/mys-efaturaislemleri\/goruntuleHtml(?:[/?#].*)?$/i,
  /^https:\/\/butunlesik\.hmb\.gov\.tr\/hys\/mys-efaturaislemleri\/efatura\/query(?:[/?#].*)?$/i
];

// Initialize missing settings on install/update.
chrome.runtime.onInstalled.addListener(async () => {
  const stored = await storageGet(STORAGE_KEYS.SETTINGS);
  const merged = {
    ...DEFAULT_SETTINGS,
    ...(stored[STORAGE_KEYS.SETTINGS] || {})
  };

  await storageSet({ [STORAGE_KEYS.SETTINGS]: merged });
});

// Open options page when extension icon is clicked.
chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const candidateUrl = changeInfo.url || tab?.url || "";
  if (!isTargetPageUrl(candidateUrl)) {
    return;
  }

  // Status is only present for load lifecycle updates.
  if (changeInfo.status && changeInfo.status !== "complete") {
    return;
  }

  void ensureContentScriptInjected(tabId, candidateUrl);
});

chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId !== 0) {
    return;
  }
  if (!isTargetPageUrl(details.url)) {
    return;
  }
  void ensureContentScriptInjected(details.tabId, details.url);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.type) {
    return;
  }

  if (message.type === "MKF_OPEN_PRINT_PAGE") {
    handleOpenPrintPage(message.payload)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => {
        sendResponse({ ok: false, error: error?.message || "Bilinmeyen hata" });
      });

    // Keep message channel open for async response.
    return true;
  }

  if (message.type === "MKF_OPEN_OPTIONS_PAGE") {
    chrome.runtime.openOptionsPage(() => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      sendResponse({ ok: true });
    });
    return true;
  }
});

async function handleOpenPrintPage(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Geçersiz payload");
  }

  const record = {
    ...payload,
    __meta: {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      createdAt: new Date().toISOString()
    }
  };

  await storageSet({ [STORAGE_KEYS.PRINT_PAYLOAD]: record });

  const printUrl = `${chrome.runtime.getURL("print.html")}#${encodeURIComponent(record.__meta.id)}`;
  const tab = await createTab(printUrl);

  return {
    tabId: tab.id,
    payloadId: record.__meta.id
  };
}

function storageGet(keyOrKeys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keyOrKeys, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(result);
    });
  });
}

function storageSet(data) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(data, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

function createTab(url) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create({ url }, (tab) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(tab);
    });
  });
}

function isTargetPageUrl(url) {
  const text = String(url || "");
  if (!text) {
    return false;
  }
  return TARGET_PAGE_PATTERNS.some((pattern) => pattern.test(text));
}

async function ensureContentScriptInjected(tabId, url) {
  if (!Number.isInteger(tabId) || tabId < 0 || !isTargetPageUrl(url)) {
    return;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [CONTENT_SCRIPT_FILE]
    });
  } catch (error) {
    const message = error?.message || "";
    const ignorable =
      message.includes("Cannot access contents of url") ||
      message.includes("No tab with id") ||
      message.includes("Frame with ID 0 was removed");

    if (!ignorable) {
      console.warn("MKF content script injection failed:", message || error);
    }
  }
}
