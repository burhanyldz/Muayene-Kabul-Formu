// options.js
// - Stores static form fields in chrome.storage.local.
// - Supports dynamic member list (multiple Üye entries).
// - Manages reusable "Yapılan İş" history entries in a modal.

(() => {
  "use strict";

  const STORAGE_KEYS = {
    SETTINGS: "mkf_settings",
    YAPILAN_IS_HISTORY: "mkf_yapilan_is_history"
  };

  const DEFAULT_SETTINGS = {
    idareAdi: "",
    muayeneEdilenYer: "",
    komisyonBaskani: "",
    uyeler: [""],
    okulMuduru: ""
  };

  const form = document.getElementById("settingsForm");
  const openSamplePageBtn = document.getElementById("openSamplePageBtn");
  const membersContainer = document.getElementById("membersContainer");
  const addMemberBtn = document.getElementById("addMemberBtn");
  const resetBtn = document.getElementById("resetBtn");
  const statusEl = document.getElementById("status");

  const openYapilanIsModalBtn = document.getElementById("openYapilanIsModalBtn");
  const yapilanIsCountHint = document.getElementById("yapilanIsCountHint");
  const yapilanIsModal = document.getElementById("yapilanIsModal");
  const closeYapilanIsModalBtn = document.getElementById("closeYapilanIsModalBtn");
  const cancelYapilanIsBtn = document.getElementById("cancelYapilanIsBtn");
  const saveYapilanIsBtn = document.getElementById("saveYapilanIsBtn");
  const addYapilanIsBtn = document.getElementById("addYapilanIsBtn");
  const yapilanIsContainer = document.getElementById("yapilanIsContainer");

  let current = { ...DEFAULT_SETTINGS };
  let yapilanIsEntries = [];

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    bindEvents();
    loadAll();
  }

  function bindEvents() {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      await saveSettings();
    });

    addMemberBtn.addEventListener("click", () => {
      addMemberInput("");
    });

    resetBtn.addEventListener("click", async () => {
      current = { ...DEFAULT_SETTINGS };
      renderSettings(current);
      await persistSettings(current);
      setStatus("Ayarlar sıfırlandı.");
    });

    openSamplePageBtn.addEventListener("click", () => {
      const url = chrome.runtime.getURL("print.html?sample=1");
      chrome.tabs.create({ url });
    });

    openYapilanIsModalBtn.addEventListener("click", () => {
      openYapilanIsModal();
    });

    closeYapilanIsModalBtn.addEventListener("click", closeYapilanIsModal);
    cancelYapilanIsBtn.addEventListener("click", closeYapilanIsModal);

    addYapilanIsBtn.addEventListener("click", () => {
      addYapilanIsRow("");
    });

    saveYapilanIsBtn.addEventListener("click", async () => {
      await saveYapilanIsEntries();
    });

    yapilanIsModal.addEventListener("click", (event) => {
      if (event.target === yapilanIsModal) {
        closeYapilanIsModal();
      }
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && yapilanIsModal.classList.contains("open")) {
        closeYapilanIsModal();
      }
    });
  }

  async function loadAll() {
    try {
      const data = await storageGet([STORAGE_KEYS.SETTINGS, STORAGE_KEYS.YAPILAN_IS_HISTORY]);
      current = {
        ...DEFAULT_SETTINGS,
        ...(data[STORAGE_KEYS.SETTINGS] || {})
      };

      if (!Array.isArray(current.uyeler) || !current.uyeler.length) {
        current.uyeler = [""];
      }

      yapilanIsEntries = normalizeHistory(data[STORAGE_KEYS.YAPILAN_IS_HISTORY]);

      renderSettings(current);
      updateYapilanIsCountHint();
    } catch (error) {
      setStatus(`Ayarlar okunamadı: ${error.message || error}`, true);
    }
  }

  function renderSettings(settings) {
    setValue("idareAdi", settings.idareAdi);
    setValue("muayeneEdilenYer", settings.muayeneEdilenYer);
    setValue("komisyonBaskani", settings.komisyonBaskani);
    setValue("okulMuduru", settings.okulMuduru);

    membersContainer.innerHTML = "";
    settings.uyeler.forEach((member) => addMemberInput(member));

    if (!settings.uyeler.length) {
      addMemberInput("");
    }
  }

  function addMemberInput(value) {
    const row = document.createElement("div");
    row.className = "member-row";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "member-input";
    input.placeholder = "Üye Ad Soyad";
    input.value = value || "";

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "danger-btn";
    removeBtn.textContent = "Sil";

    removeBtn.addEventListener("click", () => {
      row.remove();
      ensureAtLeastOneMemberInput();
    });

    row.appendChild(input);
    row.appendChild(removeBtn);
    membersContainer.appendChild(row);
  }

  function ensureAtLeastOneMemberInput() {
    const rows = membersContainer.querySelectorAll(".member-row");
    if (!rows.length) {
      addMemberInput("");
    }
  }

  async function saveSettings() {
    const settings = {
      idareAdi: getValue("idareAdi"),
      muayeneEdilenYer: getValue("muayeneEdilenYer"),
      komisyonBaskani: getValue("komisyonBaskani"),
      okulMuduru: getValue("okulMuduru"),
      uyeler: Array.from(document.querySelectorAll(".member-input"))
        .map((input) => String(input.value || "").trim())
        .filter(Boolean)
    };

    if (!settings.uyeler.length) {
      settings.uyeler = [""];
    }

    current = settings;

    try {
      await persistSettings(settings);
      setStatus("Ayarlar kaydedildi.");
    } catch (error) {
      setStatus(`Kaydetme hatası: ${error.message || error}`, true);
    }
  }

  function openYapilanIsModal() {
    renderYapilanIsRows(yapilanIsEntries);
    yapilanIsModal.classList.add("open");
    yapilanIsModal.setAttribute("aria-hidden", "false");
  }

  function closeYapilanIsModal() {
    yapilanIsModal.classList.remove("open");
    yapilanIsModal.setAttribute("aria-hidden", "true");
  }

  function renderYapilanIsRows(values) {
    yapilanIsContainer.innerHTML = "";

    if (!values.length) {
      addYapilanIsRow("");
      return;
    }

    values.forEach((value) => addYapilanIsRow(value));
  }

  function addYapilanIsRow(value) {
    const row = document.createElement("div");
    row.className = "yapilanis-row";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "yapilanis-input";
    input.placeholder = "Yapılan İş / Mal / Hizmetin Adı, Niteliği";
    input.value = value || "";

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "danger-btn";
    removeBtn.textContent = "Sil";

    removeBtn.addEventListener("click", () => {
      row.remove();
      ensureAtLeastOneYapilanIsRow();
    });

    row.appendChild(input);
    row.appendChild(removeBtn);
    yapilanIsContainer.appendChild(row);
  }

  function ensureAtLeastOneYapilanIsRow() {
    if (!yapilanIsContainer.querySelector(".yapilanis-row")) {
      addYapilanIsRow("");
    }
  }

  async function saveYapilanIsEntries() {
    const values = Array.from(yapilanIsContainer.querySelectorAll(".yapilanis-input")).map(
      (input) => input.value
    );

    const normalized = normalizeHistory(values);

    try {
      yapilanIsEntries = normalized;
      await persistYapilanIsHistory(normalized);
      updateYapilanIsCountHint();
      closeYapilanIsModal();
      setStatus("Yapılan İş kayıtları kaydedildi.");
    } catch (error) {
      setStatus(`Yapılan İş kayıtları kaydedilemedi: ${error.message || error}`, true);
    }
  }

  function updateYapilanIsCountHint() {
    yapilanIsCountHint.textContent = `Kayıt sayısı: ${yapilanIsEntries.length}`;
  }

  function normalizeHistory(values) {
    if (!Array.isArray(values)) {
      return [];
    }

    const output = [];
    const seen = new Set();

    values.forEach((value) => {
      const cleaned = normalizeWhitespace(value);
      if (!cleaned) {
        return;
      }

      const key = cleaned.toLocaleLowerCase("tr-TR");
      if (seen.has(key)) {
        return;
      }

      seen.add(key);
      output.push(cleaned);
    });

    return output;
  }

  function normalizeWhitespace(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function setValue(id, value) {
    const el = document.getElementById(id);
    if (el) {
      el.value = value || "";
    }
  }

  function getValue(id) {
    const el = document.getElementById(id);
    return el ? String(el.value || "").trim() : "";
  }

  async function persistSettings(settings) {
    await storageSet({ [STORAGE_KEYS.SETTINGS]: settings });
  }

  async function persistYapilanIsHistory(values) {
    await storageSet({ [STORAGE_KEYS.YAPILAN_IS_HISTORY]: values });
  }

  function setStatus(message, isError = false) {
    statusEl.textContent = message;
    statusEl.style.color = isError ? "#b42318" : "#0f7a34";

    window.clearTimeout(setStatus._timer);
    setStatus._timer = window.setTimeout(() => {
      statusEl.textContent = "";
    }, 3500);
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
})();
