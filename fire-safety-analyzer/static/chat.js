// ── Chat / Interrogazione Documenti ─────────────────────────────

var chatSection = document.getElementById("chat-section");
var chatMessages = document.getElementById("chat-messages");
var chatWelcome = document.getElementById("chat-welcome");
var chatInput = document.getElementById("chat-input");
var chatSendBtn = document.getElementById("chat-send-btn");
var chatNewBtn = document.getElementById("chat-new-btn");
var chatConvList = document.getElementById("chat-conv-list");
var chatDebugPanel = document.getElementById("chat-debug-panel");
var chatDebugToggle = document.getElementById("chat-debug-toggle");

var _currentConvId = null;
var _isStreaming = false;
var _welcomeHtml = chatWelcome ? chatWelcome.outerHTML : "";

// Tab switching is handled centrally in normativa.js.
// loadConversationList is called from there.

// ── Conversation list ───────────────────────────────────────────

async function loadConversationList() {
  try {
    var resp = await fetch("/chat/conversations");
    var convs = await resp.json();

    if (!convs.length) {
      chatConvList.innerHTML = '<div class="text-sm text-gray-400 p-2">Nessuna conversazione</div>';
      return;
    }

    var h = "";
    for (var i = 0; i < convs.length; i++) {
      var c = convs[i];
      var isActive = c.id === _currentConvId;
      h += '<div class="flex items-center gap-2 px-3 py-2 rounded-lg text-sm cursor-pointer transition-colors '
        + (isActive ? 'bg-emerald-50 text-emerald-700 font-medium' : 'hover:bg-gray-100 text-gray-700')
        + '" onclick="openConversation(\'' + c.id + '\')">';
      h += '<svg class="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">'
        + '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"/></svg>';
      h += '<span class="truncate flex-1">' + _esc(c.title) + '</span>';
      h += '<span class="text-xs text-gray-400 flex-shrink-0">' + c.message_count + '</span>';
      // Delete button
      h += '<button onclick="event.stopPropagation(); deleteConversation(\'' + c.id + '\')" '
        + 'class="text-gray-300 hover:text-red-500 flex-shrink-0" title="Elimina">'
        + '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">'
        + '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg></button>';
      h += '</div>';
    }
    chatConvList.innerHTML = h;
  } catch (e) {
    chatConvList.innerHTML = '<div class="text-sm text-red-400 p-2">Errore caricamento</div>';
  }
}

// ── New conversation ────────────────────────────────────────────

chatNewBtn.addEventListener("click", async function () {
  var resp = await fetch("/chat/conversations", { method: "POST", body: new FormData() });
  var conv = await resp.json();
  _currentConvId = conv.id;
  renderMessages([]);
  loadConversationList();
});

// ── Open conversation ───────────────────────────────────────────

async function openConversation(convId) {
  try {
    var resp = await fetch("/chat/conversations/" + encodeURIComponent(convId));
    var conv = await resp.json();
    if (conv.error) return;
    _currentConvId = conv.id;
    renderMessages(conv.messages || []);
    loadConversationList();
  } catch (e) { /* ignore */ }
}

async function deleteConversation(convId) {
  await fetch("/chat/conversations/" + encodeURIComponent(convId), { method: "DELETE" });
  if (convId === _currentConvId) {
    _currentConvId = null;
    renderMessages([]);
  }
  loadConversationList();
}

// ── Render messages ─────────────────────────────────────────────

function renderMessages(messages) {
  if (!messages.length) {
    chatMessages.innerHTML = _welcomeHtml;
    return;
  }

  var h = "";
  for (var i = 0; i < messages.length; i++) {
    var m = messages[i];
    h += renderMessageBubble(m.role, m.content, m.sources || []);
  }
  chatMessages.innerHTML = h;
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function renderMessageBubble(role, content, sources) {
  var isUser = role === "user";
  var align = "justify-start";
  var bg = isUser ? "bg-emerald-50 border border-emerald-200 text-gray-800" : "bg-white border text-gray-800";
  var label = isUser
    ? '<div class="text-xs font-bold mb-1 opacity-80">Tu</div>'
    : '<div class="text-xs font-bold mb-1 text-emerald-600">AI</div>';
  var maxW = "max-w-2xl";

  var h = '<div class="flex ' + align + '">';
  h += '<div class="' + bg + ' ' + maxW + ' rounded-2xl px-4 py-3 shadow-sm">';
  h += label;

  if (isUser) {
    h += '<div class="text-sm whitespace-pre-wrap">' + _esc(content) + '</div>';
  } else {
    // Render markdown-ish content (bold, lists, citations)
    h += '<div class="text-sm prose prose-sm max-w-none">' + renderMarkdown(content) + '</div>';

    // Sources
    if (sources && sources.length) {
      h += '<div class="mt-3 pt-2 border-t border-gray-100">';
      h += '<div class="text-xs font-semibold text-gray-500 mb-1">Fonti (' + sources.length + ')</div>';
      for (var si = 0; si < sources.length; si++) {
        var s = sources[si];
        h += '<div class="text-xs text-gray-500">';
        h += '<span class="font-medium">' + _esc(s.doc_name || "") + '</span>';
        if (s.parent_title) h += ' > ' + _esc(s.parent_title);
        if (s.title) h += ' > ' + _esc(s.title);
        if (s.pages) h += ' (' + _esc(s.pages) + ')';
        h += ' <span class="text-gray-400">score: ' + (s.score || 0).toFixed(3) + '</span>';
        h += '</div>';
      }
      h += '</div>';
    }
  }

  h += '</div></div>';
  return h;
}

function renderMarkdown(text) {
  if (!text) return "";
  // Basic markdown: bold, italic, headings, line breaks, lists
  var escaped = _esc(text);
  // Headings (must be processed before bold/italic and before line breaks)
  escaped = escaped.replace(/^### (.+)$/gm, '<h4 class="text-sm font-bold mt-3 mb-1 text-gray-700">$1</h4>');
  escaped = escaped.replace(/^## (.+)$/gm, '<h3 class="text-base font-bold mt-4 mb-1 text-emerald-700">$1</h3>');
  // Bold and italic
  escaped = escaped.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  escaped = escaped.replace(/\*(.*?)\*/g, '<em>$1</em>');
  // Lists
  escaped = escaped.replace(/\n- /g, '\n<li class="ml-4 list-disc">');
  escaped = escaped.replace(/\n(\d+)\. /g, '\n<li class="ml-4 list-decimal">');
  // Paragraphs
  escaped = escaped.replace(/\n\n/g, '</p><p>');
  escaped = escaped.replace(/\n/g, '<br>');
  return '<p>' + escaped + '</p>';
}

// ── Send message ────────────────────────────────────────────────

chatSendBtn.addEventListener("click", sendMessage);
chatInput.addEventListener("keydown", function (e) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// Auto-resize textarea
chatInput.addEventListener("input", function () {
  this.style.height = "auto";
  this.style.height = Math.min(this.scrollHeight, 120) + "px";
});

async function sendMessage() {
  var msg = chatInput.value.trim();
  if (!msg || _isStreaming) return;

  // Create conversation if needed
  if (!_currentConvId) {
    var resp = await fetch("/chat/conversations", { method: "POST", body: new FormData() });
    var conv = await resp.json();
    _currentConvId = conv.id;
  }

  // Show user message immediately — clear welcome if present
  var welcomeEl = document.getElementById("chat-welcome");
  if (welcomeEl) welcomeEl.remove();
  chatMessages.innerHTML += renderMessageBubble("user", msg, []);
  chatInput.value = "";
  chatInput.style.height = "auto";

  // Show streaming placeholder
  var assistantId = "stream-" + Date.now();
  chatMessages.innerHTML += '<div id="' + assistantId + '" class="flex justify-start">'
    + '<div class="bg-white border max-w-2xl rounded-2xl px-4 py-3 shadow-sm">'
    + '<div class="text-xs font-bold mb-1 text-emerald-600">AI</div>'
    + '<div class="text-sm text-gray-400" id="' + assistantId + '-content">Ricerca in corso...</div>'
    + '<div id="' + assistantId + '-sources" class="hidden mt-3 pt-2 border-t border-gray-100"></div>'
    + '</div></div>';
  chatMessages.scrollTop = chatMessages.scrollHeight;

  _isStreaming = true;
  chatSendBtn.disabled = true;
  chatSendBtn.classList.add("opacity-50");

  // Clear debug
  chatDebugPanel.innerHTML = "";

  var formData = new FormData();
  formData.append("message", msg);
  formData.append("k_per_query", document.getElementById("chat-k").value || "5");
  formData.append("search_mode", document.getElementById("chat-search-mode").value || "hybrid");

  try {
    var response = await fetch("/chat/conversations/" + _currentConvId + "/message", {
      method: "POST",
      body: formData,
    });

    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var buffer = "";
    var fullAnswer = "";
    var sources = [];
    var contentEl = document.getElementById(assistantId + "-content");
    var sourcesEl = document.getElementById(assistantId + "-sources");

    while (true) {
      var result = await reader.read();
      if (result.done) break;

      buffer += decoder.decode(result.value, { stream: true });

      // Parse SSE events from buffer
      var lines = buffer.split("\n");
      buffer = lines.pop(); // keep incomplete line

      var currentEvent = null;
      for (var li = 0; li < lines.length; li++) {
        var line = lines[li];
        if (line.startsWith("event: ")) {
          currentEvent = line.slice(7).trim();
        } else if (line.startsWith("data: ") && currentEvent) {
          var data;
          try { data = JSON.parse(line.slice(6)); } catch (e) { continue; }

          if (currentEvent === "routing") {
            _debugLog("Router: " + data.reasoning);
            // Show queries in the bubble
            var queryHtml = '<div class="text-xs text-gray-500 space-y-1">';
            queryHtml += '<div class="font-semibold text-emerald-600 mb-1">Ricerca in corso...</div>';
            for (var qi = 0; qi < (data.queries || []).length; qi++) {
              var q = data.queries[qi];
              queryHtml += '<div class="flex items-start gap-1">'
                + '<span class="text-emerald-500 font-mono">' + (qi+1) + '.</span> '
                + '<span class="text-gray-600">' + _esc(q.query) + '</span>'
                + (q.doc_id ? ' <span class="text-gray-400 text-xs">(doc:' + _esc(q.doc_id) + ')</span>' : '')
                + '</div>';
              _debugLog("  Query " + (qi+1) + ": " + q.query + (q.doc_id ? " (doc:" + q.doc_id + ")" : ""));
            }
            queryHtml += '</div>';
            contentEl.innerHTML = queryHtml;
            chatMessages.scrollTop = chatMessages.scrollHeight;
          } else if (currentEvent === "retrieval") {
            _debugLog("Retriever: " + data.chunks_count + " chunks trovati");
            sources = data.sources || [];
            contentEl.innerHTML = '<div class="text-xs text-gray-500">'
              + '<span class="font-semibold text-emerald-600">Trovati ' + data.chunks_count + ' chunk</span>'
              + ' — selezione fonti rilevanti...</div>';
            chatMessages.scrollTop = chatMessages.scrollHeight;
          } else if (currentEvent === "selection") {
            _debugLog("Selector: " + data.kept + "/" + data.total + " chunk selezionati (" + data.summary + ")");
            contentEl.innerHTML = '<div class="text-xs text-gray-500">'
              + '<span class="font-semibold text-emerald-600">Selezionati ' + data.kept + '/' + data.total + ' chunk</span>'
              + ' — generazione risposta...</div>';
            chatMessages.scrollTop = chatMessages.scrollHeight;
          } else if (currentEvent === "chunk") {
            if (!fullAnswer) contentEl.innerHTML = ""; // clear placeholder
            fullAnswer += data;
            contentEl.innerHTML = '<div class="prose prose-sm max-w-none">' + renderMarkdown(fullAnswer) + '</div>';
            chatMessages.scrollTop = chatMessages.scrollHeight;
          } else if (currentEvent === "sources") {
            sources = data || [];
          } else if (currentEvent === "done") {
            _debugLog("Generazione completata: " + fullAnswer.length + " chars, " + sources.length + " fonti");
            // Render sources
            if (sources.length) {
              var sh = '<div class="text-xs font-semibold text-gray-500 mb-1">Fonti (' + sources.length + ')</div>';
              for (var si = 0; si < sources.length; si++) {
                var s = sources[si];
                sh += '<div class="text-xs text-gray-500">';
                sh += '<span class="font-medium">' + _esc(s.doc_name || "") + '</span>';
                if (s.parent_title) sh += ' &gt; ' + _esc(s.parent_title);
                if (s.title) sh += ' &gt; ' + _esc(s.title);
                if (s.pages) sh += ' (' + _esc(s.pages) + ')';
                sh += ' <span class="text-gray-400">score: ' + (s.score || 0).toFixed(3) + '</span>';
                sh += '</div>';
              }
              sourcesEl.innerHTML = sh;
              sourcesEl.classList.remove("hidden");
            }
          } else if (currentEvent === "error") {
            contentEl.innerHTML = '<span class="text-red-500">Errore: ' + _esc(String(data)) + '</span>';
            _debugLog("ERRORE: " + data);
          }
          currentEvent = null;
        }
      }
    }
  } catch (e) {
    var el = document.getElementById(assistantId + "-content");
    if (el) el.innerHTML = '<span class="text-red-500">Errore di connessione: ' + _esc(e.message) + '</span>';
  }

  _isStreaming = false;
  chatSendBtn.disabled = false;
  chatSendBtn.classList.remove("opacity-50");
  loadConversationList();
}

// ── Debug log ───────────────────────────────────────────────────

function _debugLog(msg) {
  if (!chatDebugToggle.checked) return;
  chatDebugPanel.classList.remove("hidden");
  var ts = new Date().toLocaleTimeString();
  chatDebugPanel.innerHTML += '<div>[' + ts + '] ' + _esc(msg) + '</div>';
  chatDebugPanel.scrollTop = chatDebugPanel.scrollHeight;
}

chatDebugToggle.addEventListener("change", function () {
  if (!this.checked) chatDebugPanel.classList.add("hidden");
});

// ── Utility ─────────────────────────────────────────────────────

function _esc(text) {
  if (!text) return "";
  var div = document.createElement("div");
  div.textContent = String(text);
  return div.innerHTML;
}
