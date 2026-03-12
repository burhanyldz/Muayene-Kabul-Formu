// Content script
// - Injects "Muayene Kabul Formu" button next to existing action buttons.
// - Fetches invoice XML from gateway and parses structured invoice data.
// - Sends structured payload to background service worker.

(() => {
  "use strict";

  const BUTTON_ID = "mkf-generate-button";
  const BUTTON_TEXT = "Muayene Kabul Formu";
  const TARGET_BUTTON_TEXTS = ["Yazdır / PDF olarak kaydet", "Kapat"];

  const STORAGE_KEYS = {
    SETTINGS: "mkf_settings",
    LAST_YAPILAN_IS: "mkf_last_yapilan_is",
    YAPILAN_IS_HISTORY: "mkf_yapilan_is_history"
  };
  const ETTN_REGEX = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;
  const UNIT_CODE_LABELS = Object.freeze({
    ADET: "Adet",
    NIU: "Adet",
    C62: "Adet",
    EA: "Adet",
    PC: "Adet",
    PCS: "Adet",
    NMB: "Adet",
    KG: "Kilogram",
    KGM: "Kilogram",
    KGS: "Kilogram",
    GR: "Gram",
    GRM: "Gram",
    M: "Metre",
    MTR: "Metre",
    CM: "Santimetre",
    CMT: "Santimetre",
    M2: "Metrekare",
    MTK: "Metrekare",
    SME: "Metrekare",
    M3: "Metreküp",
    MTQ: "Metreküp",
    CM3: "Santimetreküp",
    CMQ: "Santimetreküp",
    L: "Litre",
    LTR: "Litre",
    LTQ: "Litre",
    PA: "Paket",
    PK: "Paket",
    BX: "Kutu",
    KUTU: "Kutu",
    ROLL: "Rulo",
    ROL: "Rulo",
    RULO: "Rulo",
    SET: "Set",
    CT: "Karton",
    CR: "Kasa",
    CI: "Bidon",
    TU: "Boru",
    PAR: "Çift",
    PRS: "Çift",
    BT: "Cıvata",
    BH: "Demet",
    BE: "Deste",
    DOZ: "Düzine",
    BA: "Fıçı",
    BU: "Varil",
    PAL: "Palet",
    CY: "Silindir",
    BG: "Torba",
    EN: "Zarf",
    FT: "Foot",
    YD: "Yard",
    SYD: "Yard Kare",
    PF: "Alkol Derece Litresi",
    "SÜ-": "Konteynır"
  });

  const DEFAULT_SETTINGS = {
    idareAdi: "",
    muayeneEdilenYer: "",
    komisyonBaskani: "",
    uyeler: [""],
    okulMuduru: ""
  };

  let isProcessing = false;

  start();

  function start() {
    injectButtonIfNeeded();

    // React-based pages can re-render the action area; keep watching the DOM.
    const observer = new MutationObserver(() => injectButtonIfNeeded());
    observer.observe(document.documentElement, { childList: true, subtree: true });

    // Safety net for delayed rendering in heavy pages.
    window.setInterval(injectButtonIfNeeded, 2000);
  }

  function injectButtonIfNeeded() {
    const buttonBar = findButtonBar();
    if (!buttonBar) {
      return;
    }

    const existing = document.getElementById(BUTTON_ID);
    if (existing && existing.isConnected) {
      if (existing.parentElement !== buttonBar) {
        buttonBar.appendChild(existing);
      }
      return;
    }

    const button = document.createElement("button");
    button.id = BUTTON_ID;
    button.type = "button";
    button.className = "yte-component yte-button primary";
    button.textContent = BUTTON_TEXT;

    button.addEventListener("click", async () => {
      if (isProcessing) {
        return;
      }

      isProcessing = true;
      const originalText = button.textContent;
      button.disabled = true;
      button.textContent = "Hazırlanıyor...";

      try {
        const settings = await getSettings();
        if (isSettingsCompletelyEmpty(settings)) {
          const goSetup = await showConfirmDialog(
            "Muayene Kabul Formu ayarları henüz boş görünüyor.\nİlk kullanım için ayar sayfasını şimdi açmak ister misiniz?"
          );
          if (goSetup) {
            await openOptionsPage();
          }
          return;
        }

        const yapilanIs = await askYapilanIs();

        // User cancelled prompt.
        if (yapilanIs === null) {
          return;
        }

        const invoiceDoc = getInvoiceDocument();
        if (!invoiceDoc) {
          throw new Error("Fatura içeriği bulunamadı (iframe erişimi yok).\nSayfayı yeniden yükleyip tekrar deneyin.");
        }

        const scrapeResult = await scrapeInvoiceData(invoiceDoc);
        const scraped = scrapeResult.invoice;
        const payload = {
          sourceUrl: window.location.href,
          scrapedAt: new Date().toISOString(),
          yapilanIs,
          settings,
          invoice: scraped
        };

        const response = await sendRuntimeMessage({
          type: "MKF_OPEN_PRINT_PAGE",
          payload
        });

        if (!response?.ok) {
          throw new Error(response?.error || "Print sekmesi açılamadı.");
        }

        if (scrapeResult.warnings.length) {
          // Non-blocking info: do not stop flow after opening print page.
          void showAlertDialog(scrapeResult.warnings.join("\n"), "Bilgilendirme");
        }
      } catch (error) {
        await showAlertDialog(`Muayene Kabul Formu oluşturulamadı:\n${error.message || error}`);
      } finally {
        isProcessing = false;
        button.disabled = false;
        button.textContent = originalText;
      }
    });

    buttonBar.appendChild(button);
  }

  function findButtonBar() {
    const allButtons = Array.from(document.querySelectorAll("button"));
    if (!allButtons.length) {
      return null;
    }

    const targetButtons = allButtons.filter((btn) => {
      const txt = normalizeWhitespace(btn.textContent);
      return TARGET_BUTTON_TEXTS.some((needle) => txt.includes(needle));
    });

    if (!targetButtons.length) {
      return null;
    }

    // Prefer shared ancestor that contains both "Yazdır" and "Kapat" buttons.
    const common = findCommonAncestor(targetButtons);
    if (common && common.querySelectorAll("button").length >= 2) {
      return common;
    }

    // Fallback: immediate parent of one target button.
    return targetButtons[0].parentElement;
  }

  function findCommonAncestor(elements) {
    if (!elements.length) {
      return null;
    }

    let node = elements[0];
    while (node && node !== document.body) {
      const containsAll = elements.every((el) => node.contains(el));
      if (containsAll && node.querySelectorAll("button").length <= 8) {
        return node;
      }
      node = node.parentElement;
    }

    return null;
  }

  async function askYapilanIs() {
    const stored = await storageGet([
      STORAGE_KEYS.LAST_YAPILAN_IS,
      STORAGE_KEYS.YAPILAN_IS_HISTORY
    ]);
    const lastValue = normalizeWhitespace(stored[STORAGE_KEYS.LAST_YAPILAN_IS] || "");
    const history = normalizeHistory(stored[STORAGE_KEYS.YAPILAN_IS_HISTORY]);

    const value = await showYapilanIsDialog({
      initialValue: lastValue,
      history
    });

    if (value === null) {
      return null;
    }

    const cleaned = normalizeWhitespace(value);
    if (!cleaned) {
      throw new Error("Yapılan İş alanı boş bırakılamaz.");
    }

    const mergedHistory = mergeHistory(history, cleaned);
    await storageSet({
      [STORAGE_KEYS.LAST_YAPILAN_IS]: cleaned,
      [STORAGE_KEYS.YAPILAN_IS_HISTORY]: mergedHistory
    });

    return cleaned;
  }

  function showYapilanIsDialog({ initialValue, history }) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      const dialog = document.createElement("div");
      const title = document.createElement("h3");
      const info = document.createElement("p");
      const input = document.createElement("input");
      const datalist = document.createElement("datalist");
      const actions = document.createElement("div");
      const cancelBtn = document.createElement("button");
      const okBtn = document.createElement("button");

      overlay.style.position = "fixed";
      overlay.style.inset = "0";
      overlay.style.background = "rgba(0,0,0,0.35)";
      overlay.style.display = "flex";
      overlay.style.alignItems = "center";
      overlay.style.justifyContent = "center";
      overlay.style.zIndex = "2147483647";
      overlay.style.padding = "16px";

      dialog.style.width = "min(640px, 100%)";
      dialog.style.background = "#fff";
      dialog.style.borderRadius = "10px";
      dialog.style.padding = "16px";
      dialog.style.boxShadow = "0 10px 28px rgba(0,0,0,0.25)";
      dialog.style.fontFamily = "Arial, sans-serif";

      title.textContent = "Yapılan İş / Mal / Hizmetin Adı, Niteliği";
      title.style.margin = "0 0 10px";
      title.style.fontSize = "18px";

      info.textContent =
        "Önceki kayıtlı değerleri yazarken seçebilir veya yeni bir değer girip devam edebilirsiniz.";
      info.style.margin = "0 0 10px";
      info.style.color = "#444";
      info.style.fontSize = "13px";

      const dataListId = "mkf-yapilan-is-datalist";
      input.type = "text";
      input.setAttribute("list", dataListId);
      input.placeholder = "Örn: Klima Alımı";
      input.value = initialValue || "";
      input.style.width = "100%";
      input.style.padding = "10px 12px";
      input.style.fontSize = "14px";
      input.style.border = "1px solid #c8ced7";
      input.style.borderRadius = "8px";

      datalist.id = dataListId;
      history.forEach((value) => {
        const option = document.createElement("option");
        option.value = value;
        datalist.appendChild(option);
      });

      actions.style.display = "flex";
      actions.style.justifyContent = "flex-end";
      actions.style.gap = "8px";
      actions.style.marginTop = "12px";

      cancelBtn.type = "button";
      cancelBtn.textContent = "Vazgeç";
      cancelBtn.style.border = "1px solid #c8ced7";
      cancelBtn.style.background = "#fff";
      cancelBtn.style.color = "#111";
      cancelBtn.style.borderRadius = "8px";
      cancelBtn.style.padding = "9px 14px";
      cancelBtn.style.cursor = "pointer";

      okBtn.type = "button";
      okBtn.textContent = "Devam";
      okBtn.style.border = "1px solid #175ea8";
      okBtn.style.background = "#175ea8";
      okBtn.style.color = "#fff";
      okBtn.style.borderRadius = "8px";
      okBtn.style.padding = "9px 14px";
      okBtn.style.cursor = "pointer";

      const close = (value) => {
        window.removeEventListener("keydown", onKeyDown, true);
        overlay.remove();
        resolve(value);
      };

      const submit = () => {
        close(input.value || "");
      };

      const onKeyDown = (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          close(null);
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          submit();
        }
      };

      cancelBtn.addEventListener("click", () => close(null));
      okBtn.addEventListener("click", submit);
      overlay.addEventListener("click", (event) => {
        if (event.target === overlay) {
          close(null);
        }
      });
      window.addEventListener("keydown", onKeyDown, true);

      actions.appendChild(cancelBtn);
      actions.appendChild(okBtn);
      dialog.appendChild(title);
      dialog.appendChild(info);
      dialog.appendChild(input);
      dialog.appendChild(datalist);
      dialog.appendChild(actions);
      overlay.appendChild(dialog);
      document.documentElement.appendChild(overlay);
      input.focus();
      input.select();
    });
  }

  function showAlertDialog(message, title = "Bilgi") {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      const dialog = document.createElement("div");
      const titleEl = document.createElement("h3");
      const messageEl = document.createElement("p");
      const actions = document.createElement("div");
      const okBtn = document.createElement("button");
      const previousActive = document.activeElement;

      overlay.style.position = "fixed";
      overlay.style.inset = "0";
      overlay.style.background = "rgba(0,0,0,0.35)";
      overlay.style.display = "flex";
      overlay.style.alignItems = "center";
      overlay.style.justifyContent = "center";
      overlay.style.zIndex = "2147483647";
      overlay.style.padding = "16px";

      dialog.style.width = "min(560px, 100%)";
      dialog.style.background = "#fff";
      dialog.style.borderRadius = "10px";
      dialog.style.padding = "16px";
      dialog.style.boxShadow = "0 10px 28px rgba(0,0,0,0.25)";
      dialog.style.fontFamily = "Arial, sans-serif";

      titleEl.textContent = title;
      titleEl.style.margin = "0 0 10px";
      titleEl.style.fontSize = "18px";

      messageEl.textContent = String(message || "");
      messageEl.style.margin = "0";
      messageEl.style.color = "#333";
      messageEl.style.fontSize = "14px";
      messageEl.style.whiteSpace = "pre-line";

      actions.style.display = "flex";
      actions.style.justifyContent = "flex-end";
      actions.style.gap = "8px";
      actions.style.marginTop = "14px";

      okBtn.type = "button";
      okBtn.textContent = "Tamam";
      okBtn.style.border = "1px solid #175ea8";
      okBtn.style.background = "#175ea8";
      okBtn.style.color = "#fff";
      okBtn.style.borderRadius = "8px";
      okBtn.style.padding = "9px 14px";
      okBtn.style.cursor = "pointer";

      const close = () => {
        window.removeEventListener("keydown", onKeyDown, true);
        overlay.remove();
        if (previousActive && typeof previousActive.focus === "function") {
          previousActive.focus();
        }
        resolve();
      };

      const onKeyDown = (event) => {
        if (event.key === "Escape" || event.key === "Enter") {
          event.preventDefault();
          close();
        }
      };

      okBtn.addEventListener("click", close);
      overlay.addEventListener("click", (event) => {
        if (event.target === overlay) {
          close();
        }
      });
      window.addEventListener("keydown", onKeyDown, true);

      actions.appendChild(okBtn);
      dialog.appendChild(titleEl);
      dialog.appendChild(messageEl);
      dialog.appendChild(actions);
      overlay.appendChild(dialog);
      document.documentElement.appendChild(overlay);
      okBtn.focus();
    });
  }

  function showConfirmDialog(message, title = "Onay") {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      const dialog = document.createElement("div");
      const titleEl = document.createElement("h3");
      const messageEl = document.createElement("p");
      const actions = document.createElement("div");
      const cancelBtn = document.createElement("button");
      const okBtn = document.createElement("button");
      const previousActive = document.activeElement;

      overlay.style.position = "fixed";
      overlay.style.inset = "0";
      overlay.style.background = "rgba(0,0,0,0.35)";
      overlay.style.display = "flex";
      overlay.style.alignItems = "center";
      overlay.style.justifyContent = "center";
      overlay.style.zIndex = "2147483647";
      overlay.style.padding = "16px";

      dialog.style.width = "min(560px, 100%)";
      dialog.style.background = "#fff";
      dialog.style.borderRadius = "10px";
      dialog.style.padding = "16px";
      dialog.style.boxShadow = "0 10px 28px rgba(0,0,0,0.25)";
      dialog.style.fontFamily = "Arial, sans-serif";

      titleEl.textContent = title;
      titleEl.style.margin = "0 0 10px";
      titleEl.style.fontSize = "18px";

      messageEl.textContent = String(message || "");
      messageEl.style.margin = "0";
      messageEl.style.color = "#333";
      messageEl.style.fontSize = "14px";
      messageEl.style.whiteSpace = "pre-line";

      actions.style.display = "flex";
      actions.style.justifyContent = "flex-end";
      actions.style.gap = "8px";
      actions.style.marginTop = "14px";

      cancelBtn.type = "button";
      cancelBtn.textContent = "Vazgeç";
      cancelBtn.style.border = "1px solid #c8ced7";
      cancelBtn.style.background = "#fff";
      cancelBtn.style.color = "#111";
      cancelBtn.style.borderRadius = "8px";
      cancelBtn.style.padding = "9px 14px";
      cancelBtn.style.cursor = "pointer";

      okBtn.type = "button";
      okBtn.textContent = "Ayarları Aç";
      okBtn.style.border = "1px solid #175ea8";
      okBtn.style.background = "#175ea8";
      okBtn.style.color = "#fff";
      okBtn.style.borderRadius = "8px";
      okBtn.style.padding = "9px 14px";
      okBtn.style.cursor = "pointer";

      const close = (value) => {
        window.removeEventListener("keydown", onKeyDown, true);
        overlay.remove();
        if (previousActive && typeof previousActive.focus === "function") {
          previousActive.focus();
        }
        resolve(value);
      };

      const onKeyDown = (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          close(false);
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          close(true);
        }
      };

      cancelBtn.addEventListener("click", () => close(false));
      okBtn.addEventListener("click", () => close(true));
      overlay.addEventListener("click", (event) => {
        if (event.target === overlay) {
          close(false);
        }
      });
      window.addEventListener("keydown", onKeyDown, true);

      actions.appendChild(cancelBtn);
      actions.appendChild(okBtn);
      dialog.appendChild(titleEl);
      dialog.appendChild(messageEl);
      dialog.appendChild(actions);
      overlay.appendChild(dialog);
      document.documentElement.appendChild(overlay);
      okBtn.focus();
    });
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

  function mergeHistory(history, value) {
    const cleaned = normalizeWhitespace(value);
    const normalizedHistory = normalizeHistory(history);
    const others = normalizedHistory.filter(
      (item) => item.toLocaleLowerCase("tr-TR") !== cleaned.toLocaleLowerCase("tr-TR")
    );
    return [cleaned, ...others].slice(0, 250);
  }

  function isSettingsCompletelyEmpty(settings) {
    const memberValues = Array.isArray(settings?.uyeler)
      ? settings.uyeler.map((member) => normalizeWhitespace(member)).filter(Boolean)
      : [];

    return (
      !normalizeWhitespace(settings?.idareAdi) &&
      !normalizeWhitespace(settings?.muayeneEdilenYer) &&
      !normalizeWhitespace(settings?.komisyonBaskani) &&
      !normalizeWhitespace(settings?.okulMuduru) &&
      memberValues.length === 0
    );
  }

  function getInvoiceDocument() {
    const iframes = Array.from(document.querySelectorAll("iframe"));

    for (const iframe of iframes) {
      try {
        const doc = iframe.contentDocument;
        if (!doc || !doc.body) {
          continue;
        }

        const hasInvoiceMarkers =
          doc.querySelector("#kunye, #malHizmetTablosu, #toplamlarContainer") ||
          /e-?fatura/i.test(doc.body.textContent || "");

        if (hasInvoiceMarkers) {
          return doc;
        }
      } catch (_err) {
        // Ignore cross-origin iframe access errors and continue.
      }
    }

    // Fallback for cases where invoice is rendered in current document.
    if (document.querySelector("#kunye, #malHizmetTablosu, #toplamlarContainer")) {
      return document;
    }

    return null;
  }

  async function scrapeInvoiceData(invoiceDoc) {
    const ettnCandidate = findEttnCandidate(invoiceDoc);
    if (!ettnCandidate) {
      throw new Error("ETTN bulunamadı. XML olmadan form oluşturulamıyor.");
    }

    const xmlText = await fetchInvoiceXml(ettnCandidate);
    const xmlData = parseInvoiceXml(xmlText, ettnCandidate);

    return {
      invoice: xmlData,
      warnings: []
    };
  }

  function findEttnCandidate(invoiceDoc) {
    return firstNonEmpty(
      normalizeEttn(extractEttnFromUrl(window.location.href)),
      normalizeEttn(extractEttnFromText(window.location.href)),
      normalizeEttn(extractEttnFromText(invoiceDoc?.body?.textContent || "")),
      normalizeEttn(extractEttnFromText(document.body?.textContent || ""))
    );
  }

  function extractEttnFromUrl(urlText) {
    const raw = String(urlText || "");
    if (!raw) {
      return "";
    }

    try {
      const parsedUrl = new URL(raw, window.location.origin);
      return firstNonEmpty(
        parsedUrl.searchParams.get("faturaEttn"),
        parsedUrl.searchParams.get("ettn"),
        parsedUrl.searchParams.get("uuid"),
        parsedUrl.searchParams.get("faturaUuid")
      );
    } catch (_error) {
      return "";
    }
  }

  function extractEttnFromText(text) {
    const raw = String(text || "");
    if (!raw) {
      return "";
    }
    const match = raw.match(ETTN_REGEX);
    return match ? match[0] : "";
  }

  function normalizeEttn(value) {
    const normalized = normalizeWhitespace(value);
    const match = normalized.match(ETTN_REGEX);
    return match ? match[0] : "";
  }

  async function fetchInvoiceXml(ettn) {
    const safeEttn = normalizeEttn(ettn);
    if (!safeEttn) {
      throw new Error("Geçerli bir ETTN bulunamadı.");
    }

    const endpoint = new URL("/hys/gateway/efatura/efatura/getirFaturaXml", window.location.origin);
    endpoint.searchParams.set("ettn", safeEttn);

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 12000);

    try {
      const response = await fetch(endpoint.toString(), {
        method: "GET",
        credentials: "include",
        signal: controller.signal,
        headers: {
          Accept: "application/xml, text/xml, */*"
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const responseText = await response.text();
      if (!normalizeWhitespace(responseText)) {
        throw new Error("Boş XML yanıtı");
      }

      const gatewayErrorMessage = parseGatewayErrorMessage(responseText);
      if (gatewayErrorMessage) {
        throw new Error(gatewayErrorMessage);
      }

      const xmlText = extractXmlFromGatewayResponse(responseText);
      if (!normalizeWhitespace(xmlText)) {
        throw new Error("Geçerli XML içeriği bulunamadı.");
      }

      return xmlText;
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error("XML isteği zaman aşımına uğradı.");
      }
      throw error;
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  function parseGatewayErrorMessage(rawText) {
    const text = normalizeWhitespace(rawText);
    if (!text || !(text.startsWith("{") || text.startsWith("["))) {
      return "";
    }

    try {
      const parsed = JSON.parse(text);
      const errors = Array.isArray(parsed?.messages?.errors) ? parsed.messages.errors : [];
      const combined = normalizeWhitespace(
        errors
          .map((item) => normalizeWhitespace(item?.message || ""))
          .filter(Boolean)
          .join(" | ")
      );
      return combined;
    } catch (_error) {
      return "";
    }
  }

  function extractXmlFromGatewayResponse(rawText) {
    const text = String(rawText || "").trim();
    if (!text) {
      return "";
    }

    if (!(text.startsWith("{") || text.startsWith("["))) {
      return stripUtf8Bom(text);
    }

    try {
      const parsed = JSON.parse(text);
      const candidate = firstNonEmpty(
        typeof parsed?.xmlIcerik === "string" ? parsed.xmlIcerik : "",
        typeof parsed?.xmlIcerigi === "string" ? parsed.xmlIcerigi : "",
        typeof parsed?.xml === "string" ? parsed.xml : "",
        typeof parsed?.data?.xmlIcerik === "string" ? parsed.data.xmlIcerik : "",
        typeof parsed?.data?.xmlIcerigi === "string" ? parsed.data.xmlIcerigi : "",
        typeof parsed?.result?.xmlIcerik === "string" ? parsed.result.xmlIcerik : ""
      );

      if (candidate) {
        return stripUtf8Bom(candidate);
      }

      if (typeof parsed === "string") {
        return stripUtf8Bom(parsed);
      }

      return "";
    } catch (_error) {
      return "";
    }
  }

  function stripUtf8Bom(text) {
    return String(text || "").replace(/^\uFEFF/, "");
  }

  function parseInvoiceXml(xmlText, fallbackEttn = "") {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(String(xmlText || ""), "application/xml");
    if (xmlDoc.querySelector("parsererror")) {
      throw new Error("XML parse hatası");
    }

    const invoiceNode = xmlSelectOne(xmlDoc, "/*[local-name()='Invoice']");
    if (!invoiceNode) {
      throw new Error("Invoice kök düğümü bulunamadı");
    }

    const number = xmlTextContent(xmlSelectOne(invoiceNode, "./*[local-name()='ID']"));
    const date = xmlTextContent(xmlSelectOne(invoiceNode, "./*[local-name()='IssueDate']"));
    const ettn = firstNonEmpty(
      normalizeEttn(xmlTextContent(xmlSelectOne(invoiceNode, "./*[local-name()='UUID']"))),
      normalizeEttn(fallbackEttn)
    );
    const scenario = xmlTextContent(xmlSelectOne(invoiceNode, "./*[local-name()='ProfileID']"));
    const invoiceType = xmlTextContent(xmlSelectOne(invoiceNode, "./*[local-name()='InvoiceTypeCode']"));
    const currency = xmlTextContent(xmlSelectOne(invoiceNode, "./*[local-name()='DocumentCurrencyCode']"));

    const seller = parseXmlParty(
      xmlSelectOne(invoiceNode, "./*[local-name()='AccountingSupplierParty']/*[local-name()='Party']")
    );
    const buyer = parseXmlParty(
      xmlSelectOne(invoiceNode, "./*[local-name()='AccountingCustomerParty']/*[local-name()='Party']")
    );

    const items = parseXmlInvoiceLines(invoiceNode, currency);
    const totals = parseXmlTotals(invoiceNode, currency);
    const notes = parseXmlNotes(invoiceNode);

    const metadata = {};
    if (date) {
      metadata.Tarih = date;
    }
    if (number) {
      metadata["Fatura No"] = number;
    }
    if (ettn) {
      metadata.ETTN = ettn;
    }
    if (scenario) {
      metadata.Senaryo = scenario;
    }
    if (invoiceType) {
      metadata["Fatura Tipi"] = invoiceType;
    }
    if (currency) {
      metadata["Para Birimi"] = currency;
    }

    const keyValuePairs = {
      ...metadata,
      ...totals
    };
    if (seller.name) {
      keyValuePairs["Satanın Adı Ünvanı"] = seller.name;
    }
    if (buyer.name) {
      keyValuePairs["Alıcının Adı"] = buyer.name;
    }

    return {
      number,
      date,
      ettn,
      scenario,
      invoiceType,
      currency,
      seller,
      buyer,
      items,
      totals,
      metadata,
      keyValuePairs,
      notes
    };
  }

  function parseXmlParty(partyNode) {
    if (!partyNode) {
      return {
        name: "",
        address: "",
        taxOffice: "",
        taxNumber: ""
      };
    }

    return {
      name: parseXmlPartyName(partyNode),
      address: parseXmlPartyAddress(partyNode),
      taxOffice: parseXmlPartyTaxOffice(partyNode),
      taxNumber: parseXmlPartyTaxNumber(partyNode)
    };
  }

  function parseXmlPartyName(partyNode) {
    const partyName = xmlTextContent(
      xmlSelectOne(partyNode, "./*[local-name()='PartyName']/*[local-name()='Name']")
    );
    if (partyName) {
      return partyName;
    }

    const registrationName = xmlTextContent(
      xmlSelectOne(partyNode, "./*[local-name()='PartyLegalEntity']/*[local-name()='RegistrationName']")
    );
    if (registrationName) {
      return registrationName;
    }

    const firstName = xmlTextContent(xmlSelectOne(partyNode, "./*[local-name()='Person']/*[local-name()='FirstName']"));
    const familyName = xmlTextContent(xmlSelectOne(partyNode, "./*[local-name()='Person']/*[local-name()='FamilyName']"));
    return normalizeWhitespace(`${firstName} ${familyName}`);
  }

  function parseXmlPartyTaxNumber(partyNode) {
    const idNodes = xmlSelectMany(
      partyNode,
      "./*[local-name()='PartyIdentification']/*[local-name()='ID']"
    );

    const candidates = idNodes
      .map((node) => ({
        value: normalizeDigits(xmlTextContent(node)),
        scheme: normalizeWhitespace(xmlAttribute(node, "schemeID")).toUpperCase()
      }))
      .filter((item) => item.value);

    const preferred =
      candidates.find((item) => /VKN_TCKN/.test(item.scheme)) ||
      candidates.find((item) => /VKN/.test(item.scheme)) ||
      candidates.find((item) => /TCKN/.test(item.scheme));

    if (preferred?.value) {
      return preferred.value;
    }

    const legalCompanyId = normalizeDigits(
      xmlTextContent(xmlSelectOne(partyNode, "./*[local-name()='PartyLegalEntity']/*[local-name()='CompanyID']"))
    );
    if (legalCompanyId) {
      return legalCompanyId;
    }

    return candidates[0]?.value || "";
  }

  function parseXmlPartyTaxOffice(partyNode) {
    return xmlTextContent(
      xmlSelectOne(
        partyNode,
        "./*[local-name()='PartyTaxScheme']/*[local-name()='TaxScheme']/*[local-name()='Name']"
      )
    );
  }

  function parseXmlPartyAddress(partyNode) {
    const addressNode = xmlSelectOne(partyNode, "./*[local-name()='PostalAddress']");
    if (!addressNode) {
      return "";
    }

    const street = xmlTextContent(xmlSelectOne(addressNode, "./*[local-name()='StreetName']"));
    let building = xmlTextContent(xmlSelectOne(addressNode, "./*[local-name()='BuildingNumber']"));
    const district = xmlTextContent(xmlSelectOne(addressNode, "./*[local-name()='CitySubdivisionName']"));
    const city = xmlTextContent(xmlSelectOne(addressNode, "./*[local-name()='CityName']"));
    const postalCode = xmlTextContent(xmlSelectOne(addressNode, "./*[local-name()='PostalZone']"));
    const country = xmlTextContent(
      xmlSelectOne(addressNode, "./*[local-name()='Country']/*[local-name()='Name']")
    );

    if (
      building &&
      street &&
      street.toLocaleLowerCase("tr-TR").includes(building.toLocaleLowerCase("tr-TR"))
    ) {
      building = "";
    }

    const streetLine = normalizeWhitespace(`${street} ${building}`);
    const cityLine = normalizeWhitespace([district, city].filter(Boolean).join(" / "));
    return normalizeWhitespace([streetLine, cityLine, postalCode, country].filter(Boolean).join(" "));
  }

  function parseXmlInvoiceLines(invoiceNode, currency) {
    const lineNodes = xmlSelectMany(invoiceNode, "./*[local-name()='InvoiceLine']");

    return lineNodes.map((lineNode, index) => {
      const quantityNode = xmlSelectOne(lineNode, "./*[local-name()='InvoicedQuantity']");
      const quantity = xmlTextContent(quantityNode);
      const unitCode = normalizeWhitespace(xmlAttribute(quantityNode, "unitCode"));
      const unit = getUnitLabel(unitCode);
      const quantityRaw = normalizeWhitespace(`${quantity}${unit ? ` ${unit}` : ""}`);

      const vatPercent = xmlTextContent(
        xmlSelectOne(
          lineNode,
          "./*[local-name()='TaxTotal']/*[local-name()='TaxSubtotal'][1]/*[local-name()='Percent']"
        )
      );

      return {
        siraNo: firstNonEmpty(
          xmlTextContent(xmlSelectOne(lineNode, "./*[local-name()='ID']")),
          String(index + 1)
        ),
        description: firstNonEmpty(
          xmlTextContent(xmlSelectOne(lineNode, "./*[local-name()='Item']/*[local-name()='Name']")),
          xmlTextContent(xmlSelectOne(lineNode, "./*[local-name()='Note'][1]"))
        ),
        quantityRaw,
        quantity,
        unit,
        unitCode,
        unitPrice: formatXmlAmount(
          xmlTextContent(xmlSelectOne(lineNode, "./*[local-name()='Price']/*[local-name()='PriceAmount']")),
          currency
        ),
        lineTotal: formatXmlAmount(
          xmlTextContent(xmlSelectOne(lineNode, "./*[local-name()='LineExtensionAmount']")),
          currency
        ),
        vatRate: vatPercent ? `%${vatPercent}` : "",
        vatAmount: formatXmlAmount(
          xmlTextContent(
            xmlSelectOne(
              lineNode,
              "./*[local-name()='TaxTotal']/*[local-name()='TaxSubtotal'][1]/*[local-name()='TaxAmount']"
            )
          ),
          currency
        )
      };
    });
  }

  function parseXmlTotals(invoiceNode, currency) {
    const totals = {};

    const legalMonetaryTotalNode = xmlSelectOne(invoiceNode, "./*[local-name()='LegalMonetaryTotal']");
    const taxTotalNode = xmlSelectOne(invoiceNode, "./*[local-name()='TaxTotal'][1]");
    const taxSubtotalNode = xmlSelectOne(taxTotalNode, "./*[local-name()='TaxSubtotal'][1]");

    const lineExtensionAmount = formatXmlAmount(
      xmlTextContent(xmlSelectOne(legalMonetaryTotalNode, "./*[local-name()='LineExtensionAmount']")),
      currency
    );
    const taxExclusiveAmount = formatXmlAmount(
      xmlTextContent(xmlSelectOne(legalMonetaryTotalNode, "./*[local-name()='TaxExclusiveAmount']")),
      currency
    );
    const taxInclusiveAmount = formatXmlAmount(
      xmlTextContent(xmlSelectOne(legalMonetaryTotalNode, "./*[local-name()='TaxInclusiveAmount']")),
      currency
    );
    const payableAmount = formatXmlAmount(
      xmlTextContent(xmlSelectOne(legalMonetaryTotalNode, "./*[local-name()='PayableAmount']")),
      currency
    );
    const taxAmount = formatXmlAmount(
      xmlTextContent(xmlSelectOne(taxTotalNode, "./*[local-name()='TaxAmount']")),
      currency
    );
    const taxableAmount = formatXmlAmount(
      xmlTextContent(xmlSelectOne(taxSubtotalNode, "./*[local-name()='TaxableAmount']")),
      currency
    );

    if (lineExtensionAmount) {
      totals["Mal Hizmet Toplam Tutarı"] = lineExtensionAmount;
    }
    if (taxableAmount) {
      totals["KDV Matrahı"] = taxableAmount;
    }
    if (taxExclusiveAmount) {
      totals["Vergi Hariç Tutar"] = taxExclusiveAmount;
    }
    if (taxAmount) {
      totals["Hesaplanan KDV"] = taxAmount;
    }
    if (taxInclusiveAmount) {
      totals["Vergiler Dahil Toplam Tutar"] = taxInclusiveAmount;
    }
    if (payableAmount) {
      totals["Ödenecek Tutar"] = payableAmount;
    }

    return totals;
  }

  function parseXmlNotes(invoiceNode) {
    return xmlSelectMany(invoiceNode, "./*[local-name()='Note']")
      .map((noteNode) => xmlTextContent(noteNode))
      .filter(Boolean);
  }

  function formatXmlAmount(value, currency) {
    const amount = normalizeWhitespace(value);
    if (!amount) {
      return "";
    }
    return currency ? `${amount} ${currency}` : amount;
  }

  function xmlSelectOne(contextNode, xpathExpression) {
    if (!contextNode) {
      return null;
    }
    const doc = contextNode.nodeType === 9 ? contextNode : contextNode.ownerDocument;
    return doc.evaluate(
      xpathExpression,
      contextNode,
      null,
      XPathResult.FIRST_ORDERED_NODE_TYPE,
      null
    ).singleNodeValue;
  }

  function xmlSelectMany(contextNode, xpathExpression) {
    if (!contextNode) {
      return [];
    }
    const doc = contextNode.nodeType === 9 ? contextNode : contextNode.ownerDocument;
    const snapshot = doc.evaluate(
      xpathExpression,
      contextNode,
      null,
      XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
      null
    );

    const output = [];
    for (let i = 0; i < snapshot.snapshotLength; i += 1) {
      output.push(snapshot.snapshotItem(i));
    }
    return output;
  }

  function xmlTextContent(node) {
    return normalizeWhitespace(node?.textContent || "");
  }

  function xmlAttribute(node, attributeName) {
    if (!node || !attributeName) {
      return "";
    }
    return normalizeWhitespace(node.getAttribute(attributeName) || "");
  }

  function extractQrRawText(root) {
    const qrValueText = firstText(root, ["#qrvalue", "[id*=qrvalue]"]);
    if (qrValueText) {
      return decodeHtmlEntities(qrValueText);
    }

    const titleNodes = Array.from(
      root.querySelectorAll("#qrcode[title], [id*=qrcode][title], [title]")
    );
    for (const node of titleNodes) {
      const title = normalizeWhitespace(node.getAttribute("title"));
      if (!title) {
        continue;
      }
      if (/vkntckn|avkntckn|ettn|senaryo|parabirimi/i.test(title)) {
        return decodeHtmlEntities(title);
      }
    }

    return "";
  }

  function parseLooseQrData(rawText) {
    const map = {};
    if (!rawText) {
      return map;
    }

    const normalizedRaw = decodeHtmlEntities(rawText);

    // Try strict JSON parsing first.
    try {
      const parsed = JSON.parse(normalizedRaw);
      if (parsed && typeof parsed === "object") {
        Object.entries(parsed).forEach(([key, value]) => {
          const normalizedKey = normalizeQrKey(key);
          const normalizedValue = normalizeWhitespace(String(value ?? ""));
          if (normalizedKey && normalizedValue) {
            map[normalizedKey] = normalizedValue;
          }
        });
      }
    } catch (_err) {
      // Fall back to loose regex parser below.
    }

    // Parse key/value entries even if JSON is malformed.
    const regex = /"([^"]+)"\s*:\s*(?:"([^"]*)"|([-+]?\d+(?:[.,]\d+)?))/g;
    let match;
    while ((match = regex.exec(normalizedRaw)) !== null) {
      const normalizedKey = normalizeQrKey(match[1]);
      const value = normalizeWhitespace(match[2] || match[3] || "");
      if (normalizedKey && value) {
        map[normalizedKey] = value;
      }
    }

    return map;
  }

  function getQrValue(qrMap, keys) {
    for (const key of keys) {
      const normalizedKey = normalizeQrKey(key);
      const value = normalizeWhitespace(qrMap[normalizedKey] || "");
      if (value) {
        return value;
      }
    }
    return "";
  }

  function normalizeQrKey(key) {
    return normalizeWhitespace(key)
      .toLocaleLowerCase("tr-TR")
      .replace(/ı/g, "i")
      .replace(/\s+/g, "");
  }

  function extractMetadataPairs(root) {
    const pairs = {};

    // Primary invoice metadata table.
    const rows = root.querySelectorAll("#kunye tr, #despatchTable tr");
    rows.forEach((row) => {
      const th = row.querySelector("th");
      const td = row.querySelector("td");
      if (!th || !td) {
        return;
      }

      const key = cleanLabel(th.textContent);
      const value = normalizeWhitespace(td.textContent);
      if (key && value) {
        pairs[key] = value;
      }
    });

    // Add fallback labels if some fields are outside #kunye.
    const fallbackLabels = [
      "Tarih",
      "Fatura No",
      "ETTN",
      "Senaryo",
      "Fatura Tipi",
      "Fatura Alt Tipi",
      "Özelleştirme No"
    ];

    fallbackLabels.forEach((label) => {
      if (pairs[label]) {
        return;
      }

      const value = findValueByLabel(root, [label]);
      if (value) {
        pairs[label] = value;
      }
    });

    return pairs;
  }

  function extractAllKeyValuePairs(root) {
    const result = {};

    // Capture visible table rows as key/value.
    const rows = root.querySelectorAll("tr");
    rows.forEach((row) => {
      const cells = Array.from(row.querySelectorAll("th,td"));
      if (cells.length < 2) {
        return;
      }

      const key = cleanLabel(cells[0].textContent);
      const value = normalizeWhitespace(cells[1].textContent);
      if (!key || !value || key.length > 120 || value.length > 500) {
        return;
      }
      result[key] = value;
    });

    // Capture short "Label: Value" style lines.
    const textNodes = root.querySelectorAll("div, span, p, li, td");
    textNodes.forEach((node) => {
      const txt = normalizeWhitespace(node.textContent);
      if (!txt || txt.length < 4 || txt.length > 240) {
        return;
      }

      const idx = txt.indexOf(":");
      if (idx <= 0 || idx === txt.length - 1) {
        return;
      }

      const key = cleanLabel(txt.slice(0, idx));
      const value = normalizeWhitespace(txt.slice(idx + 1));
      if (!key || !value || key.length > 120 || value.length > 200) {
        return;
      }

      // Preserve first occurrence for stable output.
      if (!result[key]) {
        result[key] = value;
      }
    });

    return result;
  }

  function extractParty(root, type, options = {}) {
    const expectedTaxNumber = normalizeDigits(options.expectedTaxNumber || "");

    const sellerRoot = firstElement(root, [
      "#AccountingSupplierParty",
      ".gonderici.kutu",
      ".gonderici",
      "[id*=Supplier]",
      "[id*=supplier]"
    ]);

    const buyerRoot = firstElement(root, [
      "#AccountingCustomerParty",
      ".alici.kutu",
      ".alici",
      "[id*=Customer]",
      "[id*=customer]",
      "#customerPartyTable"
    ]);

    const explicitRoot = type === "seller" ? sellerRoot : buyerRoot;
    let targetRoot = explicitRoot;

    if (expectedTaxNumber && (!targetRoot || !containsTaxNumber(targetRoot, expectedTaxNumber))) {
      targetRoot = findPartyRootByTaxNumber(root, type, expectedTaxNumber) || targetRoot;
    }

    if (!targetRoot) {
      targetRoot = inferPartyRoot(root, type, expectedTaxNumber);
    }

    const fallbackName =
      type === "seller"
        ? firstNonEmpty(
            findValueByLabel(root, ["Satanın Adı Ünvanı", "Satıcının Adı", "Satıcı"]),
            ""
          )
        : firstNonEmpty(
            findValueByLabel(root, ["Alıcının Adı", "Alıcı", "Müşteri"]),
            ""
          );

    if (!targetRoot) {
      return {
        name: fallbackName,
        address: "",
        taxOffice: "",
        taxNumber: expectedTaxNumber
      };
    }

    const genericLines = extractGenericLines(targetRoot);
    const headingName = firstNonEmpty(
      firstText(targetRoot, ["h1", "h2", "h3", ".partyName > div", ".partyName"]),
      ""
    );

    const nameCandidates = [
      headingName,
      ...allText(targetRoot, [
        "h1",
        "h2",
        "h3",
        ".partyName > div",
        ".partyName",
        ".title",
        "strong",
        "b"
      ]),
      ...genericLines,
      fallbackName
    ];

    const address =
      firstNonEmpty(
        firstText(targetRoot, [".addres", ".adres", ".address"]),
        pickAddressFromLines(genericLines)
      ) || "";

    const taxOffice =
      firstNonEmpty(
        findTextByPrefix(targetRoot, ["Vergi Dairesi"]),
        genericLines.find((line) => /Vergi\s*Dairesi/i.test(line))
      ) ||
      firstText(targetRoot, [".taxOffice"]) ||
      "";

    const taxNumber = firstNonEmpty(
      normalizeDigits(extractTaxNumber(targetRoot.textContent || "")),
      expectedTaxNumber
    );

    const filteredNameCandidates = nameCandidates.filter(
      (candidate) => !isTaxOfficeValue(candidate, taxOffice)
    );

    return {
      name: pickBestPartyName(filteredNameCandidates),
      address,
      taxOffice,
      taxNumber
    };
  }

  function findPartyRootByTaxNumber(root, type, taxNumber) {
    if (!taxNumber) {
      return null;
    }

    const candidates = Array.from(root.querySelectorAll("td, table, div"));
    const filtered = candidates.filter((node) => {
      if (node.closest("#qrTable, #qrcode, #qrvalue, [id*=qrcode], [id*=qrvalue]")) {
        return false;
      }

      const text = normalizeWhitespace(node.textContent);
      if (!text || text.length < 20 || text.length > 3000) {
        return false;
      }

      if (!containsTaxNumber(node, taxNumber)) {
        return false;
      }

      if (/"vkntckn"|"avkntckn"|^\{.*\}$/i.test(text)) {
        return false;
      }

      const isInvoiceMeta =
        /Fatura No|Fatura Tipi|Özelleştirme No|ETTN|Mal Hizmet|KDV|Ödenecek/i.test(text);
      if (isInvoiceMeta) {
        return false;
      }

      const hasSayin = /\bSAYIN\b/i.test(text);
      if (type === "buyer") {
        return hasSayin || /Vergi\s*Dairesi|VKN/i.test(text);
      }
      return !hasSayin;
    });

    if (!filtered.length) {
      return null;
    }

    const richCandidates = filtered.filter(
      (node) => node.querySelectorAll("tr").length >= 2 || node.querySelectorAll("br").length >= 1
    );
    const pool = richCandidates.length ? richCandidates : filtered;

    pool.sort(
      (a, b) =>
        scorePartyContainer(b, type) -
          scorePartyContainer(a, type) ||
        normalizeWhitespace(a.textContent).length -
          normalizeWhitespace(b.textContent).length
    );

    return pool[0];
  }

  function inferPartyRoot(root, type, expectedTaxNumber = "") {
    const candidates = Array.from(root.querySelectorAll("td, table, div"));
    const filteredByType = candidates.filter((node) => {
      const text = normalizeWhitespace(node.textContent);
      if (!text || text.length < 20 || text.length > 3000) {
        return false;
      }

      const hasTaxInfo = /Vergi\s*Dairesi|VKN|TCKN/i.test(text);
      if (!hasTaxInfo) {
        return false;
      }

      const isInvoiceMeta =
        /Fatura No|Fatura Tipi|Özelleştirme No|ETTN|Mal Hizmet|KDV|Ödenecek/i.test(text);
      if (isInvoiceMeta) {
        return false;
      }

      const hasSayin = /\bSAYIN\b/i.test(text);
      if (type === "buyer") {
        return hasSayin;
      }
      return !hasSayin;
    });

    const filtered =
      expectedTaxNumber
        ? filteredByType.filter((node) => containsTaxNumber(node, expectedTaxNumber))
        : filteredByType;

    const effectiveFiltered = filtered.length ? filtered : filteredByType;

    if (!effectiveFiltered.length) {
      return null;
    }

    // Prefer containers with internal structure (rows/br) over single label cells.
    const richCandidates = effectiveFiltered.filter(
      (node) => node.querySelectorAll("tr").length >= 2 || node.querySelectorAll("br").length >= 1
    );
    const pool = richCandidates.length ? richCandidates : effectiveFiltered;

    pool.sort(
      (a, b) =>
        scorePartyContainer(b, type) -
          scorePartyContainer(a, type) ||
        normalizeWhitespace(a.textContent).length -
          normalizeWhitespace(b.textContent).length
    );

    return pool[0];
  }

  function scorePartyContainer(node, type) {
    const text = normalizeWhitespace(node.textContent);
    const trCount = node.querySelectorAll("tr").length;
    const brCount = node.querySelectorAll("br").length;

    let score = 0;

    if (trCount >= 4) {
      score += 6;
    } else if (trCount >= 2) {
      score += 4;
    } else if (trCount === 1) {
      score += 1;
    }

    if (brCount >= 2) {
      score += 3;
    } else if (brCount >= 1) {
      score += 1;
    }

    if (/Tel:|E-Posta|Web Sitesi/i.test(text)) {
      score += 2;
    }

    if (/(Mah|Cad|Sok|Sk|No:|Türkiye|\/)/i.test(text)) {
      score += 2;
    }

    if (type === "buyer" && /\bSAYIN\b/i.test(text)) {
      score += 2;
    }

    if (type === "seller" && /\bSAYIN\b/i.test(text)) {
      score -= 5;
    }

    if (/^(Vergi\s*Dairesi|VKN|TCKN)\b/i.test(text)) {
      score -= 4;
    }

    if (text.length < 60) {
      score -= 2;
    }

    return score;
  }

  function extractGenericLines(root) {
    const nodes = [
      root,
      ...Array.from(root.querySelectorAll("h1, h2, h3, td, div, span, p, b, strong"))
    ];
    const lines = [];
    const seen = new Set();

    nodes.forEach((node) => {
      const text = normalizeWhitespace(node.textContent);
      if (!text || text.length < 2 || text.length > 220) {
        return;
      }
      const key = text.toLocaleLowerCase("tr-TR");
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      lines.push(text);
    });

    return lines;
  }

  function pickAddressFromLines(lines) {
    const addressCandidates = lines.filter((line) =>
      /(No:|Mah|Cad|Sk|Sok|\/|Türkiye|İzmit|Kocaeli)/i.test(line)
    );
    return addressCandidates[0] || "";
  }

  function pickBestPartyName(candidates) {
    const normalizedCandidates = candidates
      .map((item) => normalizeWhitespace(item).replace(/^SAYIN\s*/i, "").trim())
      .filter(Boolean);

    const valid = normalizedCandidates.filter((candidate) => isLikelyPartyName(candidate));
    if (!valid.length) {
      // If all candidates were filtered out, keep previous behavior as soft fallback.
      const fallback = normalizedCandidates.find((candidate) => !isHardRejectedPartyName(candidate));
      return fallback || "";
    }

    valid.sort((a, b) => {
      const scoreDiff = scorePartyNameCandidate(b) - scorePartyNameCandidate(a);
      if (scoreDiff !== 0) {
        return scoreDiff;
      }
      return b.length - a.length;
    });

    return valid[0];
  }

  function isLikelyPartyName(value) {
    if (!value) {
      return false;
    }

    if (isHardRejectedPartyName(value)) {
      return false;
    }

    if (isAddressLike(value)) {
      return false;
    }

    return true;
  }

  function isHardRejectedPartyName(value) {
    const rejectedPattern =
      /(SAYIN|Vergi Dairesi|VKN|TCKN|ETTN|Özelleştirme|Fatura No|Fatura Tarihi|Senaryo|Fatura Tipi|Tel:|Telefon|Web Sitesi|e-Posta|E-Posta|Eposta|IBAN|Banka|Ödeme|KDV|Ödenecek|Ticaret Sicil|MERSIS)/i;

    if (rejectedPattern.test(value)) {
      return true;
    }

    // Reject URL-only/domain-only content.
    if (/(https?:\/\/|www\.)/i.test(value)) {
      return true;
    }
    if (/^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(value)) {
      return true;
    }

    // Reject email-like values.
    if (/\S+@\S+\.\S+/.test(value)) {
      return true;
    }

    // Reject label-like rows.
    if (/:/.test(value) && /(adı|ünvanı|unvanı|adres|vergi|telefon|tel|web|eposta|e-posta)/i.test(value)) {
      return true;
    }

    return false;
  }

  function isAddressLike(value) {
    return /(Mah\.?|Mahallesi|Cad\.?|Caddesi|Sok\.?|Sokak|Sk\.?|Bulv\.?|Bulvar|No:|No\b|\/\s*[A-ZÇĞİÖŞÜ]{2,}|Türkiye|İzmit|Kocaeli)/i.test(
      value
    );
  }

  function isTaxOfficeValue(value, taxOffice) {
    const normalizedValue = normalizeWhitespace(value).toLocaleLowerCase("tr-TR");
    const normalizedTaxOffice = normalizeWhitespace(taxOffice).toLocaleLowerCase("tr-TR");

    if (!normalizedValue || !normalizedTaxOffice) {
      return false;
    }

    return normalizedValue === normalizedTaxOffice;
  }

  function scorePartyNameCandidate(value) {
    let score = 0;

    // Strongly prefer company-style legal suffixes.
    if (/\b(A\.?\s*Ş\.?|AŞ|LTD\.?\s*ŞTİ\.?|LİMİTED|ŞTİ\.?|ANONİM|SAN\.?|TİC\.?|TUR\.?|İNŞ\.?|ELEKTRİK|GIDA|KIRTASİYE)\b/i.test(value)) {
      score += 12;
    }

    // Penalize values with many digits.
    const digitCount = (value.match(/\d/g) || []).length;
    if (digitCount === 0) {
      score += 4;
    } else if (digitCount <= 2) {
      score += 1;
    } else {
      score -= 6;
    }

    // Prefer multi-word names.
    const wordCount = value.split(/\s+/).filter(Boolean).length;
    if (wordCount >= 2 && wordCount <= 12) {
      score += 4;
    }

    // Prefer uppercase-heavy names (common in e-Fatura seller blocks).
    const letters = (value.match(/[A-Za-zÇĞİÖŞÜçğıöşü]/g) || []).length;
    const uppercaseLetters = (value.match(/[A-ZÇĞİÖŞÜ]/g) || []).length;
    if (letters > 0) {
      const ratio = uppercaseLetters / letters;
      if (ratio > 0.7) {
        score += 2;
      }
    }

    // Slight length preference, but avoid very long noisy text.
    if (value.length >= 8 && value.length <= 120) {
      score += 1;
    }
    if (value.length > 140) {
      score -= 5;
    }

    return score;
  }

  function extractTaxNumber(text) {
    if (!text) {
      return "";
    }

    const patterns = [
      /(?:VKN|TCKN|VKNTCKN|Vergi\s*No)\s*[:\-]?\s*(\d{8,11})/i,
      /(?:partyID|partyId)\s*[:\-]?\s*(\d{8,11})/i
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        return match[1];
      }
    }

    return "";
  }

  function extractLineItems(root) {
    const table =
      root.querySelector("#malHizmetTablosu") ||
      findTableByHeader(root, ["Mal Hizmet", "Miktar"]);

    if (!table) {
      return [];
    }

    const rows = Array.from(table.querySelectorAll("tr"));
    if (!rows.length) {
      return [];
    }

    const headerCells = Array.from(rows[0].querySelectorAll("th,td")).map((el) =>
      normalizeWhitespace(el.textContent)
    );

    const col = {
      siraNo: findHeaderIndex(headerCells, ["Sıra", "Sira"]),
      description: findHeaderIndex(headerCells, ["Mal Hizmet", "Hizmet", "Açıklama", "Aciklama"]),
      quantity: findHeaderIndex(headerCells, ["Miktar"]),
      unitPrice: findHeaderIndex(headerCells, ["Birim Fiyat"]),
      lineTotal: findHeaderIndex(headerCells, ["Mal Hizmet Tutar", "Tutar"]),
      vatRate: findHeaderIndex(headerCells, ["KDV Oranı", "Vergi Oranı"]),
      vatAmount: findHeaderIndex(headerCells, ["KDV Tutar", "Vergi Tutar"])
    };

    const items = [];

    for (let i = 1; i < rows.length; i += 1) {
      const cells = Array.from(rows[i].querySelectorAll("td"));
      if (cells.length < 2) {
        continue;
      }

      const description = getCellValue(cells, col.description, 1);
      if (!description) {
        continue;
      }

      const quantityRaw = getCellValue(cells, col.quantity, 2);
      const quantitySplit = splitQuantityAndUnit(quantityRaw);

      items.push({
        siraNo: getCellValue(cells, col.siraNo, 0) || String(items.length + 1),
        description,
        quantityRaw,
        quantity: quantitySplit.quantity,
        unit: quantitySplit.unit,
        unitPrice: getCellValue(cells, col.unitPrice, 3),
        lineTotal: getCellValue(cells, col.lineTotal, 4),
        vatRate: getCellValue(cells, col.vatRate, 5),
        vatAmount: getCellValue(cells, col.vatAmount, 6)
      });
    }

    return items;
  }

  function findTableByHeader(root, requiredTokens) {
    const tables = Array.from(root.querySelectorAll("table"));
    return (
      tables.find((table) => {
        const text = normalizeWhitespace(table.textContent).toLowerCase();
        return requiredTokens.every((token) => text.includes(token.toLowerCase()));
      }) || null
    );
  }

  function findHeaderIndex(headerCells, keywords) {
    const index = headerCells.findIndex((headerText) => {
      const normalized = headerText.toLowerCase();
      return keywords.some((kw) => normalized.includes(kw.toLowerCase()));
    });

    return index;
  }

  function getCellValue(cells, preferredIndex, fallbackIndex) {
    if (preferredIndex >= 0 && preferredIndex < cells.length) {
      return normalizeWhitespace(cells[preferredIndex].textContent);
    }
    if (fallbackIndex >= 0 && fallbackIndex < cells.length) {
      return normalizeWhitespace(cells[fallbackIndex].textContent);
    }
    return "";
  }

  function splitQuantityAndUnit(value) {
    const cleaned = normalizeWhitespace(value);
    if (!cleaned) {
      return { quantity: "", unit: "" };
    }

    const match = cleaned.match(/^([\d.,]+)\s*(.*)$/);
    if (!match) {
      return { quantity: "", unit: getUnitLabel(cleaned) };
    }

    return {
      quantity: normalizeWhitespace(match[1]),
      unit: getUnitLabel(match[2])
    };
  }

  function getUnitLabel(value) {
    const cleaned = normalizeWhitespace(value);
    if (!cleaned) {
      return "";
    }

    const normalizedCode = cleaned.toUpperCase("tr-TR");
    return UNIT_CODE_LABELS[normalizedCode] || cleaned;
  }

  function extractTotals(root, qrMap) {
    const totals = {};

    // Main totals area on e-Fatura HTML.
    const totalRows = root.querySelectorAll("#toplamlarContainer tr, .toplamlar tr");
    totalRows.forEach((row) => {
      const th = row.querySelector("th");
      const td = row.querySelector("td");
      if (!th || !td) {
        return;
      }

      const key = cleanLabel(th.textContent);
      const value = normalizeWhitespace(td.textContent);
      if (key && value) {
        totals[key] = value;
      }
    });

    // Fallback from QR payload when totals table is missing.
    const qrFallback = {
      "Mal Hizmet Toplam Tutarı": qrMap.malhizmettoplam,
      "KDV Matrahı": qrMap["kdvmatrah(20)"] || qrMap.kdvmatrah,
      "Hesaplanan KDV": qrMap["hesaplanankdv(20)"] || qrMap.hesaplanankdv,
      "Vergiler Dahil Toplam Tutar": qrMap.vergidahil,
      "Ödenecek Tutar": qrMap.odenecek
    };

    Object.entries(qrFallback).forEach(([key, value]) => {
      if (!value || totals[key]) {
        return;
      }
      totals[key] = value;
    });

    return totals;
  }

  function extractNotes(root) {
    const notes = allText(root, ["#notes", "#notlar #notes", "#notlar span"]);
    return Array.from(new Set(notes.filter(Boolean)));
  }

  function detectCurrency(totals) {
    const raw = Object.values(totals).join(" ");
    if (/\bTL\b|₺/i.test(raw)) {
      return "TRY";
    }
    if (/\bEUR\b|€/i.test(raw)) {
      return "EUR";
    }
    if (/\bUSD\b|\$/i.test(raw)) {
      return "USD";
    }
    return "";
  }

  function findValueByLabel(root, labels) {
    const normalizedLabels = labels.map((label) => cleanLabel(label).toLowerCase());

    // 1) Table-like rows: first cell is label, second cell is value.
    const rows = root.querySelectorAll("tr");
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll("th,td"));
      if (cells.length < 2) {
        continue;
      }

      const key = cleanLabel(cells[0].textContent).toLowerCase();
      if (!key) {
        continue;
      }

      if (normalizedLabels.some((label) => key.includes(label))) {
        const value = normalizeWhitespace(cells[1].textContent);
        if (value) {
          return value;
        }
      }
    }

    // 2) Generic text nodes with "Label: Value" format.
    const nodes = root.querySelectorAll("div, span, p, td, th, li");
    for (const node of nodes) {
      const txt = normalizeWhitespace(node.textContent);
      if (!txt || txt.length > 250) {
        continue;
      }

      for (const label of normalizedLabels) {
        const pattern = new RegExp(`^${escapeRegExp(label)}\\s*:?\\s*(.+)$`, "i");
        const match = txt.match(pattern);
        if (match && match[1]) {
          return normalizeWhitespace(match[1]);
        }
      }
    }

    return "";
  }

  function findTextByPrefix(root, prefixes) {
    const nodes = root.querySelectorAll("div, span, p, td");
    for (const node of nodes) {
      const txt = normalizeWhitespace(node.textContent);
      if (!txt || txt.length > 250) {
        continue;
      }

      for (const prefix of prefixes) {
        if (txt.toLowerCase().startsWith(prefix.toLowerCase())) {
          const parts = txt.split(":");
          if (parts.length > 1) {
            return normalizeWhitespace(parts.slice(1).join(":"));
          }
          return txt;
        }
      }
    }

    return "";
  }

  function firstText(root, selectors) {
    for (const selector of selectors) {
      const el = root.querySelector(selector);
      if (!el) {
        continue;
      }

      const text = normalizeWhitespace(el.textContent);
      if (text) {
        return text;
      }
    }

    return "";
  }

  function allText(root, selectors) {
    const output = [];

    selectors.forEach((selector) => {
      const nodes = root.querySelectorAll(selector);
      nodes.forEach((node) => {
        const txt = normalizeWhitespace(node.textContent);
        if (txt) {
          output.push(txt);
        }
      });
    });

    return output;
  }

  function firstElement(root, selectors) {
    for (const selector of selectors) {
      const el = root.querySelector(selector);
      if (el) {
        return el;
      }
    }
    return null;
  }

  function cleanLabel(value) {
    return normalizeWhitespace(value).replace(/\s*:\s*$/, "");
  }

  function normalizeWhitespace(value) {
    return (value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  }

  function normalizeDigits(value) {
    return String(value || "").replace(/\D/g, "");
  }

  function containsTaxNumber(node, taxNumber) {
    const normalizedTaxNumber = normalizeDigits(taxNumber);
    if (!normalizedTaxNumber || !node) {
      return false;
    }

    const textDigits = normalizeDigits(node.textContent || "");
    return textDigits.includes(normalizedTaxNumber);
  }

  function decodeHtmlEntities(value) {
    const raw = String(value || "");
    if (!raw) {
      return "";
    }

    const textarea = document.createElement("textarea");
    textarea.innerHTML = raw;
    return normalizeWhitespace(textarea.value || textarea.textContent || "");
  }

  function firstNonEmpty(...values) {
    for (const value of values) {
      const cleaned = normalizeWhitespace(value);
      if (cleaned) {
        return cleaned;
      }
    }
    return "";
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  async function getSettings() {
    const result = await storageGet(STORAGE_KEYS.SETTINGS);
    return {
      ...DEFAULT_SETTINGS,
      ...(result[STORAGE_KEYS.SETTINGS] || {})
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

  function sendRuntimeMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response);
      });
    });
  }

  async function openOptionsPage() {
    const response = await sendRuntimeMessage({ type: "MKF_OPEN_OPTIONS_PAGE" });
    if (!response?.ok) {
      throw new Error(response?.error || "Ayarlar sayfası açılamadı.");
    }
  }
})();
