// ── Normativa tab: upload, ingestion polling, document list ─────

// ── DOM refs ────────────────────────────────────────────────────
const normUploadBtn = document.getElementById("norm-upload-btn");
const normDropZone = document.getElementById("norm-drop-zone");
const normFileInput = document.getElementById("norm-file-input");
const normFileInfo = document.getElementById("norm-file-info");
const normFileName = document.getElementById("norm-file-name");
const normMetaForm = document.getElementById("norm-meta-form");
const normAnalyzeBtn = document.getElementById("norm-analyze-btn");
const normList = document.getElementById("norm-list");
const normRetryBtn = document.getElementById("norm-retry-btn");

const normSections = {
  upload: document.getElementById("norm-upload-section"),
  processing: document.getElementById("norm-processing-section"),
  detail: document.getElementById("norm-detail-section"),
  error: document.getElementById("norm-error-section"),
};

let normSelectedFile = null;
let currentNormId = null;
let pollTimer = null;

// ── Sidebar navigation system ────────────────────────────────────
// Two top-level tabs: "pratiche" and "normativa" (expandable).
// Normativa sub-tabs: "norm-upload", "chunks", "chat".

const sidebarPratiche = document.getElementById("sidebar-pratiche");
const sidebarNormativa = document.getElementById("sidebar-normativa");
const sidebarChunks = document.getElementById("sidebar-chunks");
const sidebarChat = document.getElementById("sidebar-chat");
const normativaParentTab = document.getElementById("normativa-parent-tab");
const normativaSubnav = document.getElementById("normativa-subnav");

const allSidebarPanels = [sidebarPratiche, sidebarNormativa, sidebarChunks, sidebarChat];

const praticheSectionIds = [
  "clients-welcome-section", "client-docs-section", "client-entities-section",
  "client-doc-detail-section", "loading-section", "error-section"
];
const normativaSectionIds = [
  "norm-upload-section", "norm-processing-section",
  "norm-detail-section", "norm-error-section"
];
const allSectionIds = praticheSectionIds.concat(normativaSectionIds, ["chunks-section", "chat-section"]);

let activeTab = "pratiche";

function hideAllSections() {
  allSectionIds.forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.classList.add("hidden");
  });
}

function hideAllSidebarPanels() {
  allSidebarPanels.forEach(function (p) { if (p) p.classList.add("hidden"); });
}

function switchSidebarTab(tab) {
  activeTab = tab;

  // Update top-level tab active states
  var prTab = document.querySelector('.sidebar-tab[data-tab="pratiche"]');
  prTab.classList.toggle("active", tab === "pratiche");

  // Normativa parent is "active" when any normativa sub-tab is active
  var isNormChild = (tab === "norm-upload" || tab === "chunks" || tab === "chat");
  normativaParentTab.classList.toggle("active", isNormChild);
  normativaParentTab.classList.toggle("expanded", isNormChild);
  normativaSubnav.classList.toggle("hidden", !isNormChild);

  // Update sub-tab active states
  document.querySelectorAll(".sidebar-subtab").forEach(function (st) {
    st.classList.toggle("active", st.dataset.tab === tab);
  });

  // Hide everything first
  hideAllSections();
  hideAllSidebarPanels();

  if (tab === "pratiche") {
    sidebarPratiche.classList.remove("hidden");
    if (typeof showClientiView === "function") showClientiView();
  } else if (tab === "norm-upload") {
    sidebarNormativa.classList.remove("hidden");
    var anyNormVisible = normativaSectionIds.some(function (id) {
      return !document.getElementById(id).classList.contains("hidden");
    });
    // Since we hid everything, show the upload section
    normSections.upload.classList.remove("hidden");
    if (typeof loadNormDocPanel === "function") loadNormDocPanel();
  } else if (tab === "chunks") {
    sidebarChunks.classList.remove("hidden");
    var chunkSection = document.getElementById("chunks-section");
    if (chunkSection) chunkSection.classList.remove("hidden");
    if (typeof loadChunkDocFilter === "function") loadChunkDocFilter();
    if (typeof loadChunks === "function") loadChunks();
  } else if (tab === "chat") {
    sidebarChat.classList.remove("hidden");
    var chatSec = document.getElementById("chat-section");
    if (chatSec) chatSec.classList.remove("hidden");
    if (typeof loadConversationList === "function") loadConversationList();
  }
}

// ── Bind top-level tabs ─────────────────────────────────────────
document.querySelector('.sidebar-tab[data-tab="pratiche"]').addEventListener("click", function () {
  switchSidebarTab("pratiche");
});

normativaParentTab.addEventListener("click", function () {
  if (activeTab === "norm-upload" || activeTab === "chunks" || activeTab === "chat") {
    // Already expanded — collapse (go back to pratiche? or toggle?)
    // Keep expanded, just stay on current sub-tab
    return;
  }
  // Expand and go to first sub-tab
  switchSidebarTab("norm-upload");
});

// ── Bind sub-tabs ───────────────────────────────────────────────
document.querySelectorAll(".sidebar-subtab").forEach(function (st) {
  st.addEventListener("click", function () {
    switchSidebarTab(this.dataset.tab);
  });
});

// ── Normativa section switching ─────────────────────────────────
function showNormSection(name) {
  hideAllSections();
  Object.keys(normSections).forEach(function (key) {
    normSections[key].classList.toggle("hidden", key !== name);
  });
}

// ── Upload handling ─────────────────────────────────────────────
normUploadBtn.addEventListener("click", function () {
  currentNormId = null;
  highlightNormItem(null);
  switchSidebarTab("norm-upload");
  showNormSection("upload");
  // Reset form
  normFileInfo.classList.add("hidden");
  normMetaForm.classList.add("hidden");
  normSelectedFile = null;
});

normDropZone.addEventListener("click", function () { normFileInput.click(); });
normDropZone.addEventListener("dragover", function (e) {
  e.preventDefault();
  normDropZone.classList.add("drag-over");
});
normDropZone.addEventListener("dragleave", function () {
  normDropZone.classList.remove("drag-over");
});
normDropZone.addEventListener("drop", function (e) {
  e.preventDefault();
  normDropZone.classList.remove("drag-over");
  if (e.dataTransfer.files.length) selectNormFile(e.dataTransfer.files[0]);
});
normFileInput.addEventListener("change", function () {
  if (normFileInput.files.length) selectNormFile(normFileInput.files[0]);
});

function selectNormFile(file) {
  if (!file.name.toLowerCase().endsWith(".pdf")) {
    alert("Seleziona un file PDF");
    return;
  }
  normSelectedFile = file;
  normFileName.textContent = file.name;
  normFileInfo.classList.remove("hidden");
  normMetaForm.classList.remove("hidden");
  // Focus on nome_legge
  document.getElementById("norm-nome-legge").focus();
}

// ── Ingestion ───────────────────────────────────────────────────
normAnalyzeBtn.addEventListener("click", startIngestion);
normRetryBtn.addEventListener("click", function () { showNormSection("upload"); });

async function startIngestion() {
  if (!normSelectedFile) return;

  var nomeLegge = document.getElementById("norm-nome-legge").value.trim();
  if (!nomeLegge) {
    alert("Inserisci il nome breve della legge");
    document.getElementById("norm-nome-legge").focus();
    return;
  }

  showNormSection("processing");
  document.getElementById("norm-progress-text").textContent =
    "Avvio elaborazione...";

  var formData = new FormData();
  formData.append("file", normSelectedFile);
  formData.append("nome_legge", nomeLegge);
  formData.append("titolo_esteso",
    document.getElementById("norm-titolo-esteso").value.trim());
  formData.append("data_inizio_validita",
    document.getElementById("norm-data-inizio").value);
  formData.append("data_fine_validita",
    document.getElementById("norm-data-fine").value);

  try {
    var resp = await fetch("/normativa/upload", {
      method: "POST",
      body: formData,
    });
    if (!resp.ok) throw new Error(await resp.text());
    var doc = await resp.json();
    currentNormId = doc.id;
    addNormToSidebar(doc);
    highlightNormItem(doc.id);

    // Reset
    normSelectedFile = null;
    normFileInput.value = "";
    normFileInfo.classList.add("hidden");
    normMetaForm.classList.add("hidden");
    document.getElementById("norm-nome-legge").value = "";
    document.getElementById("norm-titolo-esteso").value = "";
    document.getElementById("norm-data-inizio").value = "";
    document.getElementById("norm-data-fine").value = "";

    startPolling(doc.id);
  } catch (e) {
    document.getElementById("norm-error-message").textContent = e.message;
    showNormSection("error");
  }
}

// ── Polling ─────────────────────────────────────────────────────
function startPolling(docId) {
  stopPolling();
  pollTimer = setInterval(function () { pollStatus(docId); }, 3000);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function pollStatus(docId) {
  try {
    var resp = await fetch("/normativa/documents/" + docId + "/status");
    if (!resp.ok) return;
    var data = await resp.json();

    document.getElementById("norm-progress-text").textContent =
      data.progress || "Elaborazione...";

    if (data.status === "done") {
      stopPolling();
      updateNormSidebarItem(docId, data);
      if (typeof loadNormDocPanel === "function") loadNormDocPanel();
      await loadNormDetail(docId);
    } else if (data.status === "error") {
      stopPolling();
      document.getElementById("norm-error-message").textContent =
        data.error || "Errore sconosciuto";
      showNormSection("error");
    }
  } catch (e) {
    // ignore transient network errors
  }
}

// ── Sidebar: norm list ──────────────────────────────────────────
function addNormToSidebar(doc) {
  var item = document.createElement("button");
  item.className = "norm-item";
  item.dataset.id = doc.id;
  var label = (doc.metadata && doc.metadata.nome_legge) || doc.filename;
  item.innerHTML =
    '<div class="font-medium text-sm truncate">' + escapeHtmlNorm(label) + '</div>' +
    '<div class="text-xs text-gray-400 norm-item-status">' + statusLabel(doc.status) + '</div>';
  item.addEventListener("click", function () {
    loadNormDocument(this.dataset.id);
  });
  normList.prepend(item);
}

function highlightNormItem(id) {
  normList.querySelectorAll(".norm-item").forEach(function (el) {
    el.classList.toggle("active", el.dataset.id === id);
  });
}

function updateNormSidebarItem(docId, data) {
  var item = normList.querySelector('[data-id="' + docId + '"]');
  if (!item) return;
  var statusEl = item.querySelector(".norm-item-status");
  if (statusEl) {
    statusEl.textContent =
      data.status === "done"
        ? data.chunk_count + " chunk"
        : statusLabel(data.status);
  }
}

function statusLabel(status) {
  if (status === "processing") return "In elaborazione...";
  if (status === "done") return "Completato";
  if (status === "error") return "Errore";
  return status;
}

async function loadNormDocument(docId) {
  if (docId === currentNormId && !normSections.processing.classList.contains("hidden")) return;
  currentNormId = docId;
  highlightNormItem(docId);
  switchSidebarTab("norm-upload");

  try {
    var resp = await fetch("/normativa/documents/" + docId);
    if (!resp.ok) throw new Error("Documento non trovato");
    var doc = await resp.json();

    if (doc.status === "processing") {
      showNormSection("processing");
      document.getElementById("norm-progress-text").textContent =
        doc.progress || "Elaborazione...";
      startPolling(docId);
    } else if (doc.status === "error") {
      document.getElementById("norm-error-message").textContent =
        doc.error || "Errore sconosciuto";
      showNormSection("error");
    } else {
      renderNormDetail(doc);
    }
  } catch (e) {
    document.getElementById("norm-error-message").textContent = e.message;
    showNormSection("error");
  }
}

async function loadNormDetail(docId) {
  try {
    var resp = await fetch("/normativa/documents/" + docId);
    if (!resp.ok) throw new Error("Documento non trovato");
    var doc = await resp.json();
    renderNormDetail(doc);
  } catch (e) {
    document.getElementById("norm-error-message").textContent = e.message;
    showNormSection("error");
  }
}

// ── Render norm detail ──────────────────────────────────────────
function renderNormDetail(doc) {
  var meta = doc.metadata || {};

  document.getElementById("norm-detail-title").textContent =
    meta.nome_legge || doc.filename;

  var html = '<div class="space-y-4">';

  html += '<div class="grid grid-cols-1 md:grid-cols-2 gap-4">';
  html += normField("Nome breve", meta.nome_legge);
  html += normField("Titolo esteso", meta.titolo_esteso);
  html += normField("File", doc.filename);
  html += normField("Inizio validita", meta.data_inizio_validita);
  html += normField("Fine validita", meta.data_fine_validita || "Ancora in vigore");
  html += normField("Chunk totali", doc.chunk_count > 0 ? String(doc.chunk_count) : null);
  html += normField("Caricato il", formatNormTimestamp(doc.uploaded_at));
  html += "</div>";

  // Action buttons
  html += '<div class="mt-6 pt-4 border-t flex gap-4">' +
    '<button onclick="editNormDetail(\'' + doc.id + '\')"' +
    ' class="text-indigo-600 text-sm hover:text-indigo-800 transition-colors">' +
    'Modifica metadati</button>' +
    '<button onclick="deleteNorm(\'' + doc.id + '\')"' +
    ' class="text-red-500 text-sm hover:text-red-700 transition-colors">' +
    'Elimina documento</button></div>';

  html += "</div>";
  document.getElementById("norm-detail-body").innerHTML = html;
  showNormSection("detail");
}

function normField(label, val) {
  var display = val
    ? escapeHtmlNorm(val)
    : '<span class="text-gray-300">&mdash;</span>';
  return '<div><div class="field-label">' + escapeHtmlNorm(label) +
    '</div><div class="field-value">' + display + '</div></div>';
}

function formatNormTimestamp(ts) {
  var d = new Date(ts);
  return d.toLocaleString("it-IT", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

// ── Edit norm from detail view ───────────────────────────────
function editNormDetail(docId) {
  fetch("/normativa/documents/" + docId)
    .then(function (r) { return r.json(); })
    .then(function (doc) {
      var meta = doc.metadata || {};
      var body = document.getElementById("norm-detail-body");
      var html = '<div class="space-y-3">' +
        '<div class="grid grid-cols-1 md:grid-cols-2 gap-3">' +
          '<div>' +
            '<label class="field-label">Nome breve</label>' +
            '<input id="detail-edit-nome" type="text" value="' + escapeAttr(meta.nome_legge) + '"' +
            ' class="mt-1 block w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />' +
          '</div>' +
          '<div>' +
            '<label class="field-label">Titolo esteso</label>' +
            '<input id="detail-edit-titolo" type="text" value="' + escapeAttr(meta.titolo_esteso) + '"' +
            ' class="mt-1 block w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />' +
          '</div>' +
          '<div>' +
            '<label class="field-label">Data inizio validita</label>' +
            '<input id="detail-edit-inizio" type="date" value="' + escapeAttr(meta.data_inizio_validita) + '"' +
            ' class="mt-1 block w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />' +
          '</div>' +
          '<div>' +
            '<label class="field-label">Data fine validita</label>' +
            '<input id="detail-edit-fine" type="date" value="' + escapeAttr(meta.data_fine_validita) + '"' +
            ' class="mt-1 block w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />' +
            '<p class="text-xs text-gray-400 mt-1">Lascia vuoto se ancora in vigore</p>' +
          '</div>' +
        '</div>' +
        '<div class="flex gap-2 pt-2">' +
          '<button onclick="saveNormDetail(\'' + docId + '\')"' +
          ' class="bg-indigo-600 text-white px-4 py-1.5 rounded-lg text-sm font-medium hover:bg-indigo-700 transition-colors">' +
          'Salva</button>' +
          '<button onclick="loadNormDetail(\'' + docId + '\')"' +
          ' class="bg-gray-100 text-gray-700 px-4 py-1.5 rounded-lg text-sm font-medium hover:bg-gray-200 transition-colors">' +
          'Annulla</button>' +
        '</div>' +
      '</div>';
      body.innerHTML = html;
    });
}

async function saveNormDetail(docId) {
  var body = {
    nome_legge: document.getElementById("detail-edit-nome").value.trim(),
    titolo_esteso: document.getElementById("detail-edit-titolo").value.trim(),
    data_inizio_validita: document.getElementById("detail-edit-inizio").value || null,
    data_fine_validita: document.getElementById("detail-edit-fine").value || null,
  };
  if (!body.nome_legge) {
    alert("Il nome breve è obbligatorio");
    return;
  }
  try {
    var resp = await fetch("/normativa/documents/" + docId + "/metadata", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(await resp.text());

    // Update sidebar label
    var item = normList.querySelector('[data-id="' + docId + '"]');
    if (item) {
      var labelEl = item.querySelector(".font-medium");
      if (labelEl) labelEl.textContent = body.nome_legge;
    }
    // Update detail title and reload detail view
    document.getElementById("norm-detail-title").textContent = body.nome_legge;
    await loadNormDetail(docId);
  } catch (e) {
    alert("Errore: " + e.message);
  }
}

// ── Delete norm ─────────────────────────────────────────────────
async function deleteNorm(docId) {
  if (!confirm("Eliminare questo documento e tutti i suoi chunk?")) return;
  try {
    await fetch("/normativa/documents/" + docId, { method: "DELETE" });
    var item = normList.querySelector('[data-id="' + docId + '"]');
    if (item) item.remove();
    if (currentNormId === docId) {
      currentNormId = null;
      showNormSection("upload");
    }
  } catch (e) {
    alert("Errore: " + e.message);
  }
}

// ── Load existing norms on startup ──────────────────────────────
async function loadNormSidebar() {
  try {
    var resp = await fetch("/normativa/documents");
    var list = await resp.json();
    list.reverse().forEach(function (doc) {
      addNormToSidebar(doc);
      updateNormSidebarItem(doc.id, doc);
    });
  } catch (e) {
    /* ignore on first load */
  }
}
loadNormSidebar();

// ── Document management panel ────────────────────────────────

var _normDocCache = {};

async function loadNormDocPanel() {
  var tbody = document.getElementById("norm-doc-tbody");
  var emptyMsg = document.getElementById("norm-doc-empty");
  try {
    var resp = await fetch("/normativa/documents");
    var docs = await resp.json();

    if (!docs.length) {
      tbody.innerHTML = "";
      emptyMsg.classList.remove("hidden");
      return;
    }
    emptyMsg.classList.add("hidden");

    var html = "";
    for (var i = 0; i < docs.length; i++) {
      var d = docs[i];
      var name = d.nome_legge || d.filename;
      var chunks = d.chunk_count || 0;
      var chars = d.total_chars || 0;
      var charsLabel = chars > 0 ? formatChars(chars) : "\u2014";
      var statusHtml = "";
      if (d.status === "done") {
        statusHtml = '<span class="text-green-600 font-medium">OK</span>';
      } else if (d.status === "processing") {
        statusHtml = '<span class="text-yellow-600 font-medium">In corso...</span>';
      } else {
        statusHtml = '<span class="text-red-500 font-medium">Errore</span>';
      }

      var pagesLabel = (d.page_min != null && d.page_max != null)
        ? (d.page_min === d.page_max ? String(d.page_min) : d.page_min + "-" + d.page_max)
        : "\u2014";

      // Store doc data for edit form
      _normDocCache[d.id] = d;

      html += '<tr class="border-b hover:bg-gray-50">' +
        '<td class="py-2 px-2 truncate max-w-xs">' + escapeHtmlNorm(name) + '</td>' +
        '<td class="py-2 px-2 text-center text-gray-600">' + chunks + '</td>' +
        '<td class="py-2 px-2 text-center text-gray-600">' + pagesLabel + '</td>' +
        '<td class="py-2 px-2 text-center text-gray-600">' + charsLabel + '</td>' +
        '<td class="py-2 px-2 text-center">' + statusHtml + '</td>' +
        '<td class="py-2 px-2 text-right whitespace-nowrap">' +
          '<button onclick="editNormFromPanel(\'' + d.id + '\')" ' +
          'class="text-indigo-500 hover:text-indigo-700 text-xs transition-colors mr-2">' +
          'Modifica</button>' +
          '<button onclick="deleteNormFromPanel(\'' + d.id + '\')" ' +
          'class="text-red-400 hover:text-red-600 text-xs transition-colors">' +
          'Elimina</button>' +
        '</td>' +
        '</tr>';
    }
    tbody.innerHTML = html;
  } catch (e) { /* ignore */ }
}

function formatChars(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return String(n);
}

async function deleteNormFromPanel(docId) {
  if (!confirm("Eliminare questo documento e tutti i suoi chunk?")) return;
  try {
    await fetch("/normativa/documents/" + docId, { method: "DELETE" });
    var item = normList.querySelector('[data-id="' + docId + '"]');
    if (item) item.remove();
    if (currentNormId === docId) {
      currentNormId = null;
      showNormSection("upload");
    }
    loadNormDocPanel();
  } catch (e) {
    alert("Errore: " + e.message);
  }
}

// ── Edit metadata ────────────────────────────────────────────

function editNormFromPanel(docId) {
  var d = _normDocCache[docId];
  if (!d) return;

  // Build inline edit form replacing the table
  var container = document.getElementById("norm-doc-table-container");
  var nome = d.nome_legge || "";
  var titolo = d.titolo_esteso || "";
  var dataInizio = d.data_inizio_validita || "";
  var dataFine = d.data_fine_validita || "";

  // Fetch full doc detail for titolo_esteso (list endpoint may not have it)
  fetch("/normativa/documents/" + docId)
    .then(function (r) { return r.json(); })
    .then(function (doc) {
      var meta = doc.metadata || {};
      renderEditForm(container, docId, meta.nome_legge || nome,
        meta.titolo_esteso || titolo,
        meta.data_inizio_validita || dataInizio,
        meta.data_fine_validita || dataFine);
    })
    .catch(function () {
      renderEditForm(container, docId, nome, titolo, dataInizio, dataFine);
    });
}

function renderEditForm(container, docId, nome, titolo, dataInizio, dataFine) {
  container.innerHTML =
    '<div class="space-y-3 py-2">' +
      '<div class="grid grid-cols-1 md:grid-cols-2 gap-3">' +
        '<div>' +
          '<label class="field-label">Nome breve</label>' +
          '<input id="edit-nome-legge" type="text" value="' + escapeAttr(nome) + '"' +
          ' class="mt-1 block w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />' +
        '</div>' +
        '<div>' +
          '<label class="field-label">Titolo esteso</label>' +
          '<input id="edit-titolo-esteso" type="text" value="' + escapeAttr(titolo) + '"' +
          ' class="mt-1 block w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />' +
        '</div>' +
        '<div>' +
          '<label class="field-label">Data inizio validita</label>' +
          '<input id="edit-data-inizio" type="date" value="' + escapeAttr(dataInizio) + '"' +
          ' class="mt-1 block w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />' +
        '</div>' +
        '<div>' +
          '<label class="field-label">Data fine validita</label>' +
          '<input id="edit-data-fine" type="date" value="' + escapeAttr(dataFine) + '"' +
          ' class="mt-1 block w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />' +
          '<p class="text-xs text-gray-400 mt-1">Lascia vuoto se ancora in vigore</p>' +
        '</div>' +
      '</div>' +
      '<div class="flex gap-2 pt-1">' +
        '<button onclick="saveNormEdit(\'' + docId + '\')"' +
        ' class="bg-indigo-600 text-white px-4 py-1.5 rounded-lg text-sm font-medium hover:bg-indigo-700 transition-colors">' +
        'Salva</button>' +
        '<button onclick="cancelNormEdit()"' +
        ' class="bg-gray-100 text-gray-700 px-4 py-1.5 rounded-lg text-sm font-medium hover:bg-gray-200 transition-colors">' +
        'Annulla</button>' +
      '</div>' +
    '</div>';
}

async function saveNormEdit(docId) {
  var body = {
    nome_legge: document.getElementById("edit-nome-legge").value.trim(),
    titolo_esteso: document.getElementById("edit-titolo-esteso").value.trim(),
    data_inizio_validita: document.getElementById("edit-data-inizio").value || null,
    data_fine_validita: document.getElementById("edit-data-fine").value || null,
  };

  if (!body.nome_legge) {
    alert("Il nome breve è obbligatorio");
    return;
  }

  try {
    var resp = await fetch("/normativa/documents/" + docId + "/metadata", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(await resp.text());

    // Restore table and reload
    cancelNormEdit();

    // Update sidebar item label
    var item = normList.querySelector('[data-id="' + docId + '"]');
    if (item) {
      var labelEl = item.querySelector(".font-medium");
      if (labelEl) labelEl.textContent = body.nome_legge;
    }
  } catch (e) {
    alert("Errore: " + e.message);
  }
}

function cancelNormEdit() {
  // Restore the table structure
  var container = document.getElementById("norm-doc-table-container");
  container.innerHTML =
    '<table class="w-full text-sm" id="norm-doc-table">' +
      '<thead><tr class="border-b text-left text-gray-500">' +
        '<th class="py-2 px-2 font-medium">Nome</th>' +
        '<th class="py-2 px-2 font-medium text-center">Chunks</th>' +
        '<th class="py-2 px-2 font-medium text-center">Pagine</th>' +
        '<th class="py-2 px-2 font-medium text-center">Caratteri</th>' +
        '<th class="py-2 px-2 font-medium text-center">Stato</th>' +
        '<th class="py-2 px-2 font-medium text-right"></th>' +
      '</tr></thead>' +
      '<tbody id="norm-doc-tbody"></tbody>' +
    '</table>' +
    '<p id="norm-doc-empty" class="text-gray-400 text-sm text-center py-4 hidden">Nessun documento caricato.</p>';
  loadNormDocPanel();
}

function escapeAttr(text) {
  return String(text || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

// Load panel on startup and when switching to normativa tab
loadNormDocPanel();

function escapeHtmlNorm(text) {
  var div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}
