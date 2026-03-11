// ── Client Management (Pratiche tab) ─────────────────────────────
// Metadata in localStorage, PDF blobs in-memory (lost on reload).

// ── State ───────────────────────────────────────────────────────
let clients = JSON.parse(localStorage.getItem("fs_clients") || "[]");
let clientDocs = JSON.parse(localStorage.getItem("fs_clientDocs") || "{}");
let clientSchemas = JSON.parse(localStorage.getItem("fs_clientSchemas") || "{}");
let clientEntities = JSON.parse(localStorage.getItem("fs_clientEntities") || "{}");

// In-memory file blob URLs (not persisted across reload)
const pdfBlobUrls = {};  // { docId: blobUrl }

let currentClientId = null;
let currentClientTab = "docs";   // "docs" | "entities"
let currentClientDocId = null;
let currentDocDetailTab = "pdf"; // "pdf" | "analysis"

function saveState() {
  localStorage.setItem("fs_clients", JSON.stringify(clients));
  localStorage.setItem("fs_clientDocs", JSON.stringify(clientDocs));
  localStorage.setItem("fs_clientSchemas", JSON.stringify(clientSchemas));
  localStorage.setItem("fs_clientEntities", JSON.stringify(clientEntities));
}

// ── DOM refs ────────────────────────────────────────────────────
const clientList = document.getElementById("client-list");
const clientSearch = document.getElementById("client-search");
const newClientBtn = document.getElementById("new-client-btn");
const newClientForm = document.getElementById("new-client-form");
const newClientName = document.getElementById("new-client-name");
const saveClientBtn = document.getElementById("save-client-btn");
const cancelClientBtn = document.getElementById("cancel-client-btn");
const clientsCardsGrid = document.getElementById("clients-cards-grid");

// Section refs
const clientsWelcomeSection = document.getElementById("clients-welcome-section");
const clientDocsSection = document.getElementById("client-docs-section");
const clientEntitiesSection = document.getElementById("client-entities-section");
const clientDocDetailSection = document.getElementById("client-doc-detail-section");
const loadingSection = document.getElementById("loading-section");
const errorSection = document.getElementById("error-section");
const errorMessage = document.getElementById("error-message");

// Doc tab refs
const clientNameHeader = document.getElementById("client-name-header");
const clientNameHeaderEntities = document.getElementById("client-name-header-entities");
const clientDocsTbody = document.getElementById("client-docs-tbody");
const clientDocsEmpty = document.getElementById("client-docs-empty");
const clientDocCount = document.getElementById("client-doc-count");
const clientAddDocBtn = document.getElementById("client-add-doc-btn");
const clientUploadArea = document.getElementById("client-upload-area");
const clientDropZone = document.getElementById("client-drop-zone");
const clientFileInput = document.getElementById("client-file-input");
const clientFileInfo = document.getElementById("client-file-info");
const clientFileName = document.getElementById("client-file-name");
const clientDocType = document.getElementById("client-doc-type");
const clientUploadBtn = document.getElementById("client-upload-btn");
const clientUploadCancel = document.getElementById("client-upload-cancel");
const clientBackBtn = document.getElementById("client-back-btn");
const exportBtn = document.getElementById("export-btn");
const retryBtn = document.getElementById("retry-btn");

// Client actions
const clientRenameBtn = document.getElementById("client-rename-btn");
const clientDeleteBtn = document.getElementById("client-delete-btn");
const clientRenameForm = document.getElementById("client-rename-form");
const clientRenameInput = document.getElementById("client-rename-input");
const clientRenameSave = document.getElementById("client-rename-save");
const clientRenameCancel = document.getElementById("client-rename-cancel");

// Entity tab refs
const schemaTbody = document.getElementById("schema-tbody");
const schemaEmpty = document.getElementById("schema-empty");
const addFieldBtn = document.getElementById("add-field-btn");
const addFieldForm = document.getElementById("add-field-form");
const newFieldName = document.getElementById("new-field-name");
const newFieldDesc = document.getElementById("new-field-desc");
const confirmFieldBtn = document.getElementById("confirm-field-btn");
const cancelFieldBtn = document.getElementById("cancel-field-btn");
const extractEntitiesBtn = document.getElementById("extract-entities-btn");
const entitiesResultsTbody = document.getElementById("entities-results-tbody");
const entitiesResultsEmpty = document.getElementById("entities-results-empty");
const extractDocList = document.getElementById("extract-doc-list");
const extractDocEmpty = document.getElementById("extract-doc-empty");
const selectAllDocsBtn = document.getElementById("select-all-docs-btn");

// Doc detail refs
const docFileView = document.getElementById("doc-file-view");
const docFileActions = document.getElementById("doc-file-actions");
const docOpenNewtabBtn = document.getElementById("doc-open-newtab-btn");
const docDownloadLink = document.getElementById("doc-download-link");
const docPdfContainer = document.getElementById("doc-pdf-container");
const docPdfIframe = document.getElementById("doc-pdf-iframe");
const docImgContainer = document.getElementById("doc-img-container");
const docImgViewer = document.getElementById("doc-img-viewer");
const docFileUnavailable = document.getElementById("doc-file-unavailable");
const docAnalysisView = document.getElementById("doc-analysis-view");

let selectedClientFile = null;

// ── All pratiche sections ───────────────────────────────────────
const allClientiSections = [
  clientsWelcomeSection, clientDocsSection, clientEntitiesSection,
  clientDocDetailSection, loadingSection, errorSection
];

function hideAllClientiSections() {
  allClientiSections.forEach(function (s) { if (s) s.classList.add("hidden"); });
}

// Called by switchSidebarTab when "pratiche" is selected
function showClientiView() {
  hideAllClientiSections();
  if (currentClientDocId) {
    clientDocDetailSection.classList.remove("hidden");
  } else if (currentClientId) {
    if (currentClientTab === "entities") {
      clientEntitiesSection.classList.remove("hidden");
    } else {
      clientDocsSection.classList.remove("hidden");
    }
  } else {
    clientsWelcomeSection.classList.remove("hidden");
    renderWelcomeCards();
  }
}
window.showClientiView = showClientiView;

// ── Sidebar: client list ────────────────────────────────────────
function renderClientList(filter) {
  clientList.innerHTML = "";
  var q = (filter || "").toLowerCase();
  var filtered = clients.filter(function (c) {
    return !q || c.ragione_sociale.toLowerCase().includes(q);
  });

  filtered.forEach(function (c) {
    var docs = clientDocs[c.id] || [];
    var btn = document.createElement("button");
    btn.className = "client-item" + (c.id === currentClientId ? " active" : "");
    btn.dataset.id = c.id;
    btn.innerHTML =
      '<div class="flex-1 min-w-0">' +
        '<div class="font-medium text-sm truncate">' + escapeHtml(c.ragione_sociale) + '</div>' +
      '</div>' +
      '<span class="client-item-count">' + docs.length + '</span>';
    btn.addEventListener("click", function () { selectClient(c.id); });
    clientList.appendChild(btn);
  });
}

function highlightClientItem(id) {
  clientList.querySelectorAll(".client-item").forEach(function (el) {
    el.classList.toggle("active", el.dataset.id === id);
  });
}

// ── Welcome cards ───────────────────────────────────────────────
function renderWelcomeCards() {
  clientsCardsGrid.innerHTML = "";
  if (!clients.length) return;
  clients.forEach(function (c) {
    var docs = clientDocs[c.id] || [];
    var card = document.createElement("div");
    card.className = "client-card";
    card.innerHTML =
      '<div class="client-card-name">' + escapeHtml(c.ragione_sociale) + '</div>' +
      '<div class="client-card-meta">' + docs.length + ' document' + (docs.length !== 1 ? 'i' : 'o') +
      ' &middot; creato ' + formatDate(c.created_at) + '</div>';
    card.addEventListener("click", function () { selectClient(c.id); });
    clientsCardsGrid.appendChild(card);
  });
}

// ── Create new client ───────────────────────────────────────────
newClientBtn.addEventListener("click", function () {
  newClientForm.classList.remove("hidden");
  newClientName.value = "";
  newClientName.focus();
});
cancelClientBtn.addEventListener("click", function () { newClientForm.classList.add("hidden"); });
saveClientBtn.addEventListener("click", createClient);
newClientName.addEventListener("keydown", function (e) { if (e.key === "Enter") createClient(); });

function createClient() {
  var name = newClientName.value.trim();
  if (!name) return;
  var client = {
    id: "cli_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
    ragione_sociale: name,
    created_at: new Date().toISOString()
  };
  clients.push(client);
  clientDocs[client.id] = [];
  clientSchemas[client.id] = [];
  clientEntities[client.id] = [];
  saveState();
  newClientForm.classList.add("hidden");
  renderClientList();
  selectClient(client.id);
}

// ── Search ──────────────────────────────────────────────────────
clientSearch.addEventListener("input", function () { renderClientList(this.value); });

// ── Select client ───────────────────────────────────────────────
function selectClient(clientId) {
  currentClientId = clientId;
  currentClientDocId = null;
  currentClientTab = "docs";
  highlightClientItem(clientId);
  showClientDocs();
}

// ── Rename client ───────────────────────────────────────────────
clientRenameBtn.addEventListener("click", function () {
  var client = clients.find(function (c) { return c.id === currentClientId; });
  if (!client) return;
  clientRenameInput.value = client.ragione_sociale;
  clientRenameForm.classList.remove("hidden");
  clientNameHeader.classList.add("hidden");
  clientRenameBtn.classList.add("hidden");
  clientDeleteBtn.classList.add("hidden");
  clientRenameInput.focus();
});

clientRenameCancel.addEventListener("click", cancelRename);
function cancelRename() {
  clientRenameForm.classList.add("hidden");
  clientNameHeader.classList.remove("hidden");
  clientRenameBtn.classList.remove("hidden");
  clientDeleteBtn.classList.remove("hidden");
}

clientRenameSave.addEventListener("click", doRename);
clientRenameInput.addEventListener("keydown", function (e) { if (e.key === "Enter") doRename(); if (e.key === "Escape") cancelRename(); });

function doRename() {
  var newName = clientRenameInput.value.trim();
  if (!newName) return;
  var client = clients.find(function (c) { return c.id === currentClientId; });
  if (client) {
    client.ragione_sociale = newName;
    saveState();
    clientNameHeader.textContent = newName;
    renderClientList(clientSearch.value);
  }
  cancelRename();
}

// ── Delete client ───────────────────────────────────────────────
clientDeleteBtn.addEventListener("click", function () {
  var client = clients.find(function (c) { return c.id === currentClientId; });
  if (!client) return;
  if (!confirm('Eliminare il cliente "' + client.ragione_sociale + '" e tutti i suoi documenti?')) return;
  clients = clients.filter(function (c) { return c.id !== currentClientId; });
  delete clientDocs[currentClientId];
  delete clientSchemas[currentClientId];
  delete clientEntities[currentClientId];
  saveState();
  currentClientId = null;
  currentClientDocId = null;
  renderClientList();
  hideAllClientiSections();
  clientsWelcomeSection.classList.remove("hidden");
  renderWelcomeCards();
});

// ── Back to clients list ────────────────────────────────────────
clientBackBtn.addEventListener("click", backToClients);
document.querySelector(".client-back-btn-entity").addEventListener("click", backToClients);

function backToClients() {
  currentClientId = null;
  currentClientDocId = null;
  highlightClientItem(null);
  hideAllClientiSections();
  clientsWelcomeSection.classList.remove("hidden");
  renderWelcomeCards();
}

// ── Sub-tab switching ───────────────────────────────────────────
document.querySelectorAll(".client-subtab").forEach(function (tab) {
  tab.addEventListener("click", function () {
    var subtab = this.dataset.subtab;
    if (subtab === "docs") { currentClientTab = "docs"; showClientDocs(); }
    else if (subtab === "entities") { currentClientTab = "entities"; showClientEntities(); }
  });
});

// ── Show client documents ───────────────────────────────────────
function showClientDocs() {
  hideAllClientiSections();
  clientDocsSection.classList.remove("hidden");
  clientUploadArea.classList.add("hidden");
  cancelRename();

  var client = clients.find(function (c) { return c.id === currentClientId; });
  if (!client) return;

  clientNameHeader.textContent = client.ragione_sociale;
  clientDocsSection.querySelectorAll(".client-subtab").forEach(function (t) {
    t.classList.toggle("active", t.dataset.subtab === "docs");
  });
  renderDocTable();
}

function renderDocTable() {
  var docs = clientDocs[currentClientId] || [];
  clientDocsTbody.innerHTML = "";
  clientDocsEmpty.classList.toggle("hidden", docs.length > 0);
  document.getElementById("client-docs-table").classList.toggle("hidden", docs.length === 0);
  clientDocCount.textContent = docs.length + " document" + (docs.length !== 1 ? "i" : "o");

  docs.forEach(function (doc) {
    var tr = document.createElement("tr");
    tr.className = "border-b border-gray-100 hover:bg-gray-50 cursor-pointer";

    var typeBadge = doc.type === "antincendio"
      ? '<span class="badge badge-antincendio">Antincendio</span>'
      : '<span class="badge badge-altro">Altro</span>';

    var statusHtml = doc.status === "done"
      ? '<span class="v-icon v-ok">&#10003;</span> OK'
      : doc.status === "error"
        ? '<span class="v-icon v-err">&#10007;</span> Errore'
        : '<span class="text-gray-400">&#9203;</span> Caricato';

    var pdfIcon = pdfBlobUrls[doc.id]
      ? '<span class="text-green-600 text-xs" title="File disponibile">&#128196;</span> '
      : '';

    tr.innerHTML =
      '<td class="py-3 px-4 font-medium">' + pdfIcon + escapeHtml(doc.filename) + '</td>' +
      '<td class="py-3 px-4">' + typeBadge + '</td>' +
      '<td class="py-3 px-4 text-gray-500 text-xs">' + formatDate(doc.timestamp) + '</td>' +
      '<td class="py-3 px-4 text-center text-sm">' + statusHtml + '</td>' +
      '<td class="py-3 px-4 text-right">' +
        '<button class="text-red-600 hover:text-red-800 text-xs font-medium doc-view-btn">Visualizza</button>' +
        ' <button class="text-gray-400 hover:text-red-600 text-xs ml-2 doc-delete-btn">Elimina</button>' +
      '</td>';

    tr.addEventListener("click", function (e) {
      if (e.target.classList.contains("doc-delete-btn")) return;
      viewDocument(doc.id);
    });

    tr.querySelector(".doc-delete-btn").addEventListener("click", function (e) {
      e.stopPropagation();
      if (!confirm("Eliminare " + doc.filename + "?")) return;
      // Revoke blob URL if exists
      if (pdfBlobUrls[doc.id]) { URL.revokeObjectURL(pdfBlobUrls[doc.id]); delete pdfBlobUrls[doc.id]; }
      clientDocs[currentClientId] = clientDocs[currentClientId].filter(function (d) { return d.id !== doc.id; });
      saveState();
      renderDocTable();
      renderClientList(clientSearch.value);
    });

    clientDocsTbody.appendChild(tr);
  });
}

// ── Upload document ─────────────────────────────────────────────
clientAddDocBtn.addEventListener("click", function () {
  clientUploadArea.classList.remove("hidden");
  selectedClientFile = null;
  clientFileInfo.classList.add("hidden");
  clientFileInput.value = "";
});
clientUploadCancel.addEventListener("click", function () { clientUploadArea.classList.add("hidden"); });

clientDropZone.addEventListener("click", function () { clientFileInput.click(); });
clientDropZone.addEventListener("dragover", function (e) { e.preventDefault(); clientDropZone.classList.add("drag-over"); });
clientDropZone.addEventListener("dragleave", function () { clientDropZone.classList.remove("drag-over"); });
clientDropZone.addEventListener("drop", function (e) {
  e.preventDefault();
  clientDropZone.classList.remove("drag-over");
  if (e.dataTransfer.files.length) selectClientFile(e.dataTransfer.files[0]);
});
clientFileInput.addEventListener("change", function () {
  if (clientFileInput.files.length) selectClientFile(clientFileInput.files[0]);
});

function selectClientFile(file) {
  var ext = file.name.toLowerCase().split(".").pop();
  var allowed = ["pdf", "jpg", "jpeg", "png"];
  if (allowed.indexOf(ext) === -1) { alert("Formati supportati: PDF, JPEG, PNG"); return; }
  selectedClientFile = file;
  clientFileName.textContent = file.name;
  clientFileInfo.classList.remove("hidden");
}

clientUploadBtn.addEventListener("click", uploadClientDoc);

async function uploadClientDoc() {
  if (!selectedClientFile || !currentClientId) return;
  var docType = clientDocType.value;

  // Store file blob URL directly from File object (preserves MIME type)
  var fileMime = selectedClientFile.type || "application/octet-stream";
  var fileBlobUrl = URL.createObjectURL(selectedClientFile);

  if (docType === "antincendio") {
    hideAllClientiSections();
    loadingSection.classList.remove("hidden");

    var formData = new FormData();
    formData.append("file", selectedClientFile);

    try {
      var resp = await fetch("/analyze", { method: "POST", body: formData });
      if (!resp.ok) { var err = await resp.text(); throw new Error(err || resp.statusText); }
      var entry = await resp.json();
      var doc = {
        id: entry.id,
        filename: entry.filename,
        type: "antincendio",
        mime: fileMime,
        timestamp: entry.timestamp,
        status: "done",
        result: entry.result
      };
      clientDocs[currentClientId].push(doc);
      pdfBlobUrls[doc.id] = fileBlobUrl;
      saveState();
      selectedClientFile = null;
      clientFileInput.value = "";
      clientFileInfo.classList.add("hidden");
      viewDocument(doc.id);
      renderClientList(clientSearch.value);
    } catch (e) {
      URL.revokeObjectURL(fileBlobUrl);
      hideAllClientiSections();
      errorMessage.textContent = e.message;
      errorSection.classList.remove("hidden");
    }
  } else {
    var doc = {
      id: "doc_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
      filename: selectedClientFile.name,
      type: "altro",
      mime: fileMime,
      timestamp: new Date().toISOString(),
      status: "done",
      result: null
    };
    clientDocs[currentClientId].push(doc);
    pdfBlobUrls[doc.id] = fileBlobUrl;
    saveState();
    selectedClientFile = null;
    clientFileInput.value = "";
    clientUploadArea.classList.add("hidden");
    clientFileInfo.classList.add("hidden");
    renderDocTable();
    renderClientList(clientSearch.value);
    showUploadSuccess(doc.filename);
  }
}

// ── Upload success notification ──────────────────────────────
function showUploadSuccess(filename) {
  var toast = document.createElement("div");
  toast.className = "upload-success-toast";
  toast.innerHTML = '<span class="v-icon v-ok">&#10003;</span> <strong>' + escapeHtml(filename) + '</strong> caricato con successo';
  var mainArea = clientDocsSection || document.body;
  mainArea.insertBefore(toast, mainArea.firstChild);
  setTimeout(function () {
    toast.classList.add("fade-out");
    setTimeout(function () { toast.remove(); }, 400);
  }, 3000);
}

// ── View document ───────────────────────────────────────────────
function viewDocument(docId) {
  var docs = clientDocs[currentClientId] || [];
  var doc = docs.find(function (d) { return d.id === docId; });
  if (!doc) return;

  currentClientDocId = docId;
  hideAllClientiSections();
  clientDocDetailSection.classList.remove("hidden");

  var client = clients.find(function (c) { return c.id === currentClientId; });
  document.getElementById("doc-detail-breadcrumb").textContent =
    (client ? client.ragione_sociale : "") + " > " + doc.filename;

  // Setup file view (PDF or image)
  var blobUrl = pdfBlobUrls[docId];
  var hasFile = !!blobUrl;
  var mime = doc.mime || "";
  // Infer MIME from filename if not stored (older docs)
  if (!mime) {
    var ext = (doc.filename || "").toLowerCase().split(".").pop();
    if (ext === "jpg" || ext === "jpeg") mime = "image/jpeg";
    else if (ext === "png") mime = "image/png";
    else mime = "application/pdf";
  }
  var isImage = mime.startsWith("image/");
  var isPdf = mime === "application/pdf" || (!mime && doc.filename.toLowerCase().endsWith(".pdf"));

  // Reset all file view containers
  docPdfContainer.classList.add("hidden");
  docImgContainer.classList.add("hidden");
  docFileUnavailable.classList.add("hidden");
  docFileActions.classList.add("hidden");
  docPdfIframe.src = "";
  docImgViewer.src = "";

  if (hasFile) {
    docFileActions.classList.remove("hidden");
    docDownloadLink.href = blobUrl;
    docDownloadLink.download = doc.filename;
    docOpenNewtabBtn.onclick = function () { window.open(blobUrl, "_blank"); };

    if (isImage) {
      docImgContainer.classList.remove("hidden");
      docImgViewer.src = blobUrl;
      docImgViewer.alt = doc.filename;
    } else {
      docPdfContainer.classList.remove("hidden");
      docPdfIframe.src = blobUrl;
    }
  } else {
    docFileUnavailable.classList.remove("hidden");
  }

  // Setup analysis view
  var hasAnalysis = doc.type === "antincendio" && doc.result;
  if (hasAnalysis) {
    renderResults(doc.result);
  } else {
    document.getElementById("header-grid").innerHTML =
      '<div class="md:col-span-2 text-center py-8 text-gray-400">' +
        '<p class="text-sm">Nessuna analisi disponibile per questo documento.</p>' +
      '</div>';
    document.getElementById("building-tabs").innerHTML = "";
    document.getElementById("building-content").innerHTML = "";
  }

  // Show/hide analysis tab based on type
  var analysisTabs = clientDocDetailSection.querySelectorAll(".doc-detail-tab");
  analysisTabs.forEach(function (t) {
    if (t.dataset.doctab === "analysis") {
      t.classList.toggle("hidden", !hasAnalysis);
    }
  });

  // Default to PDF tab if available, otherwise analysis
  if (hasPdf) {
    switchDocDetailTab("pdf");
  } else if (hasAnalysis) {
    switchDocDetailTab("analysis");
  } else {
    switchDocDetailTab("pdf");
  }

  // Export button only for antincendio
  exportBtn.classList.toggle("hidden", !hasAnalysis);
}

// ── Doc detail tab switching ────────────────────────────────────
clientDocDetailSection.querySelectorAll(".doc-detail-tab").forEach(function (tab) {
  tab.addEventListener("click", function () {
    switchDocDetailTab(this.dataset.doctab);
  });
});

function switchDocDetailTab(tab) {
  currentDocDetailTab = tab;
  clientDocDetailSection.querySelectorAll(".doc-detail-tab").forEach(function (t) {
    t.classList.toggle("active", t.dataset.doctab === tab);
  });
  docFileView.classList.toggle("hidden", tab !== "pdf");
  docAnalysisView.classList.toggle("hidden", tab !== "analysis");
}

// Back from doc detail
document.getElementById("doc-detail-back-btn").addEventListener("click", function () {
  docPdfIframe.src = ""; // stop PDF rendering
  docImgViewer.src = "";
  currentClientDocId = null;
  showClientDocs();
});

// Retry
retryBtn.addEventListener("click", function () {
  if (currentClientId) showClientDocs();
  else { hideAllClientiSections(); clientsWelcomeSection.classList.remove("hidden"); }
});

// Export
exportBtn.addEventListener("click", function () {
  if (!currentClientDocId) return;
  window.open("/analyses/" + currentClientDocId + "/export", "_blank");
});

// ── Show client entities (extraction tab) ───────────────────────
function showClientEntities() {
  hideAllClientiSections();
  clientEntitiesSection.classList.remove("hidden");

  var client = clients.find(function (c) { return c.id === currentClientId; });
  if (!client) return;

  clientNameHeaderEntities.textContent = client.ragione_sociale;
  clientEntitiesSection.querySelectorAll(".client-subtab").forEach(function (t) {
    t.classList.toggle("active", t.dataset.subtab === "entities");
  });

  renderExtractDocList();
  renderSchema();
  renderEntitiesResults();
}

// ── Extract document list (checkboxes) ──────────────────────────
let selectedExtractDocs = new Set();

function renderExtractDocList() {
  var docs = clientDocs[currentClientId] || [];
  extractDocList.innerHTML = "";
  extractDocEmpty.classList.toggle("hidden", docs.length > 0);

  docs.forEach(function (doc) {
    var isSelected = selectedExtractDocs.has(doc.id);
    var item = document.createElement("label");
    item.className = "extract-doc-item" + (isSelected ? " selected" : "");
    var typeBadge = doc.type === "antincendio"
      ? '<span class="badge badge-antincendio" style="font-size:0.65rem">Antincendio</span>'
      : '<span class="badge badge-altro" style="font-size:0.65rem">Altro</span>';
    item.innerHTML =
      '<input type="checkbox" class="rounded" ' + (isSelected ? 'checked' : '') + ' />' +
      '<span class="flex-1 text-sm font-medium truncate">' + escapeHtml(doc.filename) + '</span>' +
      typeBadge;
    var cb = item.querySelector("input");
    cb.addEventListener("change", function () {
      if (this.checked) { selectedExtractDocs.add(doc.id); item.classList.add("selected"); }
      else { selectedExtractDocs.delete(doc.id); item.classList.remove("selected"); }
    });
    extractDocList.appendChild(item);
  });
}

selectAllDocsBtn.addEventListener("click", function () {
  var docs = clientDocs[currentClientId] || [];
  var allSelected = docs.length > 0 && docs.every(function (d) { return selectedExtractDocs.has(d.id); });
  if (allSelected) {
    selectedExtractDocs.clear();
    selectAllDocsBtn.textContent = "Seleziona tutti";
  } else {
    docs.forEach(function (d) { selectedExtractDocs.add(d.id); });
    selectAllDocsBtn.textContent = "Deseleziona tutti";
  }
  renderExtractDocList();
});

// ── Schema CRUD ─────────────────────────────────────────────────
function renderSchema() {
  var schema = clientSchemas[currentClientId] || [];
  schemaTbody.innerHTML = "";
  schemaEmpty.classList.toggle("hidden", schema.length > 0);
  document.getElementById("schema-table").classList.toggle("hidden", schema.length === 0);

  schema.forEach(function (field, idx) {
    var tr = document.createElement("tr");
    tr.className = "border-b border-gray-100";
    tr.innerHTML =
      '<td class="py-2 px-3 font-medium schema-cell-editable" data-field="nome">' + escapeHtml(field.nome) + '</td>' +
      '<td class="py-2 px-3 text-gray-600 text-sm schema-cell-editable" data-field="descrizione">' +
        (field.descrizione ? escapeHtml(field.descrizione) : '<span class="text-gray-300">Clicca per aggiungere descrizione</span>') +
      '</td>' +
      '<td class="py-2 px-3 text-center">' +
        '<button class="schema-delete-btn" title="Rimuovi campo">&times;</button>' +
      '</td>';

    // Inline edit on click
    tr.querySelectorAll(".schema-cell-editable").forEach(function (td) {
      td.addEventListener("click", function () {
        if (td.querySelector("input")) return; // already editing
        var fieldKey = td.dataset.field;
        var currentVal = field[fieldKey] || "";
        var input = document.createElement("input");
        input.type = "text";
        input.value = currentVal;
        input.className = "schema-inline-input";
        input.placeholder = fieldKey === "nome" ? "Nome campo" : "Descrizione (opzionale)";
        td.textContent = "";
        td.appendChild(input);
        input.focus();
        input.select();

        function commitEdit() {
          var newVal = input.value.trim();
          if (fieldKey === "nome" && !newVal) {
            newVal = currentVal; // don't allow empty name
          }
          field[fieldKey] = newVal;
          saveState();
          renderSchema();
        }

        input.addEventListener("blur", commitEdit);
        input.addEventListener("keydown", function (e) {
          if (e.key === "Enter") { e.preventDefault(); input.blur(); }
          if (e.key === "Escape") { input.value = currentVal; input.blur(); }
        });
      });
    });

    tr.querySelector(".schema-delete-btn").addEventListener("click", function () {
      clientSchemas[currentClientId].splice(idx, 1);
      saveState();
      renderSchema();
      renderEntitiesResults();
    });
    schemaTbody.appendChild(tr);
  });
}

addFieldBtn.addEventListener("click", function () {
  addFieldForm.classList.remove("hidden");
  newFieldName.value = "";
  newFieldDesc.value = "";
  newFieldName.focus();
});
cancelFieldBtn.addEventListener("click", function () { addFieldForm.classList.add("hidden"); });
confirmFieldBtn.addEventListener("click", addSchemaField);
newFieldName.addEventListener("keydown", function (e) { if (e.key === "Enter") addSchemaField(); });

function addSchemaField() {
  var nome = newFieldName.value.trim();
  var desc = newFieldDesc.value.trim();
  if (!nome) return;
  if (!clientSchemas[currentClientId]) clientSchemas[currentClientId] = [];
  clientSchemas[currentClientId].push({ nome: nome, descrizione: desc });
  saveState();
  addFieldForm.classList.add("hidden");
  renderSchema();
  renderEntitiesResults();
}

// ── Entities results ────────────────────────────────────────────
function renderEntitiesResults() {
  var schema = clientSchemas[currentClientId] || [];
  var entities = clientEntities[currentClientId] || [];
  entitiesResultsTbody.innerHTML = "";
  entitiesResultsEmpty.classList.toggle("hidden", entities.length > 0 || schema.length > 0);
  document.getElementById("entities-results-table").classList.toggle("hidden", entities.length === 0);

  entities.forEach(function (ent) {
    var tr = document.createElement("tr");
    tr.className = "border-b border-gray-100";
    var hasValue = ent.valore != null;
    tr.innerHTML =
      '<td class="py-2 px-3 font-medium">' + escapeHtml(ent.campo) + '</td>' +
      '<td class="py-2 px-3">' + (hasValue ? escapeHtml(ent.valore) : '<span class="text-gray-300">Non trovato</span>') + '</td>' +
      '<td class="py-2 px-3 text-gray-500 text-xs">' + (ent.fonte ? escapeHtml(ent.fonte) : '<span class="text-gray-300">&mdash;</span>') + '</td>';
    entitiesResultsTbody.appendChild(tr);
  });
}

extractEntitiesBtn.addEventListener("click", async function () {
  var schema = clientSchemas[currentClientId] || [];
  if (!schema.length) { alert("Definisci almeno un campo nello schema di estrazione."); return; }
  if (!selectedExtractDocs.size) { alert("Seleziona almeno un documento da cui estrarre."); return; }

  // Check that all selected docs have blob URLs available
  var docs = clientDocs[currentClientId] || [];
  var selectedDocs = docs.filter(function (d) { return selectedExtractDocs.has(d.id); });
  var missingFiles = selectedDocs.filter(function (d) { return !pdfBlobUrls[d.id]; });
  if (missingFiles.length) {
    alert("File non disponibili per: " + missingFiles.map(function (d) { return d.filename; }).join(", ") +
      "\n\nI file vengono persi al ricaricamento della pagina. Ricaricali.");
    return;
  }

  // Show loading state
  extractEntitiesBtn.disabled = true;
  var origText = extractEntitiesBtn.innerHTML;
  extractEntitiesBtn.innerHTML = '<span class="spinner-small"></span> Estrazione in corso...';

  try {
    // Build FormData with schema + files (fetched from blob URLs)
    var formData = new FormData();
    formData.append("schema", JSON.stringify(schema));

    for (var i = 0; i < selectedDocs.length; i++) {
      var doc = selectedDocs[i];
      var blobUrl = pdfBlobUrls[doc.id];
      var resp = await fetch(blobUrl);
      var blob = await resp.blob();
      // Use stored MIME type or infer from filename
      var mime = doc.mime || blob.type || "application/octet-stream";
      var file = new File([blob], doc.filename, { type: mime });
      formData.append("files", file);
    }

    var response = await fetch("/extract-entities", { method: "POST", body: formData });
    if (!response.ok) {
      var errData = await response.text();
      throw new Error(errData || response.statusText);
    }

    var result = await response.json();
    // Save extracted entities
    clientEntities[currentClientId] = result.entities;
    saveState();
    renderEntitiesResults();

  } catch (e) {
    alert("Errore durante l'estrazione: " + e.message);
  } finally {
    extractEntitiesBtn.disabled = false;
    extractEntitiesBtn.innerHTML = origText;
  }
});

// ── Render fire safety analysis results ─────────────────────────
function renderResults(data) {
  renderHeader(data.header);
  renderBuildings(data.buildings);
}

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
  var grid = document.getElementById("header-grid");
  grid.innerHTML = "";
  for (var i = 0; i < HEADER_FIELDS.length; i++) {
    var key = HEADER_FIELDS[i][0], label = HEADER_FIELDS[i][1];
    var val = header[key];
    var div = document.createElement("div");
    div.innerHTML =
      '<div class="field-label">' + label + '</div>' +
      '<div class="field-value">' + (val != null ? val : '<span class="text-gray-300">&mdash;</span>') + '</div>';
    grid.appendChild(div);
  }
  var dprList = header.attivita_dpr || [];
  if (dprList.length) {
    var dprDiv = document.createElement("div");
    dprDiv.className = "md:col-span-2";
    var dprHtml = '<div class="field-label">Attivita DPR 151/11</div><div class="mt-1 space-y-1">';
    for (var j = 0; j < dprList.length; j++) {
      var a = dprList[j];
      dprHtml += '<div class="text-sm"><span class="font-semibold text-red-700">' + a.codice + '</span>' +
        (a.descrizione ? '<span class="text-gray-600"> &mdash; ' + a.descrizione + '</span>' : "") + '</div>';
    }
    dprHtml += "</div>";
    dprDiv.innerHTML = dprHtml;
    grid.appendChild(dprDiv);
  }
}

function renderBuildings(buildings) {
  var tabs = document.getElementById("building-tabs");
  var content = document.getElementById("building-content");
  tabs.innerHTML = "";
  content.innerHTML = "";
  if (!buildings.length) { content.innerHTML = '<p class="text-gray-400">Nessun edificio identificato</p>'; return; }
  buildings.forEach(function (b, i) {
    var tab = document.createElement("button");
    tab.className = "building-tab" + (i === 0 ? " active" : "");
    tab.textContent = b.nome || b.id;
    tab.addEventListener("click", function () {
      tabs.querySelectorAll(".building-tab").forEach(function (t) { t.classList.remove("active"); });
      tab.classList.add("active");
      renderBuildingContent(b, content);
    });
    tabs.appendChild(tab);
  });
  renderBuildingContent(buildings[0], content);
}

function renderBuildingContent(building, container) {
  container.innerHTML = "";
  if (!building.compartments.length) { container.innerHTML = '<p class="text-gray-400">Nessun compartimento</p>'; return; }
  building.compartments.forEach(function (comp) {
    var card = document.createElement("div");
    card.className = "compartment-card mb-3";
    card.innerHTML =
      '<div class="compartment-header" onclick="toggleCompartment(this)">' +
        '<div class="flex items-center gap-3 flex-wrap">' +
          '<span class="font-medium">' + comp.id + ' &mdash; ' + comp.nome + '</span>' +
          riskBadges(comp.risk_profile) +
          (comp.ambito_aperto ? '<span class="badge badge-gray">Aperto</span>' : "") +
        '</div><span class="arrow">&#9654;</span></div>' +
      '<div class="compartment-body">' + compartmentDetails(comp) + '</div>';
    container.appendChild(card);
  });
}

function compartmentDetails(comp) {
  var rp = comp.risk_profile;
  var dash = '<span class="text-gray-300">&mdash;</span>';
  var html = '<div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">';
  html += field("Superficie", comp.superficie_mq != null ? comp.superficie_mq + " mq" : null);
  html += field("Multipiano", comp.multipiano != null ? (comp.multipiano ? "Si" : "No") : null);
  html += field("Ambito aperto", comp.ambito_aperto ? "Si" : "No");
  html += field("Assegnazione", rp ? rp.source : null);
  html += "</div>";

  if (rp) {
    var v = rp.validation || {};
    var icon = validationIcon(v.status);
    var riskRows = [
      ["Rvita", rp.rvita ? rp.rvita + " " + icon : dash, rp.razionale_rvita],
      ["\u03B4occ", rp.delta_occ != null ? rp.delta_occ : dash, rp.razionale_delta_occ],
      ["\u03B4\u03B1", rp.delta_alpha != null ? rp.delta_alpha : dash, rp.razionale_delta_alpha],
      ["qf (MJ/m\u00B2)", rp.carico_incendio_mj_m2 != null ? String(rp.carico_incendio_mj_m2) : dash, rp.razionale_carico_incendio],
      ["Rbeni", rp.rbeni != null ? String(rp.rbeni) : dash, rp.razionale_rbeni],
      ["Rambiente", rp.rambiente != null ? rp.rambiente : dash, rp.razionale_rambiente],
    ];
    html += '<table class="w-full text-sm mb-4"><thead><tr class="text-left text-gray-500 border-b">' +
      '<th class="pb-1 w-32">Parametro</th><th class="pb-1 w-24">Valore</th><th class="pb-1">Razionale</th>' +
      '</tr></thead><tbody>';
    for (var i = 0; i < riskRows.length; i++) {
      html += '<tr class="border-b border-gray-100"><td class="py-2 font-medium text-gray-700">' + riskRows[i][0] +
        '</td><td class="py-2">' + riskRows[i][1] + '</td><td class="py-2 text-gray-600 text-xs leading-relaxed">' +
        (riskRows[i][2] != null ? riskRows[i][2] : dash) + '</td></tr>';
    }
    html += "</tbody></table>";
  }

  if (rp && rp.note_riduzione) {
    html += '<div class="text-sm text-amber-700 bg-amber-50 px-3 py-2 rounded mb-3"><strong>Nota riduzione:</strong> ' + rp.note_riduzione + '</div>';
  }

  var measures = comp.measures || [];
  if (measures.length) {
    html += '<div class="mt-4 border-t pt-4"><h4 class="text-sm font-semibold text-gray-700 mb-2">Misure Antincendio</h4>' +
      '<table class="w-full text-sm"><thead><tr class="text-left text-gray-500 border-b">' +
      '<th class="pb-1 w-8"></th><th class="pb-1 w-40">Misura</th><th class="pb-1 w-16">Livello</th>' +
      '<th class="pb-1">Soluzione tecnica</th><th class="pb-1">Razionale livello</th><th class="pb-1">Razionale soluzione</th>' +
      '</tr></thead><tbody>';
    for (var j = 0; j < measures.length; j++) {
      var m = measures[j], mv = m.validation || {};
      var mIcon = validationIcon(mv.status), rowClass = validationRowClass(mv.status);
      html += '<tr class="border-b border-gray-100 ' + rowClass + '">' +
        '<td class="py-2 text-center" title="' + (mv.message || 'Non validato') + '">' + mIcon + '</td>' +
        '<td class="py-2 font-medium">' + m.codice + (m.nome ? ' - ' + m.nome : "") + '</td>' +
        '<td class="py-2">' + (m.livello_prestazione != null ? m.livello_prestazione : dash) + '</td>' +
        '<td class="py-2">' + (m.soluzione_tecnica != null ? m.soluzione_tecnica : dash) + '</td>' +
        '<td class="py-2 text-gray-600 text-xs leading-relaxed">' + (m.razionale_livello != null ? m.razionale_livello : dash) + '</td>' +
        '<td class="py-2 text-gray-600 text-xs leading-relaxed">' + (m.razionale_soluzione != null ? m.razionale_soluzione : dash) + '</td></tr>';
      if (mv.message && mv.status !== "not_validated") {
        var mc = mv.status === "error" ? "text-red-600" : mv.status === "warning" ? "text-amber-600" : "text-green-600";
        html += '<tr><td></td><td colspan="5" class="text-xs pb-2 ' + mc + '">' + mv.message +
          (mv.expected ? ' (atteso: ' + mv.expected + ')' : "") + '</td></tr>';
      }
    }
    html += "</tbody></table></div>";
  }

  if (comp.locali && comp.locali.length) {
    html += '<div class="mt-4 border-t pt-4"><h4 class="text-sm font-semibold text-gray-700 mb-2">Locali</h4>' +
      '<table class="w-full text-sm"><thead><tr class="text-left text-gray-500 border-b">' +
      '<th class="pb-1">Locale</th><th class="pb-1">Piano</th></tr></thead><tbody>';
    for (var k = 0; k < comp.locali.length; k++) {
      var r = comp.locali[k];
      html += '<tr class="border-b border-gray-100"><td class="py-1">' + r.nome +
        '</td><td class="py-1">' + (r.piano != null ? r.piano : dash) + '</td></tr>';
    }
    html += "</tbody></table></div>";
  }
  return html;
}

function field(label, val) {
  return '<div><div class="field-label">' + label + '</div>' +
    '<div class="field-value">' + (val != null ? val : '<span class="text-gray-300">&mdash;</span>') + '</div></div>';
}

function validationIcon(status) {
  switch (status) {
    case "ok": return '<span class="v-icon v-ok" title="Conforme">&#10003;</span>';
    case "warning": return '<span class="v-icon v-warn" title="Warning">&#9888;</span>';
    case "error": return '<span class="v-icon v-err" title="Errore">&#10007;</span>';
    default: return '<span class="v-icon v-none" title="Non validato">&#9744;</span>';
  }
}

function validationRowClass(status) {
  switch (status) {
    case "ok": return "validation-ok";
    case "warning": return "validation-warn";
    case "error": return "validation-err";
    default: return "";
  }
}

function rvitaColor(v) {
  if (!v) return "gray";
  var u = v.toUpperCase();
  if (u.startsWith("A1") || u.startsWith("A2")) return "green";
  if (u.startsWith("A3") || u.startsWith("B1") || u.startsWith("B2")) return "yellow";
  if (u.startsWith("B3") || u.startsWith("C")) return "orange";
  return "red";
}

function riskBadges(rp) {
  if (!rp) return "";
  var html = "";
  if (rp.rvita) html += '<span class="badge badge-' + rvitaColor(rp.rvita) + '">Rvita ' + rp.rvita + '</span>';
  if (rp.rbeni != null) html += '<span class="badge badge-gray">Rbeni ' + rp.rbeni + '</span>';
  if (rp.rambiente) {
    var c = rp.rambiente.toLowerCase().includes("non significativo") ? "green" : "red";
    html += '<span class="badge badge-' + c + '">Ramb ' + rp.rambiente + '</span>';
  }
  return html;
}

function toggleCompartment(header) {
  header.classList.toggle("open");
  header.nextElementSibling.classList.toggle("open");
}

function escapeHtml(text) {
  if (!text) return "";
  var div = document.createElement("div");
  div.appendChild(document.createTextNode(text));
  return div.innerHTML;
}

function formatDate(ts) {
  if (!ts) return "";
  var d = new Date(ts);
  return d.toLocaleString("it-IT", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

// ── Init ────────────────────────────────────────────────────────
renderClientList();
renderWelcomeCards();
