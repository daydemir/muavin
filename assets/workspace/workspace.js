const THEME_STORAGE_KEY = "muavin-theme";

function systemTheme() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme) {
  const nextTheme = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = nextTheme;
  document.documentElement.style.colorScheme = nextTheme;
  document.querySelectorAll("[data-theme-toggle]").forEach((button) => {
    button.setAttribute("aria-pressed", nextTheme === "dark" ? "true" : "false");
    button.setAttribute("aria-label", nextTheme === "dark" ? "Switch to light mode" : "Switch to dark mode");
  });
  document.querySelectorAll("[data-theme-label]").forEach((node) => {
    node.textContent = nextTheme === "dark" ? "Light mode" : "Dark mode";
  });
}

function initThemeToggle() {
  let savedTheme = null;
  try {
    savedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
  } catch {}
  applyTheme(savedTheme === "light" || savedTheme === "dark" ? savedTheme : systemTheme());

  document.querySelectorAll("[data-theme-toggle]").forEach((button) => {
    button.addEventListener("click", () => {
      const currentTheme = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
      const nextTheme = currentTheme === "dark" ? "light" : "dark";
      try {
        window.localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
      } catch {}
      applyTheme(nextTheme);
    });
  });

  const media = window.matchMedia("(prefers-color-scheme: dark)");
  if (typeof media.addEventListener === "function") {
    media.addEventListener("change", () => {
      try {
        if (window.localStorage.getItem(THEME_STORAGE_KEY)) return;
      } catch {}
      applyTheme(systemTheme());
    });
  }
}

initThemeToggle();

const root = document.getElementById("workspace-page");

if (root) {
  let selectedCard = null;
  let editorState = null;
  let editorModulePromise = null;

  const relatedPanel = document.getElementById("related-panel");
  const relatedLoading = document.getElementById("related-loading");
  const sidebar = document.getElementById("workspace-sidebar");
  const terminalFrame = document.querySelector(".terminal-frame");

  function noteCards() {
    return Array.from(document.querySelectorAll("[data-note-card='true']"));
  }

  function visibleCards() {
    return noteCards().filter((card) => !card.hidden);
  }

  function bodySource(card) {
    return card.querySelector(".note-body-source");
  }

  function previewNode(card) {
    return card.querySelector(".note-preview");
  }

  function statusNode(card) {
    return card.querySelector(".note-save-status");
  }

  function noteMode() {
    return root.dataset.selectedMode || "list";
  }

  function stripManagedFrontmatter(content) {
    const normalized = String(content || "").replace(/\r\n/g, "\n");
    if (!normalized.startsWith("---\n")) return normalized.trim();
    const lines = normalized.split("\n");
    if (lines[0] !== "---") return normalized.trim();
    const closingIndex = lines.findIndex((line, index) => index > 0 && line === "---");
    if (closingIndex < 0) return normalized.trim();
    return lines.slice(closingIndex + 1).join("\n").trim();
  }

  function normalizeEditorBody(content) {
    return stripManagedFrontmatter(content).replace(/\r\n/g, "\n").trim();
  }

  function deriveTitle(body, fallback = "Untitled") {
    const firstLine = normalizeEditorBody(body)
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean);
    if (!firstLine) return fallback;
    return firstLine.replace(/^#{1,6}\s+/, "").trim() || fallback;
  }

  function derivePreview(body) {
    const normalized = normalizeEditorBody(body);
    if (!normalized) return "Empty note";
    const lines = normalized
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 4);
    return lines.join("\n");
  }

  function updateCardDraftPresentation(card, body) {
    const titleNode = card.querySelector("h2");
    if (titleNode) titleNode.textContent = deriveTitle(body, card.dataset.noteState === "new" ? "Untitled" : "Untitled note");
    const preview = previewNode(card);
    if (preview) preview.textContent = derivePreview(body);
  }

  function editorIsDirty() {
    return Boolean(editorState?.dirty);
  }

  function editorHasFailedSave() {
    return Boolean(editorState?.dirty && editorState?.saveFailed);
  }

  function setStatus(card, value, kind = "") {
    const node = statusNode(card);
    if (!node) return;
    node.textContent = value;
    node.dataset.state = kind;
  }

  function ensureEditorModule() {
    if (!editorModulePromise) {
      editorModulePromise = import("/static/workspace/codemirror-bundle.min.js");
    }
    return editorModulePromise;
  }

  function clearSelection() {
    noteCards().forEach((card) => card.classList.remove("selected"));
  }

  function renderEmptyRelatedState() {
    if (!relatedPanel) return;
    relatedPanel.innerHTML = '<div class="related-shell"><section class="sidebar-panel"><h2>Related Blocks</h2><p class="muted">Select a saved note to load related blocks.</p></section></div>';
  }

  async function loadRelated(card) {
    if (!relatedPanel) return;
    const relatedUrl = card.dataset.relatedUrl;
    if (!relatedUrl) {
      renderEmptyRelatedState();
      return;
    }
    try {
      if (window.htmx && typeof window.htmx.ajax === "function") {
        await window.htmx.ajax("GET", relatedUrl, {
          target: "#related-panel",
          swap: "innerHTML",
          indicator: "#related-loading",
          headers: { "HX-Request": "true" },
        });
        return;
      }

      relatedPanel.setAttribute("aria-busy", "true");
      if (relatedLoading) relatedLoading.classList.add("is-visible");
      const res = await fetch(relatedUrl, {
        headers: { "HX-Request": "true" },
      });
      relatedPanel.innerHTML = await res.text();
    } catch {
      renderEmptyRelatedState();
    } finally {
      relatedPanel.removeAttribute("aria-busy");
      if (relatedLoading) relatedLoading.classList.remove("is-visible");
    }
  }

  function selectCard(card, opts = {}) {
    if (!card) return;
    clearSelection();
    selectedCard = card;
    card.classList.add("selected");
    if (opts.loadRelated !== false) {
      void loadRelated(card);
    }
    if (opts.scroll !== false) {
      card.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }

  function createNewNoteCard() {
    const article = document.createElement("article");
    article.id = "workspace-new-note";
    article.className = "note-card new-note-card";
    article.dataset.noteCard = "true";
    article.dataset.noteState = "new";
    article.dataset.createdAt = new Date().toISOString();
    article.innerHTML = `
      <div class="note-card-header">
        <div>
          <span class="note-time">New note</span>
          <h2>Untitled</h2>
        </div>
        <button type="button" class="focus-toggle" data-focus-toggle="true">Focus</button>
      </div>
      <div class="note-preview-shell">
        <p class="note-preview">Press Enter and start typing.</p>
      </div>
      <div class="note-edit-shell">
        <div class="note-toolbar" role="toolbar" aria-label="Markdown tools">
          <button type="button" class="secondary note-tool" data-editor-command="heading" data-editor-value="1">H1</button>
          <button type="button" class="secondary note-tool" data-editor-command="heading" data-editor-value="2">H2</button>
          <button type="button" class="secondary note-tool" data-editor-command="heading" data-editor-value="3">H3</button>
          <button type="button" class="secondary note-tool" data-editor-command="bold">Bold</button>
          <button type="button" class="secondary note-tool" data-editor-command="italic">Italic</button>
          <button type="button" class="secondary note-tool" data-editor-command="bullet">Bullet</button>
          <button type="button" class="secondary note-tool" data-editor-command="quote">Quote</button>
          <button type="button" class="secondary note-tool" data-editor-command="link">Link</button>
          <button type="button" class="secondary note-tool" data-editor-command="code">Code</button>
          <button type="button" class="secondary note-tool" data-editor-command="codeblock">Fence</button>
        </div>
        <div class="note-edit-host"></div>
        <div class="note-edit-actions">
          <button type="button" data-save-note="true">Save</button>
          <button type="button" class="secondary" data-exit-edit="true">Done</button>
          <button type="button" class="secondary" data-focus-toggle="true">Focus</button>
          <span class="note-save-status" aria-live="polite"></span>
        </div>
      </div>
      <textarea class="note-body-source" hidden></textarea>
    `;
    return article;
  }

  function hydrateSavedCard(card, item) {
    card.id = `note-${item.filename.replace(/[^a-zA-Z0-9_-]+/g, "-")}`;
    card.dataset.noteState = "saved";
    card.dataset.filename = item.filename;
    card.dataset.noteUrl = `/notes/${encodeURIComponent(item.filename)}`;
    card.dataset.relatedUrl = `/notes/${encodeURIComponent(item.filename)}/related`;
    card.dataset.saveUrl = `/notes/${encodeURIComponent(item.filename)}/save`;
    card.dataset.createdAt = item.createdAt;
    card.classList.remove("new-note-card");
    card.querySelector(".note-time").textContent = item.createdAt;
    card.querySelector("h2").textContent = item.title;

    const metaRow = card.querySelector(".note-meta-row") || document.createElement("div");
    metaRow.className = "note-meta-row";
    metaRow.innerHTML = `
      <div class="pill-row">${item.tags.length > 0 ? item.tags.map((tag) => `<a class="pill" href="/entity/${tag.id}">${tag.name}</a>`).join("") : '<span class="muted">No tags yet</span>'}</div>
      <span class="sync-pill">${item.isSynced ? "Synced" : "Pending sync"}</span>
    `;
    const header = card.querySelector(".note-card-header");
    if (!card.querySelector(".note-meta-row")) {
      header.insertAdjacentElement("afterend", metaRow);
    }

    const body = stripManagedFrontmatter(item.body);
    previewNode(card).textContent = item.preview || derivePreview(body);
    bodySource(card).value = body;
    card.dataset.savedBody = body;

    const actions = card.querySelector(".note-edit-actions");
    if (!actions.querySelector(".secondary-link")) {
      const link = document.createElement("a");
      link.className = "secondary-link";
      link.href = card.dataset.noteUrl;
      link.textContent = "Open";
      actions.insertBefore(link, statusNode(card));
    } else {
      actions.querySelector(".secondary-link").href = card.dataset.noteUrl;
    }
  }

  function exitEditor(opts = {}) {
    if (!editorState) return;
    const { card, editor } = editorState;
    if (editorState.autosaveTimer) {
      clearTimeout(editorState.autosaveTimer);
    }
    editor.destroy();
    editorState = null;
    card.classList.remove("editing");
    if (opts.clearFocusMode) {
      root.classList.remove("focus-mode");
      noteCards().forEach((item) => {
        item.hidden = false;
        item.classList.remove("focus-target");
      });
    }
  }

  function scheduleAutosave(card) {
    if (!editorState || editorState.card !== card) return;
    if (editorState.autosaveTimer) clearTimeout(editorState.autosaveTimer);
    editorState.autosaveTimer = setTimeout(() => {
      void saveCard(card);
    }, 3000);
  }

  async function saveCard(card, opts = {}) {
    if (!editorState || editorState.card !== card) return;
    if (editorState.savePromise) return editorState.savePromise;
    if (editorState.autosaveTimer) {
      clearTimeout(editorState.autosaveTimer);
      editorState.autosaveTimer = null;
    }
    const content = stripManagedFrontmatter(editorState.editor.getValue());
    const isNew = card.dataset.noteState === "new";
    const normalizedContent = normalizeEditorBody(content);
    if (!content.trim()) {
      editorState.saveFailed = true;
      setStatus(card, "Note content cannot be empty.", "error");
      return;
    }

    setStatus(card, "Saving…", "saving");
    const url = isNew ? "/notes/new" : card.dataset.saveUrl;
    editorState.savePromise = (async () => {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          keepalive: Boolean(opts.keepalive),
          body: JSON.stringify({ content }),
        });

        if (!res.ok) {
          const text = await res.text();
          editorState.saveFailed = true;
          setStatus(card, text || "Save failed.", "error");
          return false;
        }

        const item = await res.json();
        hydrateSavedCard(card, item);
        const latestBody = normalizeEditorBody(editorState?.editor?.getValue() ?? content);
        if (editorState && editorState.card === card) {
          editorState.initialBody = normalizedContent;
          editorState.dirty = latestBody !== normalizedContent;
          editorState.saveFailed = false;
          if (editorState.dirty) {
            bodySource(card).value = latestBody;
            updateCardDraftPresentation(card, latestBody);
            scheduleAutosave(card);
          }
        }
        setStatus(card, `Saved ${new Date().toLocaleTimeString()}`, "saved");
        if (isNew) {
          const feed = document.getElementById("notes-feed");
          feed.insertBefore(createNewNoteCard(), feed.firstChild);
        }
        void loadRelated(card);
        return true;
      } catch {
        editorState.saveFailed = true;
        setStatus(card, "Autosave failed. Your note is still local in the editor.", "error");
        return false;
      } finally {
        if (editorState && editorState.card === card) {
          editorState.savePromise = null;
        }
      }
    })();
    return editorState.savePromise;
  }

  async function flushEditorBeforeNavigate() {
    if (!editorState || !editorState.dirty) return true;
    return Boolean(await saveCard(editorState.card, { keepalive: true }));
  }

  async function enterEditor(card) {
    if (editorState && editorState.card === card) return;
    exitEditor();
    selectCard(card);
    const host = card.querySelector(".note-edit-host");
    const body = stripManagedFrontmatter(bodySource(card).value);
    const module = await ensureEditorModule();
    card.classList.add("editing");
    const editor = module.initEditor(host, body, (nextValue) => {
      bodySource(card).value = nextValue;
      updateCardDraftPresentation(card, nextValue);
      if (editorState && editorState.card === card) {
        editorState.dirty = normalizeEditorBody(nextValue) !== editorState.initialBody;
        editorState.saveFailed = false;
      }
      scheduleAutosave(card);
    });
    editorState = {
      card,
      editor,
      autosaveTimer: null,
      initialBody: normalizeEditorBody(body),
      dirty: false,
      saveFailed: false,
      savePromise: null,
    };
    editor.focus();
  }

  function ensureTerminalLoaded() {
    if (!(terminalFrame instanceof HTMLIFrameElement)) return;
    if (terminalFrame.dataset.loaded === "true") return;
    const src = terminalFrame.dataset.src;
    if (!src) return;
    terminalFrame.src = src;
    terminalFrame.dataset.loaded = "true";
  }

  function toggleFocus(card) {
    const focused = root.classList.contains("focus-mode") && card.classList.contains("focus-target");
    noteCards().forEach((item) => {
      item.classList.remove("focus-target");
      item.hidden = false;
    });
    if (focused) {
      root.classList.remove("focus-mode");
      return;
    }
    root.classList.add("focus-mode");
    noteCards().forEach((item) => {
      item.hidden = item !== card;
    });
    selectCard(card);
    card.classList.add("focus-target");
  }

  function moveSelection(step) {
    const cards = visibleCards();
    if (cards.length === 0) return;
    const current = selectedCard ? cards.indexOf(selectedCard) : -1;
    const next = current < 0 ? 0 : Math.max(0, Math.min(cards.length - 1, current + step));
    selectCard(cards[next]);
  }

  document.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const link = target.closest("a[href]");
    if (link instanceof HTMLAnchorElement) {
      const href = link.getAttribute("href") || "";
      if (
        link.target === "_blank" ||
        href.startsWith("#") ||
        href.startsWith("javascript:") ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) return;
      if (editorState?.dirty) {
        event.preventDefault();
        const saved = await flushEditorBeforeNavigate();
        if (saved) window.location.assign(link.href);
      }
      return;
    }
    const card = target.closest("[data-note-card='true']");
    if (!card) return;

    const commandButton = target.closest("[data-editor-command]");
    if (commandButton instanceof HTMLElement) {
      event.preventDefault();
      if (!editorState || editorState.card !== card) {
        await enterEditor(card);
      }
      editorState?.editor.run(commandButton.dataset.editorCommand, commandButton.dataset.editorValue);
      return;
    }

    if (target.closest("[data-focus-toggle='true']")) {
      event.preventDefault();
      toggleFocus(card);
      return;
    }
    if (target.closest("[data-exit-edit='true']")) {
      event.preventDefault();
      exitEditor();
      selectCard(card);
      return;
    }
    if (target.closest("[data-save-note='true']")) {
      event.preventDefault();
      void saveCard(card);
      return;
    }

    selectCard(card);
  });

  document.addEventListener("keydown", (event) => {
    if (!root) return;
    if (event.metaKey && event.key.toLowerCase() === "s") {
      if (editorState) {
        event.preventDefault();
        void saveCard(editorState.card);
      }
      return;
    }
    if (event.key === "Escape") {
      if (root.classList.contains("focus-mode")) {
        event.preventDefault();
        root.classList.remove("focus-mode");
        noteCards().forEach((item) => {
          item.hidden = false;
          item.classList.remove("focus-target");
        });
      }
      if (editorState) {
        event.preventDefault();
        const card = editorState.card;
        exitEditor();
        selectCard(card);
      }
      return;
    }
    if (editorState) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveSelection(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveSelection(-1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (selectedCard) void enterEditor(selectedCard);
    }
  });

  window.addEventListener("beforeunload", (event) => {
    if (!editorHasFailedSave()) return;
    event.preventDefault();
    event.returnValue = "";
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "hidden") return;
    if (editorState?.dirty && !editorState.saveFailed) {
      void saveCard(editorState.card, { keepalive: true });
    }
  });

  sidebar?.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const button = target.closest("[data-sidebar-view]");
    if (!button) return;
    const view = button.dataset.sidebarView;
    sidebar.dataset.view = view;
    sidebar.querySelectorAll("[data-sidebar-view]").forEach((node) => node.classList.remove("active"));
    button.classList.add("active");
    if (view === "terminal" || view === "both") ensureTerminalLoaded();
  });

  document.body.addEventListener("htmx:afterSwap", (event) => {
    const target = event.target;
    if (target instanceof HTMLElement && target.id === "notes-feed-more") {
      if (!selectedCard) {
        selectCard(noteCards()[0], { scroll: false, loadRelated: false });
      }
    }
  });

  const initialFilename = root.dataset.selectedFilename;
  const initialCard = initialFilename
    ? noteCards().find((card) => card.dataset.filename === initialFilename)
    : document.getElementById("workspace-new-note");

  selectCard(initialCard || noteCards()[0], { scroll: false });
  if (sidebar?.dataset.view === "terminal" || sidebar?.dataset.view === "both") {
    ensureTerminalLoaded();
  }

  if (initialFilename && (noteMode() === "edit" || noteMode() === "focus")) {
    if (noteMode() === "focus") {
      toggleFocus(initialCard);
    }
    void enterEditor(initialCard);
  }
}
