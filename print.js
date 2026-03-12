// print.js
// - Reads last payload from chrome.storage.local.
// - Renders print-ready Muayene ve Kabul Tutanağı.

(() => {
  "use strict";

  const STORAGE_KEYS = {
    PRINT_PAYLOAD: "mkf_print_payload",
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

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    bindScreenActions();

    const payload = isSampleMode() ? await loadSamplePayload() : await loadPayload();
    if (!payload) {
      renderError("Yazdırılacak veri bulunamadı. Önce fatura sayfasındaki butondan form üretin.");
      return;
    }

    render(payload);
    setupPaginationEvents();
  }

  function bindScreenActions() {
    const printButton = document.getElementById("printButton");
    const settingsLink = document.getElementById("settingsLink");

    printButton?.addEventListener("click", () => {
      // Let beforeprint handle page marker calculation in print layout.
      window.print();
    });

    settingsLink?.addEventListener("click", (event) => {
      event.preventDefault();
      chrome.runtime.openOptionsPage();
    });
  }

  async function loadPayload() {
    const data = await storageGet(STORAGE_KEYS.PRINT_PAYLOAD);
    const payload = data[STORAGE_KEYS.PRINT_PAYLOAD] || null;

    if (!payload) {
      return null;
    }

    // If hash exists, ensure this tab corresponds to current payload id.
    const hash = decodeURIComponent((window.location.hash || "").replace(/^#/, ""));
    if (hash && payload.__meta?.id && hash !== payload.__meta.id) {
      return null;
    }

    return payload;
  }

  function isSampleMode() {
    const params = new URLSearchParams(window.location.search);
    return params.get("sample") === "1";
  }

  async function loadSamplePayload() {
    const data = await storageGet([STORAGE_KEYS.SETTINGS, STORAGE_KEYS.YAPILAN_IS_HISTORY]);
    const settings = {
      ...DEFAULT_SETTINGS,
      ...(data[STORAGE_KEYS.SETTINGS] || {})
    };

    const history = normalizeHistory(data[STORAGE_KEYS.YAPILAN_IS_HISTORY]);
    const today = new Date();
    const y = today.getFullYear();
    const m = String(today.getMonth() + 1).padStart(2, "0");
    const d = String(today.getDate()).padStart(2, "0");
    const dateValue = `${y}-${m}-${d}`;

    const sampleSettings = {
      idareAdi: settings.idareAdi || "Örnek İlkokulu Müdürlüğü",
      muayeneEdilenYer: settings.muayeneEdilenYer || "Örnek İlkokulu Deposu",
      komisyonBaskani: settings.komisyonBaskani || "Ahmet YILMAZ",
      uyeler: normalizeMembers(settings.uyeler),
      okulMuduru: settings.okulMuduru || "Ayşe KARA"
    };

    if (!sampleSettings.uyeler.length) {
      sampleSettings.uyeler = ["Mehmet DEMİR", "Fatma AK", "Ali ÇELİK"];
    }

    return {
      sourceUrl: "sample-preview",
      scrapedAt: new Date().toISOString(),
      yapilanIs: history[0] || "Klima Alımı",
      settings: sampleSettings,
      invoice: {
        number: `ORNEK${y}${m}${d}0001`,
        date: dateValue,
        seller: {
          name: "Örnek Tedarik Ltd. Şti."
        },
        items: [
          {
            siraNo: "1",
            description: "Duvar Tipi Klima 12000 BTU",
            quantity: "2",
            unit: "Adet",
            quantityRaw: "2 Adet"
          },
          {
            siraNo: "2",
            description: "Klima Montaj Hizmeti",
            quantity: "1",
            unit: "Hizmet",
            quantityRaw: "1 Hizmet"
          }
        ]
      }
    };
  }

  function render(payload) {
    const settings = payload.settings || {};
    const invoice = payload.invoice || {};
    const items = Array.isArray(invoice.items) ? invoice.items : [];

    const invoiceDateFormatted = formatDate(invoice.date);
    const onayBelgesi = buildOnayBelgesi(invoiceDateFormatted, invoice.number);

    setText("idareAdi", settings.idareAdi || "-");
    setText("yapilanIs", payload.yapilanIs || "-");
    setText("onayBelgesi", onayBelgesi || "-");
    setText("satanFirma", invoice.seller?.name || "-");
    setText("muayeneYeri", settings.muayeneEdilenYer || "-");

    renderItems(items, invoiceDateFormatted);
    renderNarrative(payload, invoiceDateFormatted);
    renderSignatures(settings);

    setText("formDate", invoiceDateFormatted || formatDate(new Date().toISOString()));
    setText("okulMuduru", settings.okulMuduru || "-");
  }

  function renderItems(items, invoiceDateFormatted) {
    const body = document.getElementById("itemsBody");
    if (!body) {
      return;
    }

    body.innerHTML = "";

    if (!items.length) {
      const tr = document.createElement("tr");
      tr.innerHTML =
        '<td colspan="7" class="empty-line">Fatura kalemleri bulunamadı</td>';
      body.appendChild(tr);
      return;
    }

    items.forEach((item, index) => {
      const tr = document.createElement("tr");
      const quantityForForm = formatQuantityWithTwoDecimals(item.quantity, item.quantityRaw);
      const kabulMiktar = quantityForForm || "-";
      const unitLabel = getUnitLabel(item.unit);

      tr.innerHTML = `
        <td>${sanitize(item.siraNo) || index + 1}</td>
        <td>${sanitize(item.description)}</td>
        <td>${sanitize(quantityForForm) || "-"}</td>
        <td>${sanitize(unitLabel) || "-"}</td>
        <td>${sanitize(invoiceDateFormatted) || "-"}</td>
        <td>${sanitize(kabulMiktar)}</td>
        <td>0</td>
      `;

      body.appendChild(tr);
    });
  }

  function renderNarrative(payload, invoiceDateFormatted) {
    const el = document.getElementById("narrativeText");
    if (!el) {
      return;
    }

    const invoice = payload.invoice || {};
    const sellerName = invoice.seller?.name || "-";
    const itemCount = (invoice.items || []).length;
    const itemCountWord = numberToTurkishWords(itemCount).toLocaleUpperCase("tr-TR");

    const text = `Müdürlüğümüz ihtiyaçlarında kullanılmak üzere ${String(
      payload.yapilanIs || ""
    )} ile ilgili olarak (${String(invoiceDateFormatted)} tarihli ve ${String(
      invoice.number || ""
    )} seri) ${String(
      sellerName
    )} firmasından yukarıda alımı yapılan ${itemCount}(${itemCountWord}) kalem malzemenin muayenesi yapılmıştır. Tarafımızca yapılan kontrol ve muayene sonucunda noksansız yapıldığı görülmüş olup bedelinin ödenmesinde bir sakınca bulunmamaktadır.`;

    el.textContent = text;
  }

  function renderSignatures(settings) {
    const container = document.getElementById("signatures");
    if (!container) {
      return;
    }

    container.innerHTML = "";

    const signatures = [];
    const chairman = String(settings.komisyonBaskani || "").trim();

    if (chairman) {
      signatures.push({
        name: chairman,
        role: "Komisyon Başkanı"
      });
    }

    const members = Array.isArray(settings.uyeler)
      ? settings.uyeler.map((m) => String(m || "").trim()).filter(Boolean)
      : [];

    if (members.length) {
      members.forEach((member) => {
        signatures.push({ name: member, role: "Üye" });
      });
    }

    if (!signatures.length) {
      container.style.gridTemplateColumns = "1fr";
      const info = document.createElement("div");
      info.className = "empty-line";
      info.textContent = "Muayene ve kabul görevlisi bilgisi girilmemiş.";
      container.appendChild(info);
      return;
    }

    const columnCount = Math.min(4, signatures.length);
    container.style.gridTemplateColumns = `repeat(${columnCount}, minmax(0, 1fr))`;

    signatures.forEach((item) => {
      const box = document.createElement("div");
      box.className = "signature-box";
      box.innerHTML = `
        <div class="signature-name">${sanitize(item.name)}</div>
        <div class="signature-role">${sanitize(item.role)}</div>
      `;
      container.appendChild(box);
    });
  }

  function setupPaginationEvents() {
    window.addEventListener("beforeprint", updatePageMarkers);
    window.addEventListener("afterprint", clearPageMarkers);
  }

  function updatePageMarkers() {
    const root = document.getElementById("documentRoot");
    const markerLayer = document.getElementById("pageMarkers");
    if (!root || !markerLayer) {
      return;
    }

    if (typeof root.dataset.baseMinHeight === "undefined") {
      root.dataset.baseMinHeight = root.style.minHeight || "";
    }

    markerLayer.innerHTML = "";

    // Must match @page margins in style.css.
    const printablePageHeightPx = mmToPx(297 - 18);
    const contentHeightPx = getNaturalContentHeight(root);
    const totalPages = getPageCount(contentHeightPx, printablePageHeightPx);

    if (totalPages <= 1) {
      root.style.minHeight = root.dataset.baseMinHeight;
      return;
    }

    // Extend the document to full page multiples so every footer can sit at page bottom.
    root.style.minHeight = `${Math.ceil(totalPages * printablePageHeightPx)}px`;

    for (let i = 1; i <= totalPages; i += 1) {
      const marker = document.createElement("div");
      marker.className = "page-marker";
      marker.textContent = `${i}/${totalPages}`;

      // Place marker near the bottom of each printed page.
      const markerTop = i * printablePageHeightPx - mmToPx(7);
      marker.style.top = `${Math.max(0, markerTop)}px`;
      markerLayer.appendChild(marker);
    }
  }

  function clearPageMarkers() {
    const root = document.getElementById("documentRoot");
    const markerLayer = document.getElementById("pageMarkers");
    if (markerLayer) {
      markerLayer.innerHTML = "";
    }

    if (root && typeof root.dataset.baseMinHeight !== "undefined") {
      root.style.minHeight = root.dataset.baseMinHeight;
    }
  }

  function mmToPx(mm) {
    return (mm * 96) / 25.4;
  }

  function getNaturalContentHeight(root) {
    const prevMinHeight = root.style.minHeight;
    const prevHeight = root.style.height;

    // Ignore CSS minimums during pagination measurement.
    root.style.minHeight = "0";
    root.style.height = "auto";
    const measured = root.scrollHeight;
    const styles = window.getComputedStyle(root);
    const verticalPadding =
      (Number.parseFloat(styles.paddingTop) || 0) +
      (Number.parseFloat(styles.paddingBottom) || 0);

    root.style.minHeight = prevMinHeight;
    root.style.height = prevHeight;
    return Math.max(0, measured - verticalPadding);
  }

  function getPageCount(contentHeightPx, pageHeightPx) {
    // Small tolerance prevents false 2-page detection from sub-pixel rounding.
    const tolerancePx = 3;
    return Math.max(1, Math.ceil((contentHeightPx - tolerancePx) / pageHeightPx));
  }

  function normalizeHistory(values) {
    if (!Array.isArray(values)) {
      return [];
    }
    const output = [];
    const seen = new Set();
    values.forEach((value) => {
      const cleaned = String(value || "").replace(/\s+/g, " ").trim();
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

  function normalizeMembers(values) {
    if (!Array.isArray(values)) {
      return [];
    }
    return values.map((v) => String(v || "").trim()).filter(Boolean);
  }

  function buildOnayBelgesi(dateText, invoiceNo) {
    const safeDate = String(dateText || "").trim();
    const safeNo = String(invoiceNo || "").trim();

    if (safeDate && safeNo) {
      return `${safeDate} / ${safeNo}`;
    }
    return safeDate || safeNo || "";
  }

  function numberToTurkishWords(input) {
    const n = Number(input);
    if (!Number.isFinite(n) || n < 0) {
      return "";
    }

    if (n === 0) {
      return "sıfır";
    }

    const ones = [
      "",
      "bir",
      "iki",
      "üç",
      "dört",
      "beş",
      "altı",
      "yedi",
      "sekiz",
      "dokuz"
    ];
    const tens = ["", "on", "yirmi", "otuz", "kırk", "elli", "altmış", "yetmiş", "seksen", "doksan"];

    function underThousand(x) {
      let text = "";
      const hundred = Math.floor(x / 100);
      const ten = Math.floor((x % 100) / 10);
      const one = x % 10;

      if (hundred > 0) {
        text += hundred === 1 ? "yüz" : `${ones[hundred]} yüz`;
      }
      if (ten > 0) {
        text += `${text ? " " : ""}${tens[ten]}`;
      }
      if (one > 0) {
        text += `${text ? " " : ""}${ones[one]}`;
      }

      return text;
    }

    const billion = Math.floor(n / 1_000_000_000);
    const million = Math.floor((n % 1_000_000_000) / 1_000_000);
    const thousand = Math.floor((n % 1_000_000) / 1_000);
    const remainder = n % 1000;

    const parts = [];

    if (billion) {
      parts.push(`${underThousand(billion)} milyar`);
    }
    if (million) {
      parts.push(`${underThousand(million)} milyon`);
    }
    if (thousand) {
      parts.push(thousand === 1 ? "bin" : `${underThousand(thousand)} bin`);
    }
    if (remainder) {
      parts.push(underThousand(remainder));
    }

    return parts.join(" ").trim();
  }

  function formatDate(rawDate) {
    const value = String(rawDate || "").trim();
    if (!value) {
      return "";
    }

    // yyyy-mm-dd or yyyy-mm-ddTHH:mm:ss
    const isoMatch = value.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (isoMatch) {
      const y = isoMatch[1];
      const m = isoMatch[2].padStart(2, "0");
      const d = isoMatch[3].padStart(2, "0");
      return `${d}/${m}/${y}`;
    }

    // dd-mm-yyyy or dd/mm/yyyy
    const trMatch = value.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
    if (trMatch) {
      const d = trMatch[1].padStart(2, "0");
      const m = trMatch[2].padStart(2, "0");
      const y = trMatch[3];
      return `${d}/${m}/${y}`;
    }

    // Last-resort Date parsing.
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      const d = String(parsed.getDate()).padStart(2, "0");
      const m = String(parsed.getMonth() + 1).padStart(2, "0");
      const y = parsed.getFullYear();
      return `${d}/${m}/${y}`;
    }

    return value;
  }

  function setText(id, value) {
    const el = document.getElementById(id);
    if (!el) {
      return;
    }
    el.textContent = value || "-";
  }

  function sanitize(value) {
    return String(value || "").replace(/[&<>"']/g, (char) => {
      switch (char) {
        case "&":
          return "&amp;";
        case "<":
          return "&lt;";
        case ">":
          return "&gt;";
        case '"':
          return "&quot;";
        case "'":
          return "&#39;";
        default:
          return char;
      }
    });
  }

  function getUnitLabel(value) {
    const cleaned = String(value || "").trim();
    if (!cleaned) {
      return "";
    }

    const normalizedCode = cleaned.toUpperCase("tr-TR");
    return UNIT_CODE_LABELS[normalizedCode] || cleaned;
  }

  function formatQuantityWithTwoDecimals(quantity, quantityRaw) {
    const direct = normalizeNumericValue(quantity);
    if (direct !== null) {
      return toTurkishTwoDecimal(direct);
    }

    const fromRaw = normalizeNumericValue(quantityRaw);
    if (fromRaw !== null) {
      return toTurkishTwoDecimal(fromRaw);
    }

    return "";
  }

  function normalizeNumericValue(value) {
    const text = String(value || "").trim();
    if (!text) {
      return null;
    }

    const match = text.match(/-?[\d.,]+/);
    if (!match) {
      return null;
    }

    const numericText = match[0];
    let normalized = numericText;

    if (numericText.includes(",") && numericText.includes(".")) {
      const lastComma = numericText.lastIndexOf(",");
      const lastDot = numericText.lastIndexOf(".");
      if (lastComma > lastDot) {
        // 1.234,56 -> 1234.56
        normalized = numericText.replace(/\./g, "").replace(",", ".");
      } else {
        // 1,234.56 -> 1234.56
        normalized = numericText.replace(/,/g, "");
      }
    } else if (numericText.includes(",")) {
      // 1234,56 -> 1234.56
      normalized = numericText.replace(",", ".");
    }

    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function toTurkishTwoDecimal(value) {
    return new Intl.NumberFormat("tr-TR", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
      useGrouping: false
    }).format(value);
  }

  function renderError(message) {
    const root = document.getElementById("documentRoot");
    if (!root) {
      return;
    }

    root.innerHTML = `
      <h1>MUAYENE VE KABUL TUTANAĞI</h1>
      <p class="narrative">${sanitize(message)}</p>
    `;
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
})();
