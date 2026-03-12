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
