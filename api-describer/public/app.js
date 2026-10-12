import { marked } from "/vendor/marked.esm.js";

// ---------------------------------------------------------------------------
// Markdown rendering. Descriptions are generated from untrusted schemas, so raw
// HTML is shown as text and only http(s)/mailto/anchor links are kept.
// (The page's Content-Security-Policy blocks injected scripts as a second layer.)
// ---------------------------------------------------------------------------
marked.use({
  gfm: true,
  renderer: {
    html: (token) => escapeHtml(token.text),
  },
  walkTokens(token) {
    if ((token.type === "link" || token.type === "image") && !/^(https?:|mailto:|#)/i.test(token.href ?? "")) {
      token.href = "#";
    }
  },
});

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const els = {
  form: $("#form"),
  target: $("#target"),
  file: $("#file"),
  fileLabel: $("#file-label"),
  dropzone: $("#dropzone"),
  audience: $("#audience"),
  bearer: $("#bearer"),
  headers: $("#headers"),
  type: $("#type"),
  effort: $("#effort"),
  model: $("#model"),
  describeBtn: $("#describe-btn"),
  previewBtn: $("#preview-btn"),
  cancelBtn: $("#cancel-btn"),
  credNotice: $("#cred-notice"),
  empty: $("#empty"),
  result: $("#result"),
  kindBadge: $("#kind-badge"),
  status: $("#status"),
  title: $("#result-title"),
  source: $("#result-source"),
  copyBtn: $("#copy-btn"),
  downloadMd: $("#download-md"),
  downloadSchema: $("#download-schema"),
  progress: $("#progress"),
  progressText: $("#progress-text"),
  error: $("#error"),
  description: $("#description"),
  usage: $("#usage"),
  summary: $("#schema-summary"),
  log: $("#log"),
  logCount: $("#log-count"),
  historyList: $("#history-list"),
  historyEmpty: $("#history-empty"),
  clearHistory: $("#clear-history"),
};

let mode = "url";
let uploaded = null; // { name, content }
let controller = null;
let current = null; // { title, kind, source, markdown, summary, raw }

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
init();

async function init() {
  try {
    const config = await (await fetch("/api/config")).json();
    fillSelect(els.type, config.types, "auto");
    fillSelect(els.effort, config.efforts, "high");
    els.model.value = config.defaultModel;
    els.model.placeholder = config.defaultModel;
    els.credNotice.hidden = config.hasCredentials;
  } catch {
    showError("Couldn't reach the api-describer server. Is it still running?");
  }
  renderHistory();
}

function fillSelect(select, options, selected) {
  select.replaceChildren(...options.map((value) => new Option(value, value, false, value === selected)));
}

// Source mode: URL vs uploaded file
for (const btn of $$(".seg")) {
  btn.addEventListener("click", () => setMode(btn.dataset.mode));
}
function setMode(next) {
  mode = next;
  for (const btn of $$(".seg")) {
    btn.classList.toggle("active", btn.dataset.mode === next);
    btn.setAttribute("aria-selected", String(btn.dataset.mode === next));
  }
  for (const field of $$("[data-for]")) field.hidden = field.dataset.for !== next;
}

els.file.addEventListener("change", () => loadFile(els.file.files[0]));
for (const evt of ["dragenter", "dragover"]) {
  els.dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    els.dropzone.classList.add("dragging");
  });
}
for (const evt of ["dragleave", "drop"]) {
  els.dropzone.addEventListener(evt, () => els.dropzone.classList.remove("dragging"));
}
els.dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  loadFile(e.dataTransfer.files[0]);
});

async function loadFile(file) {
  if (!file) return;
  if (file.size > 15 * 1024 * 1024) {
    showError("That file is larger than 15 MB.");
    return;
  }
  uploaded = { name: file.name, content: await file.text() };
  els.fileLabel.textContent = `${file.name} (${formatBytes(file.size)})`;
  els.dropzone.classList.add("has-file");
}

for (const chip of $$("[data-example]")) {
  chip.addEventListener("click", () => {
    setMode("url");
    els.target.value = chip.dataset.example;
    els.target.focus();
  });
}

// Tabs
for (const tab of $$(".tab")) tab.addEventListener("click", () => selectTab(tab.dataset.tab));
function selectTab(name) {
  for (const tab of $$(".tab")) {
    tab.classList.toggle("active", tab.dataset.tab === name);
    tab.setAttribute("aria-selected", String(tab.dataset.tab === name));
  }
  for (const panel of $$(".tab-panel")) panel.hidden = panel.dataset.panel !== name;
}

// ---------------------------------------------------------------------------
// Running a job
// ---------------------------------------------------------------------------
els.form.addEventListener("submit", (e) => {
  e.preventDefault();
  run({ dryRun: false });
});
els.previewBtn.addEventListener("click", () => run({ dryRun: true }));
els.cancelBtn.addEventListener("click", () => controller?.abort());

async function run({ dryRun }) {
  const target = els.target.value.trim();
  if (mode === "url" && !target) return flagInvalid(els.target);
  if (mode === "file" && !uploaded) return flagInvalid(els.dropzone);

  const payload = {
    target: mode === "url" ? target : "",
    file: mode === "file" ? uploaded : undefined,
    type: els.type.value,
    headers: els.headers.value,
    bearer: els.bearer.value.trim() || undefined,
    audience: els.audience.value.trim() || undefined,
    model: els.model.value.trim() || undefined,
    effort: els.effort.value,
    dryRun,
  };

  resetResult(mode === "url" ? target : uploaded.name);
  setBusy(true, dryRun ? "Downloading schema…" : "Connecting…");
  controller = new AbortController();

  let markdown = "";
  let renderQueued = false;
  const renderSoon = () => {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      els.description.innerHTML = marked.parse(markdown);
    });
  };

  try {
    const res = await fetch("/api/describe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `Server returned ${res.status}`);
    }

    for await (const { event, data } of readEvents(res.body)) {
      switch (event) {
        case "log":
          addLog(data.message);
          setBusy(true, data.message);
          break;
        case "schema":
          current = { ...current, title: data.title, kind: data.kind, source: data.source, summary: data.summary, raw: data.raw };
          els.kindBadge.textContent = data.kind;
          els.title.textContent = data.title;
          els.source.textContent = data.source;
          els.summary.textContent = data.summary;
          els.downloadSchema.disabled = false;
          if (dryRun) selectTab("schema");
          break;
        case "text":
          if (!markdown) {
            els.description.classList.add("streaming");
            setBusy(true, "Writing description…");
          }
          markdown += data.text;
          renderSoon();
          break;
        case "done":
          if (data.dryRun) {
            setStatus("Schema preview");
            els.description.innerHTML = `<p class="muted">Schema downloaded. Open <strong>Condensed schema</strong> to see what Claude would receive, or click <strong>Describe API</strong> to generate the description.</p>`;
          } else {
            markdown = data.text ?? markdown;
            els.description.innerHTML = marked.parse(markdown);
            current.markdown = markdown;
            const u = data.usage ?? {};
            els.usage.textContent = `${data.model} · ${num(u.input_tokens)} input tokens · ${num(u.output_tokens)} output tokens`;
            setStatus("Complete");
            enableExports();
            saveHistory(current);
          }
          break;
        case "error":
          throw new Error(data.message);
      }
    }
  } catch (err) {
    if (err.name === "AbortError") {
      setStatus("Cancelled");
      addLog("Cancelled.");
      if (markdown) {
        current.markdown = markdown;
        enableExports();
      }
    } else {
      setStatus("Failed");
      addLog(`Error: ${err.message}`);
      showError(err.message);
    }
  } finally {
    els.description.classList.remove("streaming");
    setBusy(false);
    controller = null;
  }
}

/** Parse a Server-Sent Events stream from a fetch() body. */
async function* readEvents(body) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let event = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("data: ")) data += line.slice(6);
      }
      if (data) yield { event, data: JSON.parse(data) };
    }
  }
}

function resetResult(label) {
  current = { title: label, kind: "", source: label, markdown: "", summary: "", raw: "" };
  els.empty.hidden = true;
  els.result.hidden = false;
  els.error.hidden = true;
  els.description.replaceChildren();
  els.usage.textContent = "";
  els.summary.textContent = "";
  els.log.replaceChildren();
  els.logCount.textContent = "0";
  els.kindBadge.textContent = "…";
  els.title.textContent = label;
  els.source.textContent = "";
  for (const b of [els.copyBtn, els.downloadMd, els.downloadSchema]) b.disabled = true;
  selectTab("description");
  // On narrow screens the results sit below the form - bring them into view.
  if (matchMedia("(max-width: 900px)").matches) els.result.scrollIntoView({ behavior: "smooth", block: "start" });
}

function setBusy(busy, text) {
  els.describeBtn.disabled = busy;
  els.previewBtn.disabled = busy;
  els.cancelBtn.hidden = !busy;
  els.progress.hidden = !busy;
  if (text) els.progressText.textContent = text;
  if (busy) setStatus("Working…");
}

function setStatus(text) {
  els.status.textContent = text;
}

function showError(message) {
  els.empty.hidden = true;
  els.result.hidden = false;
  els.error.textContent = message;
  els.error.hidden = false;
}

function addLog(message) {
  const li = document.createElement("li");
  const time = document.createElement("time");
  time.textContent = new Date().toLocaleTimeString();
  li.append(time, message);
  els.log.append(li);
  els.logCount.textContent = String(els.log.children.length);
}

function flagInvalid(el) {
  el.focus?.();
  el.animate([{ transform: "translateX(0)" }, { transform: "translateX(-4px)" }, { transform: "translateX(4px)" }, { transform: "translateX(0)" }], { duration: 220 });
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
function enableExports() {
  els.copyBtn.disabled = !current?.markdown;
  els.downloadMd.disabled = !current?.markdown;
  els.downloadSchema.disabled = !current?.raw;
}

els.copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(current.markdown);
    flash(els.copyBtn, "Copied!");
  } catch {
    flash(els.copyBtn, "Copy failed");
  }
});
els.downloadMd.addEventListener("click", () => download(`${slug(current.title)}.md`, current.markdown, "text/markdown"));
els.downloadSchema.addEventListener("click", () => {
  const raw = current.raw.trimStart();
  const ext = raw.startsWith("{") || raw.startsWith("[") ? "json" : raw.startsWith("<") ? "xml" : "txt";
  download(`${slug(current.title)}-schema.${ext}`, current.raw, "text/plain");
});

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function flash(btn, text) {
  const original = btn.textContent;
  btn.textContent = text;
  setTimeout(() => (btn.textContent = original), 1400);
}

// ---------------------------------------------------------------------------
// History (this browser only)
// ---------------------------------------------------------------------------
const HISTORY_KEY = "api-describer:history";
const HISTORY_MAX = 12;

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY)) ?? [];
  } catch {
    return [];
  }
}

function saveHistory(entry) {
  // The raw schema can be large, so only the description and condensed schema are kept.
  const item = { id: Date.now(), title: entry.title, kind: entry.kind, source: entry.source, markdown: entry.markdown, summary: entry.summary };
  const items = [item, ...loadHistory().filter((h) => h.source !== item.source)].slice(0, HISTORY_MAX);
  for (let n = items.length; n > 0; n--) {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, n)));
      break;
    } catch {
      // Storage full or unavailable - keep fewer entries.
    }
  }
  renderHistory();
}

function renderHistory() {
  const items = loadHistory();
  els.historyEmpty.hidden = items.length > 0;
  els.clearHistory.hidden = items.length === 0;
  els.historyList.replaceChildren(
    ...items.map((item) => {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      const title = Object.assign(document.createElement("span"), { className: "h-title", textContent: item.title });
      const kind = Object.assign(document.createElement("span"), { className: "h-kind", textContent: item.kind });
      const src = Object.assign(document.createElement("span"), { className: "h-src", textContent: item.source });
      btn.append(title, kind, src);
      btn.addEventListener("click", () => showHistory(item));
      li.append(btn);
      return li;
    }),
  );
}

function showHistory(item) {
  resetResult(item.title);
  current = { ...item, raw: "" };
  els.kindBadge.textContent = item.kind;
  els.source.textContent = item.source;
  els.summary.textContent = item.summary;
  els.description.innerHTML = marked.parse(item.markdown);
  setStatus(`Saved ${new Date(item.id).toLocaleString()}`);
  enableExports();
  if (mode === "url" && /^https?:/i.test(item.source)) els.target.value = item.source;
}

els.clearHistory.addEventListener("click", () => {
  try {
    localStorage.removeItem(HISTORY_KEY);
  } catch {
    // ignore
  }
  renderHistory();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function slug(text) {
  return String(text || "api").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "api";
}

function num(n) {
  return typeof n === "number" ? n.toLocaleString() : "?";
}

function formatBytes(n) {
  return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
}
