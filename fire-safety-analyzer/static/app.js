// ── DOM refs ────────────────────────────────────────────────────
const dropZone = document.getElementById("drop-zone");
const fileInput = document.getElementById("file-input");
const fileInfo = document.getElementById("file-info");
const fileName = document.getElementById("file-name");
const analyzeBtn = document.getElementById("analyze-btn");
const newUploadBtn = document.getElementById("new-upload-btn");
const docList = document.getElementById("doc-list");
const uploadSection = document.getElementById("upload-section");
const loadingSection = document.getElementById("loading-section");
const resultsSection = document.getElementById("results-section");
const errorSection = document.getElementById("error-section");
const errorMessage = document.getElementById("error-message");
const retryBtn = document.getElementById("retry-btn");
const exportBtn = document.getElementById("export-btn");

let selectedFile = null;
let currentDocId = null;

// ── Upload handling ─────────────────────────────────────────────
dropZone.addEventListener("click", () => fileInput.click());
dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.classList.add("drag-over");
});
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));
dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("drag-over");
  if (e.dataTransfer.files.length) selectFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener("change", () => {
  if (fileInput.files.length) selectFile(fileInput.files[0]);
});
newUploadBtn.addEventListener("click", () => {
  currentDocId = null;
  highlightDocItem(null);
  // Ensure we're on the analisi tab
  if (typeof switchSidebarTab === "function") switchSidebarTab("analisi");
  showSection("upload");
});

function selectFile(file) {
  if (!file.name.toLowerCase().endsWith(".pdf")) {
    alert("Seleziona un file PDF");
    return;
  }
  selectedFile = file;
  fileName.textContent = file.name;
  fileInfo.classList.remove("hidden");
}

// ── Analyze ─────────────────────────────────────────────────────
analyzeBtn.addEventListener("click", analyze);
retryBtn.addEventListener("click", () => showSection("upload"));
exportBtn.addEventListener("click", () => {
  if (!currentDocId) return;
  window.open(`/analyses/${currentDocId}/export`, "_blank");
});

async function analyze() {
  if (!selectedFile) return;
  showSection("loading");

  const formData = new FormData();
  formData.append("file", selectedFile);

  try {
    const resp = await fetch("/analyze", { method: "POST", body: formData });
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(err || resp.statusText);
    }
    const entry = await resp.json();
    currentDocId = entry.id;
    addDocToSidebar(entry);
    highlightDocItem(entry.id);
    renderResults(entry.result);
    showSection("results");
    // Reset file input
    selectedFile = null;
    fileInput.value = "";
    fileInfo.classList.add("hidden");
  } catch (e) {
    errorMessage.textContent = e.message;
    showSection("error");
  }
}

function showSection(name) {
  uploadSection.classList.toggle("hidden", name !== "upload");
  loadingSection.classList.toggle("hidden", name !== "loading");
  resultsSection.classList.toggle("hidden", name !== "results");
  errorSection.classList.toggle("hidden", name !== "error");
}

// ── Sidebar: document list ──────────────────────────────────────
function addDocToSidebar(entry) {
  const item = document.createElement("button");
  item.className = "doc-item";
  item.dataset.id = entry.id;
  item.innerHTML = `
    <div class="font-medium text-sm truncate">${entry.filename}</div>
    <div class="text-xs text-gray-400">${formatTimestamp(entry.timestamp)}</div>
  `;
  item.addEventListener("click", () => loadDocument(entry.id));
  docList.prepend(item);
}

function highlightDocItem(id) {
  docList.querySelectorAll(".doc-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.id === id);
  });
}

async function loadDocument(docId) {
  if (docId === currentDocId) return;
  showSection("loading");
  try {
    const resp = await fetch(`/analyses/${docId}`);
    if (!resp.ok) throw new Error("Documento non trovato");
    const entry = await resp.json();
    currentDocId = entry.id;
    highlightDocItem(entry.id);
    renderResults(entry.result);
    showSection("results");
  } catch (e) {
    errorMessage.textContent = e.message;
    showSection("error");
  }
}

function formatTimestamp(ts) {
  const d = new Date(ts);
  return d.toLocaleString("it-IT", {
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit"
  });
}

// Load existing documents on startup
async function loadSidebar() {
  try {
    const resp = await fetch("/analyses");
    const list = await resp.json();
    list.reverse().forEach(addDocToSidebar);
  } catch (e) { /* ignore on first load */ }
}
loadSidebar();

// ── Render results ──────────────────────────────────────────────
function renderResults(data) {
  renderHeader(data.header);
  renderBuildings(data.buildings);
}

// ── Header card ─────────────────────────────────────────────────
const HEADER_FIELDS = [
  ["tecnico_firmatario", "Tecnico Firmatario"],
  ["studio_tecnico", "Studio Tecnico"],
  ["committente_nome", "Committente"],
  ["committente_indirizzo", "Indirizzo Committente"],
  ["attivita_descrizione", "Descrizione Attivita"],
  ["ubicazione", "Ubicazione"],
  ["data_relazione", "Data Relazione"],
  ["riferimento_pratica", "Riferimento Pratica"],
  ["tipo_pratica", "Tipo Pratica"],
];

function renderHeader(header) {
  const grid = document.getElementById("header-grid");
  grid.innerHTML = "";
  for (const [key, label] of HEADER_FIELDS) {
    let val = header[key];
    const div = document.createElement("div");
    div.innerHTML = `
      <div class="field-label">${label}</div>
      <div class="field-value">${val ?? '<span class="text-gray-300">&mdash;</span>'}</div>
    `;
    grid.appendChild(div);
  }
  // Attività DPR 151/11
  const dprList = header.attivita_dpr || [];
  if (dprList.length) {
    const dprDiv = document.createElement("div");
    dprDiv.className = "md:col-span-2";
    let dprHtml = '<div class="field-label">Attivita DPR 151/11</div><div class="mt-1 space-y-1">';
    for (const a of dprList) {
      dprHtml += `<div class="text-sm">
        <span class="font-semibold text-red-700">${a.codice}</span>
        ${a.descrizione ? `<span class="text-gray-600"> &mdash; ${a.descrizione}</span>` : ""}
      </div>`;
    }
    dprHtml += "</div>";
    dprDiv.innerHTML = dprHtml;
    grid.appendChild(dprDiv);
  }
}

// ── Buildings ───────────────────────────────────────────────────
function renderBuildings(buildings) {
  const tabs = document.getElementById("building-tabs");
  const content = document.getElementById("building-content");
  tabs.innerHTML = "";
  content.innerHTML = "";

  if (!buildings.length) {
    content.innerHTML = '<p class="text-gray-400">Nessun edificio identificato</p>';
    return;
  }

  buildings.forEach((b, i) => {
    const tab = document.createElement("button");
    tab.className = "building-tab" + (i === 0 ? " active" : "");
    tab.textContent = b.nome || b.id;
    tab.addEventListener("click", () => {
      tabs.querySelectorAll(".building-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      renderBuildingContent(b, content);
    });
    tabs.appendChild(tab);
  });

  renderBuildingContent(buildings[0], content);
}

function renderBuildingContent(building, container) {
  container.innerHTML = "";
  if (!building.compartments.length) {
    container.innerHTML = '<p class="text-gray-400">Nessun compartimento</p>';
    return;
  }

  building.compartments.forEach((comp) => {
    const card = document.createElement("div");
    card.className = "compartment-card mb-3";
    card.innerHTML = `
      <div class="compartment-header" onclick="toggleCompartment(this)">
        <div class="flex items-center gap-3 flex-wrap">
          <span class="font-medium">${comp.id} &mdash; ${comp.nome}</span>
          ${riskBadges(comp.risk_profile)}
          ${comp.ambito_aperto ? '<span class="badge badge-gray">Aperto</span>' : ""}
        </div>
        <span class="arrow">&#9654;</span>
      </div>
      <div class="compartment-body">
        ${compartmentDetails(comp)}
      </div>
    `;
    container.appendChild(card);
  });
}

// ── Compartment details ─────────────────────────────────────────
function compartmentDetails(comp) {
  const rp = comp.risk_profile;
  let html = '<div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">';
  html += field("Superficie", comp.superficie_mq != null ? `${comp.superficie_mq} mq` : null);
  html += field("Multipiano", comp.multipiano != null ? (comp.multipiano ? "Si" : "No") : null);
  html += field("Ambito aperto", comp.ambito_aperto ? "Si" : "No");
  html += field("Assegnazione", rp?.source ?? null);
  html += "</div>";

  // Risk profile table with values and razionali
  if (rp) {
    const dash = '<span class="text-gray-300">&mdash;</span>';
    const v = rp.validation || {};
    const icon = validationIcon(v.status);
    const riskRows = [
      ["Rvita", rp.rvita ? `${rp.rvita} ${icon}` : dash, rp.razionale_rvita],
      ["\u03B4occ", rp.delta_occ ?? dash, rp.razionale_delta_occ],
      ["\u03B4\u03B1", rp.delta_alpha ?? dash, rp.razionale_delta_alpha],
      ["qf (MJ/m\u00B2)", rp.carico_incendio_mj_m2 != null ? String(rp.carico_incendio_mj_m2) : dash, rp.razionale_carico_incendio],
      ["Rbeni", rp.rbeni != null ? String(rp.rbeni) : dash, rp.razionale_rbeni],
      ["Rambiente", rp.rambiente ?? dash, rp.razionale_rambiente],
    ];
    html += `<table class="w-full text-sm mb-4">
      <thead><tr class="text-left text-gray-500 border-b">
        <th class="pb-1 w-32">Parametro</th>
        <th class="pb-1 w-24">Valore</th>
        <th class="pb-1">Razionale</th>
      </tr></thead><tbody>`;
    for (const [label, val, raz] of riskRows) {
      html += `<tr class="border-b border-gray-100">
        <td class="py-2 font-medium text-gray-700">${label}</td>
        <td class="py-2">${val}</td>
        <td class="py-2 text-gray-600 text-xs leading-relaxed">${raz ?? dash}</td>
      </tr>`;
    }
    html += "</tbody></table>";
  }

  if (rp?.note_riduzione) {
    html += `<div class="text-sm text-amber-700 bg-amber-50 px-3 py-2 rounded mb-3">
      <strong>Nota riduzione:</strong> ${rp.note_riduzione}
    </div>`;
  }

  // Measures S.1-S.10
  const measures = comp.measures || [];
  if (measures.length) {
    const dash = '<span class="text-gray-300">&mdash;</span>';
    html += `<div class="mt-4 border-t pt-4">
      <h4 class="text-sm font-semibold text-gray-700 mb-2">Misure Antincendio</h4>
      <table class="w-full text-sm">
        <thead><tr class="text-left text-gray-500 border-b">
          <th class="pb-1 w-8"></th>
          <th class="pb-1 w-40">Misura</th>
          <th class="pb-1 w-16">Livello</th>
          <th class="pb-1">Soluzione tecnica</th>
          <th class="pb-1">Razionale livello</th>
          <th class="pb-1">Razionale soluzione</th>
        </tr></thead><tbody>`;
    for (const m of measures) {
      const v = m.validation || {};
      const icon = validationIcon(v.status);
      const rowClass = validationRowClass(v.status);
      html += `<tr class="border-b border-gray-100 ${rowClass}">
        <td class="py-2 text-center" title="${v.message || 'Non validato'}">${icon}</td>
        <td class="py-2 font-medium">${m.codice}${m.nome ? ` - ${m.nome}` : ""}</td>
        <td class="py-2">${m.livello_prestazione ?? dash}</td>
        <td class="py-2">${m.soluzione_tecnica ?? dash}</td>
        <td class="py-2 text-gray-600 text-xs leading-relaxed">${m.razionale_livello ?? dash}</td>
        <td class="py-2 text-gray-600 text-xs leading-relaxed">${m.razionale_soluzione ?? dash}</td>
      </tr>`;
      if (v.message && v.status !== "not_validated") {
        html += `<tr><td></td><td colspan="5" class="text-xs pb-2 ${
          v.status === "error" ? "text-red-600" : v.status === "warning" ? "text-amber-600" : "text-green-600"
        }">${v.message}${v.expected ? ` (atteso: ${v.expected})` : ""}</td></tr>`;
      }
    }
    html += "</tbody></table></div>";
  }

  // Rooms table
  if (comp.locali.length) {
    html += `<div class="mt-4 border-t pt-4">
      <h4 class="text-sm font-semibold text-gray-700 mb-2">Locali</h4>
      <table class="w-full text-sm">
        <thead><tr class="text-left text-gray-500 border-b">
          <th class="pb-1">Locale</th><th class="pb-1">Piano</th>
        </tr></thead><tbody>`;
    for (const r of comp.locali) {
      html += `<tr class="border-b border-gray-100">
        <td class="py-1">${r.nome}</td>
        <td class="py-1">${r.piano ?? '<span class="text-gray-300">&mdash;</span>'}</td>
      </tr>`;
    }
    html += "</tbody></table></div>";
  }

  return html;
}

function field(label, val) {
  return `<div>
    <div class="field-label">${label}</div>
    <div class="field-value">${val ?? '<span class="text-gray-300">&mdash;</span>'}</div>
  </div>`;
}

function expandableRazionale(label, text) {
  const id = "raz-" + Math.random().toString(36).slice(2, 8);
  return `<div class="razionale-item">
    <button class="razionale-toggle" onclick="document.getElementById('${id}').classList.toggle('open')">
      <span class="razionale-label">${label}</span>
      <span class="razionale-arrow">&#9654;</span>
    </button>
    <div id="${id}" class="razionale-body">${text}</div>
  </div>`;
}

function fieldWithValidation(label, val, validation) {
  const v = validation || {};
  const icon = validationIcon(v.status);
  const tooltip = v.message || "";
  return `<div>
    <div class="field-label">${label}</div>
    <div class="field-value flex items-center gap-1">
      ${val ?? '<span class="text-gray-300">&mdash;</span>'}
      <span title="${tooltip}">${icon}</span>
    </div>
  </div>`;
}

// ── Validation helpers ──────────────────────────────────────────
function validationIcon(status) {
  switch (status) {
    case "ok":    return '<span class="v-icon v-ok" title="Conforme">&#10003;</span>';
    case "warning": return '<span class="v-icon v-warn" title="Warning">&#9888;</span>';
    case "error": return '<span class="v-icon v-err" title="Errore">&#10007;</span>';
    default:      return '<span class="v-icon v-none" title="Non validato">&#9744;</span>';
  }
}

function validationRowClass(status) {
  switch (status) {
    case "ok":    return "validation-ok";
    case "warning": return "validation-warn";
    case "error": return "validation-err";
    default:      return "";
  }
}

// ── Risk badges ─────────────────────────────────────────────────
function rvitaColor(v) {
  if (!v) return "gray";
  const u = v.toUpperCase();
  if (u.startsWith("A1") || u.startsWith("A2")) return "green";
  if (u.startsWith("A3") || u.startsWith("B1") || u.startsWith("B2")) return "yellow";
  if (u.startsWith("B3") || u.startsWith("C")) return "orange";
  return "red";
}

function riskBadges(rp) {
  if (!rp) return "";
  let html = "";
  if (rp.rvita) html += `<span class="badge badge-${rvitaColor(rp.rvita)}">Rvita ${rp.rvita}</span>`;
  if (rp.rbeni != null) html += `<span class="badge badge-gray">Rbeni ${rp.rbeni}</span>`;
  if (rp.rambiente) {
    const c = rp.rambiente.toLowerCase().includes("non significativo") ? "green" : "red";
    html += `<span class="badge badge-${c}">Ramb ${rp.rambiente}</span>`;
  }
  return html;
}

// ── Toggle compartment ──────────────────────────────────────────
function toggleCompartment(header) {
  header.classList.toggle("open");
  header.nextElementSibling.classList.toggle("open");
}
