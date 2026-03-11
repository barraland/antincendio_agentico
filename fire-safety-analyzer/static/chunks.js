// ── Chunk Explorer ──────────────────────────────────────────────

const chunkSection = document.getElementById("chunks-section");
const chunkFilterDoc = document.getElementById("chunk-filter-doc");
const chunkFilterIndex = document.getElementById("chunk-filter-index");
const chunkFilterKeyword = document.getElementById("chunk-filter-keyword");
const chunkFilterBtn = document.getElementById("chunk-filter-btn");
const chunkList = document.getElementById("chunk-list");
const chunkDetail = document.getElementById("chunk-detail");
const chunkEmpty = document.getElementById("chunk-empty");
const chunkCountLabel = document.getElementById("chunk-count-label");

// ── Register this tab with the sidebar switching system ─────────
const _origSwitch = typeof switchSidebarTab === "function" ? switchSidebarTab : null;

function switchSidebarTabExtended(tab) {
  if (_origSwitch) _origSwitch(tab);

  var sidebarChunks = document.getElementById("sidebar-chunks");
  sidebarChunks.classList.toggle("hidden", tab !== "chunks");

  if (tab === "chunks") {
    [
      "upload-section", "loading-section", "results-section", "error-section",
      "norm-upload-section", "norm-processing-section",
      "norm-detail-section", "norm-error-section", "chat-section"
    ].forEach(function (id) { var el = document.getElementById(id); if (el) el.classList.add("hidden"); });

    chunkSection.classList.remove("hidden");
    loadChunkDocFilter();
    loadChunks();
  } else {
    chunkSection.classList.add("hidden");
  }

  document.querySelectorAll(".sidebar-tab").forEach(function (t) {
    t.classList.toggle("active", t.dataset.tab === tab);
  });
}

window.switchSidebarTab = switchSidebarTabExtended;

document.querySelectorAll(".sidebar-tab").forEach(function (tab) {
  var clone = tab.cloneNode(true);
  tab.parentNode.replaceChild(clone, tab);
  clone.addEventListener("click", function () {
    switchSidebarTabExtended(this.dataset.tab);
  });
});

// ── Filter controls ─────────────────────────────────────────────
chunkFilterBtn.addEventListener("click", loadChunks);
chunkFilterKeyword.addEventListener("keydown", function (e) {
  if (e.key === "Enter") loadChunks();
});
chunkFilterIndex.addEventListener("keydown", function (e) {
  if (e.key === "Enter") loadChunks();
});
// Auto-search when document dropdown changes
chunkFilterDoc.addEventListener("change", loadChunks);

async function loadChunkDocFilter() {
  try {
    var resp = await fetch("/normativa/documents");
    var docs = await resp.json();
    var current = chunkFilterDoc.value;
    chunkFilterDoc.innerHTML = '<option value="">Tutti i documenti</option>';
    for (var i = 0; i < docs.length; i++) {
      var d = docs[i];
      if (d.status !== "done") continue;
      var label = d.nome_legge || d.filename;
      chunkFilterDoc.innerHTML +=
        '<option value="' + d.id + '"' + (d.id === current ? " selected" : "") + '>' + escapeHtml(label) + '</option>';
    }
  } catch (e) { /* ignore */ }
}

async function loadChunks() {
  var docId = chunkFilterDoc.value;
  var keyword = chunkFilterKeyword.value.trim();
  var indexVal = chunkFilterIndex.value.trim();

  var params = new URLSearchParams();
  if (docId) params.set("doc_id", docId);
  if (keyword) params.set("keyword", keyword);
  if (indexVal !== "") params.set("chunk_index", indexVal);

  chunkList.innerHTML = '<div class="text-center py-8 text-gray-400">Caricamento...</div>';
  chunkDetail.classList.add("hidden");
  chunkEmpty.classList.add("hidden");
  chunkCountLabel.textContent = "";

  try {
    var resp = await fetch("/normativa/chunks?" + params.toString());
    var data = await resp.json();
    var chunks = data.chunks || [];

    chunkCountLabel.textContent = chunks.length + " chunk" + (chunks.length !== 1 ? "s" : "");

    if (!chunks.length) {
      chunkList.innerHTML = "";
      chunkEmpty.classList.remove("hidden");
      return;
    }

    // Single result → show full detail view
    if (chunks.length === 1) {
      chunkList.innerHTML = "";
      showChunkDetail(chunks[0]);
      return;
    }

    // Multiple results → clickable list
    chunkDetail.classList.add("hidden");
    chunkList.innerHTML = "";
    for (var i = 0; i < chunks.length; i++) {
      chunkList.appendChild(renderChunkCard(chunks[i]));
    }
  } catch (e) {
    chunkList.innerHTML =
      '<div class="text-center py-8 text-red-500">Errore: ' + escapeHtml(e.message) + "</div>";
  }
}

// ── Chunk detail view (full content + all metadata) ─────────────

function showChunkDetail(c) {
  _l2Loaded = false;
  chunkDetail.classList.remove("hidden");

  var idx = c.chunk_index != null ? c.chunk_index : "?";
  var pages = c.page_start
    ? (c.page_start === c.page_end ? "p. " + c.page_start : "pp. " + c.page_start + "-" + c.page_end)
    : "\u2014";

  var h = '<div class="bg-white rounded-lg shadow p-6">';

  // Back button
  h += '<button onclick="closeChunkDetail()" class="chunk-nav-btn mb-4">';
  h += '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/></svg>';
  h += " Torna alla lista</button>";

  // Title bar
  h += '<div class="flex items-center gap-3 mb-5">';
  h += '<span class="chunk-idx" style="min-width:44px;height:30px;font-size:0.9rem">#' + idx + "</span>";
  h += '<h2 class="text-lg font-semibold text-gray-900">' + escapeHtml(c.hierarchy_path || "") + "</h2>";
  h += "</div>";

  // Metadata table
  h += '<div class="border rounded-lg overflow-hidden mb-5">';
  h += '<table class="w-full text-sm">';
  h += mRow("Documento", c.nome_legge || "\u2014");
  h += mRow("doc_id", c.doc_id || "\u2014");
  h += mRow("chunk_index", String(idx));
  h += mRow("Pagine", pages);
  h += mRow("hierarchy_path", c.hierarchy_path || "\u2014");
  h += mRow("data_inizio_validita", c.data_inizio_validita || "\u2014");
  h += mRow("data_fine_validita", c.data_fine_validita || "\u2014");

  h += mRow("Lunghezza testo", c.text ? c.text.length + " caratteri" : "\u2014");
  h += "</table></div>";

  // Full text (annotated if available, otherwise plain)
  h += '<div class="font-semibold text-sm text-gray-700 mb-2">Testo completo</div>';
  var displayText = c.annotated_text ? renderAnnotatedText(c.annotated_text) : escapeHtml(c.text || "");
  h += '<div class="chunk-detail-text">' + displayText + "</div>";

  // Sub-chunks (L2) expandable section
  if (c.doc_id && typeof idx === "number") {
    h += '<div class="mt-5 border rounded-lg overflow-hidden">';
    h += '<button id="l2-toggle-btn" onclick="toggleSubChunks(\'' + c.doc_id + '\', ' + idx + ')" ';
    h += 'class="w-full px-4 py-3 bg-gray-50 hover:bg-gray-100 text-left font-semibold text-sm text-gray-700 flex items-center gap-2 transition-colors">';
    h += '<svg id="l2-toggle-arrow" class="w-4 h-4 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>';
    h += 'Sub-chunks (livello 2)';
    h += '</button>';
    h += '<div id="l2-container" class="hidden"></div>';
    h += '</div>';
  }

  // Prev / Next navigation
  h += '<div class="flex justify-between mt-5">';
  if (typeof idx === "number" && idx > 0) {
    h += '<button onclick="goToChunk(' + (idx - 1) + ')" class="chunk-nav-btn">';
    h += '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/></svg>';
    h += " Chunk #" + (idx - 1) + "</button>";
  } else {
    h += "<span></span>";
  }
  h += '<button onclick="goToChunk(' + (typeof idx === "number" ? idx + 1 : 1) + ')" class="chunk-nav-btn">';
  h += "Chunk #" + (typeof idx === "number" ? idx + 1 : 1) + " ";
  h += '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>';
  h += "</button>";
  h += "</div>";

  h += "</div>";
  chunkDetail.innerHTML = h;
}

function mRow(label, value, isHtml) {
  return '<tr class="border-b last:border-b-0">'
    + '<td class="px-4 py-2 font-semibold text-gray-600 bg-gray-50 w-48 align-top">' + escapeHtml(label) + "</td>"
    + '<td class="px-4 py-2 text-gray-800">' + (isHtml ? value : escapeHtml(value)) + "</td>"
    + "</tr>";
}

function closeChunkDetail() {
  chunkDetail.classList.add("hidden");
  chunkFilterIndex.value = "";
  loadChunks();
}

function goToChunk(index) {
  chunkFilterIndex.value = index;
  loadChunks();
}

// ── Click a card → open detail ──────────────────────────────────

function openChunkFromCard(chunkData) {
  showChunkDetail(chunkData);
  chunkList.innerHTML = "";
}

// ── Chunk card (list view) ──────────────────────────────────────

function renderChunkCard(c) {
  var card = document.createElement("div");
  card.className = "chunk-card chunk-card-clickable";

  var idx = c.chunk_index != null ? c.chunk_index : "?";
  var pages = c.page_start
    ? (c.page_start === c.page_end ? "p. " + c.page_start : "pp. " + c.page_start + "-" + c.page_end)
    : "";
  var truncText = c.text && c.text.length > 300
    ? c.text.slice(0, 300) + "..."
    : c.text || "";

  card.innerHTML =
    '<div class="chunk-card-header">' +
      '<span class="chunk-idx">#' + idx + "</span>" +
      '<span class="chunk-hierarchy">' + escapeHtml(c.hierarchy_path || "") + "</span>" +
      '<span class="chunk-pages">' + pages + "</span>" +
    "</div>" +
    '<div class="chunk-card-meta">' +
      '<span class="text-xs text-gray-500">' + escapeHtml(c.nome_legge || "") + "</span>" +
    "</div>" +
    '<div class="chunk-card-text">' + escapeHtml(truncText) + "</div>";

  card._chunkData = c;
  card.addEventListener("click", function () {
    openChunkFromCard(this._chunkData);
  });

  return card;
}

// ── Render annotated text with formatting ───────────────────────

function renderAnnotatedText(text) {
  var lines = text.split("\n");
  var html = "";
  var i = 0;
  while (i < lines.length) {
    var line = lines[i];

    // Page marker: [PAGINA N]
    var pageMatch = line.match(/^\[PAGINA\s+(\d+)\]$/);
    if (pageMatch) {
      html += '<div style="margin-top:1.2em;margin-bottom:0.3em;color:#6b7280;font-size:0.75rem;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Pagina ' + pageMatch[1] + '</div>';
      i++;
      continue;
    }

    // Table marker: [TABLE] followed by markdown table lines
    if (line.trim() === "[TABLE]") {
      i++;
      var tableLines = [];
      while (i < lines.length && lines[i].match(/^\|/)) {
        tableLines.push(lines[i]);
        i++;
      }
      if (tableLines.length > 0) {
        html += renderMarkdownTable(tableLines);
      }
      continue;
    }

    // Tagged line: [H1|Xpt], [H2|Xpt], [H3|Xpt], [BODY|Xpt]
    var tagMatch = line.match(/^\[(H1|H2|H3|BODY)\|(\d+)pt\]\s*(.*)$/);
    if (tagMatch) {
      var tag = tagMatch[1];
      var content = escapeHtml(tagMatch[3]);
      if (tag === "H1") {
        html += '<div style="font-size:1.25rem;font-weight:700;color:#111827;margin-top:1em;margin-bottom:0.3em;">' + content + '</div>';
      } else if (tag === "H2") {
        html += '<div style="font-size:1.05rem;font-weight:600;color:#1f2937;margin-top:0.8em;margin-bottom:0.2em;">' + content + '</div>';
      } else if (tag === "H3") {
        html += '<div style="font-size:0.95rem;font-weight:600;color:#374151;margin-top:0.5em;margin-bottom:0.1em;">' + content + '</div>';
      } else {
        html += '<div style="font-size:0.875rem;color:#374151;line-height:1.5;">' + content + '</div>';
      }
      i++;
      continue;
    }

    // Empty line → spacer
    if (line.trim() === "") {
      html += '<div style="height:0.5em;"></div>';
    } else {
      html += '<div style="font-size:0.875rem;color:#374151;line-height:1.5;">' + escapeHtml(line) + '</div>';
    }
    i++;
  }
  return html;
}

function renderMarkdownTable(lines) {
  // Parse markdown table: | col1 | col2 | ... |
  // Skip separator row (| --- | --- |)
  var rows = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (line.match(/^\|\s*[-:]+/)) continue;  // separator row
    var cells = line.split("|").slice(1);  // remove first empty from leading |
    if (cells.length && cells[cells.length - 1].trim() === "") cells.pop();  // remove trailing empty
    rows.push(cells.map(function (c) { return c.trim(); }));
  }
  if (!rows.length) return "";

  var h = '<table style="width:100%;border-collapse:collapse;font-size:0.8rem;margin:0.8em 0;">';
  // First row as header
  h += '<thead><tr>';
  for (var c = 0; c < rows[0].length; c++) {
    h += '<th style="border:1px solid #d1d5db;padding:6px 8px;background:#f3f4f6;font-weight:600;text-align:left;">' + escapeHtml(rows[0][c]) + '</th>';
  }
  h += '</tr></thead><tbody>';
  for (var r = 1; r < rows.length; r++) {
    h += '<tr>';
    for (var c = 0; c < rows[r].length; c++) {
      h += '<td style="border:1px solid #d1d5db;padding:6px 8px;">' + escapeHtml(rows[r][c]) + '</td>';
    }
    h += '</tr>';
  }
  h += '</tbody></table>';
  return h;
}

// ── L2 Sub-chunks toggle ────────────────────────────────────────

var _l2Loaded = false;

async function toggleSubChunks(docId, parentIndex) {
  var container = document.getElementById("l2-container");
  var arrow = document.getElementById("l2-toggle-arrow");
  var btn = document.getElementById("l2-toggle-btn");

  if (!container.classList.contains("hidden")) {
    container.classList.add("hidden");
    arrow.style.transform = "";
    return;
  }

  container.classList.remove("hidden");
  arrow.style.transform = "rotate(90deg)";

  if (_l2Loaded) return;

  container.innerHTML = '<div class="px-4 py-3 text-gray-400 text-sm">Caricamento sub-chunks...</div>';

  try {
    var resp = await fetch("/normativa/chunks_l2?doc_id=" + encodeURIComponent(docId) + "&parent_chunk_index=" + parentIndex);
    var data = await resp.json();
    var chunks = data.chunks || [];

    if (!chunks.length) {
      container.innerHTML = '<div class="px-4 py-3 text-gray-400 text-sm">Nessun sub-chunk trovato per questo capitolo.</div>';
      _l2Loaded = true;
      return;
    }

    var h = '<div class="px-4 py-2 text-xs text-gray-500 bg-gray-50 border-b">' + chunks.length + ' sub-chunk' + (chunks.length !== 1 ? 's' : '') + '</div>';

    for (var i = 0; i < chunks.length; i++) {
      var sc = chunks[i];
      var pages = sc.page_start
        ? (sc.page_start === sc.page_end ? "p. " + sc.page_start : "pp. " + sc.page_start + "-" + sc.page_end)
        : "";
      var fullText = sc.text || "";
      var subTitle = sc.title || (sc.hierarchy_path ? sc.hierarchy_path.split(" > ").pop() : ("Parte " + (i + 1)));
      var parentTitle = sc.parent_title || "";
      var docName = sc.doc_name || sc.nome_legge || "";
      var keywords = sc.keywords || [];
      var charCount = fullText.length;

      h += '<div class="border-b last:border-b-0">';
      // Header (always visible)
      h += '<div class="px-4 py-2 flex items-center gap-2 cursor-pointer hover:bg-gray-50" onclick="toggleL2Detail(' + i + ')">';
      h += '<svg id="l2-detail-arrow-' + i + '" class="w-3 h-3 text-gray-400 transition-transform flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>';
      h += '<span class="text-xs font-semibold text-blue-600">#' + sc.sub_chunk_index + '</span>';
      h += '<span class="text-sm font-medium text-gray-800 flex-1">' + escapeHtml(subTitle) + '</span>';
      h += '<span class="text-xs text-gray-400">' + charCount + ' chars · ' + pages + '</span>';
      h += '</div>';
      // Body (hidden by default)
      h += '<div id="l2-detail-body-' + i + '" class="hidden px-4 pb-3">';
      // Metadata bar
      h += '<div style="display:flex;flex-wrap:wrap;gap:6px 16px;margin-bottom:8px;font-size:0.75rem;color:#6b7280;">';
      if (docName) h += '<span><strong>Documento:</strong> ' + escapeHtml(docName) + '</span>';
      if (parentTitle) h += '<span><strong>Capitolo:</strong> ' + escapeHtml(parentTitle) + '</span>';
      if (pages) h += '<span><strong>Pagine:</strong> ' + pages + '</span>';
      h += '</div>';
      // Keywords
      if (keywords.length) {
        h += '<div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px;">';
        for (var ki = 0; ki < keywords.length; ki++) {
          h += '<span style="display:inline-block;font-size:0.7rem;background:#dbeafe;color:#1d4ed8;padding:1px 8px;border-radius:9999px;">' + escapeHtml(keywords[ki]) + '</span>';
        }
        h += '</div>';
      }
      // Full text, scrollable
      h += '<div style="font-size:0.8rem;color:#374151;line-height:1.6;white-space:pre-wrap;max-height:500px;overflow-y:auto;background:#f9fafb;padding:8px 12px;border-radius:6px;">' + escapeHtml(fullText) + '</div>';
      h += '</div>';
      h += '</div>';
    }

    container.innerHTML = h;
    _l2Loaded = true;
  } catch (e) {
    container.innerHTML = '<div class="px-4 py-3 text-red-500 text-sm">Errore: ' + escapeHtml(e.message) + '</div>';
  }
}

function toggleL2Detail(index) {
  var body = document.getElementById("l2-detail-body-" + index);
  var arrow = document.getElementById("l2-detail-arrow-" + index);
  if (!body) return;
  body.classList.toggle("hidden");
  arrow.style.transform = body.classList.contains("hidden") ? "" : "rotate(90deg)";
}

// ── Retrieve test panel ──────────────────────────────────────────

var retrieveBtn = document.getElementById("retrieve-btn");
var retrieveQuery = document.getElementById("retrieve-query");
var retrieveResults = document.getElementById("retrieve-results");
var retrieveDoc = document.getElementById("retrieve-doc");

if (retrieveBtn) {
  retrieveBtn.addEventListener("click", runRetrieve);
  retrieveQuery.addEventListener("keydown", function (e) {
    if (e.key === "Enter") runRetrieve();
  });
}

async function loadRetrieveDocFilter() {
  try {
    var resp = await fetch("/normativa/documents");
    var docs = await resp.json();
    var current = retrieveDoc.value;
    retrieveDoc.innerHTML = '<option value="">Tutti i documenti</option>';
    for (var i = 0; i < docs.length; i++) {
      var d = docs[i];
      if (d.status !== "done") continue;
      var label = d.nome_legge || d.filename;
      retrieveDoc.innerHTML +=
        '<option value="' + d.id + '"' + (d.id === current ? " selected" : "") + '>' + escapeHtml(label) + '</option>';
    }
  } catch (e) { /* ignore */ }
}

async function runRetrieve() {
  var query = retrieveQuery.value.trim();
  if (!query) return;

  var mode = document.getElementById("retrieve-mode").value;
  var k = parseInt(document.getElementById("retrieve-k").value) || 10;
  var threshold = parseFloat(document.getElementById("retrieve-threshold").value) || 0;
  var docId = retrieveDoc.value;

  retrieveResults.classList.remove("hidden");
  retrieveResults.innerHTML = '<div class="text-gray-400 text-sm py-2">Ricerca in corso...</div>';

  try {
    var formData = new FormData();
    formData.append("query", query);
    formData.append("mode", mode);
    formData.append("k", k);
    formData.append("score_threshold", threshold);
    if (docId) formData.append("doc_id", docId);

    var resp = await fetch("/normativa/retrieve", { method: "POST", body: formData });
    var data = await resp.json();

    if (data.error) {
      retrieveResults.innerHTML = '<div class="text-red-500 text-sm py-2">' + escapeHtml(data.error) + '</div>';
      return;
    }

    var results = data.results || [];
    var h = '<div class="text-xs text-gray-500 mb-2">' + results.length + ' risultati · mode=' + escapeHtml(data.mode) + ' · k=' + data.k + '</div>';

    if (!results.length) {
      h += '<div class="text-gray-400 text-sm">Nessun risultato trovato.</div>';
      retrieveResults.innerHTML = h;
      return;
    }

    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      var score = r.score != null ? r.score.toFixed(4) : "—";
      var title = r.title || (r.hierarchy_path ? r.hierarchy_path.split(" > ").pop() : "—");
      var docName = r.doc_name || r.nome_legge || "";
      var parentTitle = r.parent_title || "";
      var pages = r.page_start
        ? (r.page_start === r.page_end ? "p. " + r.page_start : "pp. " + r.page_start + "-" + r.page_end)
        : "";
      var keywords = r.keywords || [];
      var text = r.text || "";
      var truncText = text.length > 300 ? text.slice(0, 300) + "..." : text;

      h += '<div class="border rounded-lg mb-2 overflow-hidden">';
      // Header
      h += '<div class="px-3 py-2 bg-gray-50 flex items-center gap-2 cursor-pointer" onclick="toggleRetrieveDetail(' + i + ')">';
      h += '<svg id="ret-arrow-' + i + '" class="w-3 h-3 text-gray-400 transition-transform flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>';
      h += '<span class="text-xs font-bold text-indigo-600">#' + (i + 1) + '</span>';
      h += '<span class="text-sm font-medium text-gray-800 flex-1">' + escapeHtml(title) + '</span>';
      h += '<span class="text-xs font-mono text-gray-500">score: ' + score + '</span>';
      h += '</div>';
      // Body (hidden)
      h += '<div id="ret-body-' + i + '" class="hidden px-3 pb-3">';
      // Metadata
      h += '<div style="display:flex;flex-wrap:wrap;gap:4px 14px;margin:6px 0;font-size:0.72rem;color:#6b7280;">';
      if (docName) h += '<span><strong>Doc:</strong> ' + escapeHtml(docName) + '</span>';
      if (parentTitle) h += '<span><strong>Capitolo:</strong> ' + escapeHtml(parentTitle) + '</span>';
      if (pages) h += '<span><strong>Pagine:</strong> ' + pages + '</span>';
      h += '</div>';
      // Keywords
      if (keywords.length) {
        h += '<div style="display:flex;flex-wrap:wrap;gap:3px;margin-bottom:6px;">';
        for (var ki = 0; ki < keywords.length; ki++) {
          h += '<span style="display:inline-block;font-size:0.65rem;background:#e0e7ff;color:#3730a3;padding:1px 7px;border-radius:9999px;">' + escapeHtml(keywords[ki]) + '</span>';
        }
        h += '</div>';
      }
      // Text preview
      h += '<div style="font-size:0.78rem;color:#374151;line-height:1.5;white-space:pre-wrap;max-height:400px;overflow-y:auto;background:#f9fafb;padding:8px 10px;border-radius:6px;">' + escapeHtml(truncText) + '</div>';
      h += '</div>';
      h += '</div>';
    }

    retrieveResults.innerHTML = h;
  } catch (e) {
    retrieveResults.innerHTML = '<div class="text-red-500 text-sm py-2">Errore: ' + escapeHtml(e.message) + '</div>';
  }
}

function toggleRetrieveDetail(index) {
  var body = document.getElementById("ret-body-" + index);
  var arrow = document.getElementById("ret-arrow-" + index);
  if (!body) return;
  body.classList.toggle("hidden");
  arrow.style.transform = body.classList.contains("hidden") ? "" : "rotate(90deg)";
}

// Load doc filter for retrieve panel when chunks tab opens
var _origLoadChunkDocFilter = loadChunkDocFilter;
loadChunkDocFilter = function () {
  _origLoadChunkDocFilter();
  loadRetrieveDocFilter();
};

// ── Utility ─────────────────────────────────────────────────────

function escapeHtml(text) {
  var div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}
