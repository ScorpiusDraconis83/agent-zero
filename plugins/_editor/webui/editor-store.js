import { createStore } from "/js/AlpineStore.js";
import { callJsonApi } from "/js/api.js";
import { getNamespacedClient } from "/js/websocket.js";
import { store as fileBrowserStore } from "/components/modals/file-browser/file-browser-store.js";

const editorSocket = getNamespacedClient("/ws");
editorSocket.addHandlers(["ws_webui"]);

const SAVE_MESSAGE_MS = 1800;
const INPUT_PUSH_DELAY_MS = 650;
const MAX_HISTORY = 80;

function currentContextId() {
  try {
    return globalThis.getContext?.() || "";
  } catch {
    return "";
  }
}

function basename(path = "") {
  const value = String(path || "").split("?")[0].split("#")[0];
  return value.split("/").filter(Boolean).pop() || "Untitled";
}

function extensionOf(path = "") {
  const name = basename(path).toLowerCase();
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index + 1) : "";
}

function parentPath(path = "") {
  const normalized = String(path || "").split("?")[0].split("#")[0].replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return "/";
  return normalized.slice(0, index);
}

function uniqueTabId(session = {}) {
  return String(session.file_id || session.session_id || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
}

function editorContainsFocus(element) {
  const active = document.activeElement;
  return Boolean(element && active && (element === active || element.contains(active)));
}

function placeCaretAtEnd(element) {
  if (!element) return;
  if (element.tagName === "TEXTAREA" || element.tagName === "INPUT") {
    const length = element.value?.length || 0;
    element.selectionStart = length;
    element.selectionEnd = length;
    return;
  }
  const selection = globalThis.getSelection?.();
  const range = document.createRange?.();
  if (!selection || !range) return;
  range.selectNodeContents(element);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

function normalizeMarkdown(doc = {}) {
  const path = doc.path || "";
  const extension = String(doc.extension || extensionOf(path)).toLowerCase();
  return {
    ...doc,
    extension,
    title: doc.title || doc.basename || basename(path),
    basename: doc.basename || basename(path),
    path,
  };
}

function normalizeSession(payload = {}) {
  const document = normalizeMarkdown(payload.document || payload);
  return {
    ...payload,
    document,
    extension: String(payload.extension || document.extension || "").toLowerCase(),
    file_id: payload.file_id || document.file_id || "",
    path: document.path || payload.path || "",
    title: payload.title || document.title || document.basename || basename(document.path),
    tab_id: uniqueTabId(payload),
    text: String(payload.text || ""),
    dirty: Boolean(payload.dirty),
    active: Boolean(payload.active),
  };
}

function documentLabel(document = {}) {
  return document.title || document.basename || basename(document.path);
}

async function callEditor(action, payload = {}) {
  return await callJsonApi("/plugins/_editor/editor_session", {
    action,
    ctxid: currentContextId(),
    ...payload,
  });
}

async function requestEditor(eventType, payload = {}, timeoutMs = 5000) {
  const response = await editorSocket.request(eventType, {
    ctxid: currentContextId(),
    ...payload,
  }, { timeoutMs });
  const results = Array.isArray(response?.results) ? response.results : [];
  const first = results.find((item) => item?.ok === true && isEditorSocketData(item?.data))
    || results.find((item) => item?.ok === true);
  if (!first) {
    const error = results.find((item) => item?.error)?.error;
    throw new Error(error?.error || error?.code || `${eventType} failed`);
  }
  if (first.data?.editor_error) {
    const error = first.data.editor_error;
    throw new Error(error.error || error.code || `${eventType} failed`);
  }
  return first.data || {};
}

function isEditorSocketData(data) {
  if (!data || typeof data !== "object") return false;
  return (
    Object.prototype.hasOwnProperty.call(data, "editor_error")
    || Object.prototype.hasOwnProperty.call(data, "ok")
    || Object.prototype.hasOwnProperty.call(data, "session_id")
    || Object.prototype.hasOwnProperty.call(data, "document")
  );
}

const model = {
  status: null,
  tabs: [],
  activeTabId: "",
  session: null,
  loading: false,
  saving: false,
  dirty: false,
  error: "",
  message: "",
  pendingClose: null,
  editorText: "",
  _root: null,
  _mode: "modal",
  _initialized: false,
  _saveMessageTimer: null,
  _inputTimer: null,
  _history: [],
  _historyIndex: -1,
  _pendingFocus: false,
  _pendingFocusEnd: true,
  _focusAttempts: 0,
  _headerCleanup: null,
  _surfaceHandoff: false,

  async init() {
    if (this._initialized) return;
    this._initialized = true;
    await this.refresh();
  },

  async onMount(element = null, options = {}) {
    await this.init();
    if (element) this._root = element;
    this._mode = options?.mode === "canvas" ? "canvas" : "modal";
    if (this._mode === "modal") this.setupMarkdownModal(element);
    this.queueRender();
  },

  async onOpen(payload = {}) {
    await this.init();
    await this.refresh();
    if (payload?.path || payload?.file_id) {
      await this.openSession({
        path: payload.path || "",
        file_id: payload.file_id || "",
        refresh: payload.refresh === true,
        source: payload.source || "",
      });
    }
  },

  beforeHostHidden() {
    this.flushInput();
  },

  cleanup() {
    this.flushInput();
    this._headerCleanup?.();
    this._headerCleanup = null;
    if (this._mode === "modal") this._root = null;
  },

  beginSurfaceHandoff() {
    this._surfaceHandoff = true;
    this.flushInput();
  },

  finishSurfaceHandoff() {
    this._surfaceHandoff = false;
  },

  cancelSurfaceHandoff() {
    this._surfaceHandoff = false;
  },

  async refresh() {
    try {
      const status = await callEditor("status");
      this.status = status || {};
      this.error = "";
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
  },

  async create(kind = "document", format = "") {
    const fmt = "md";
    const title = this.defaultTitle(kind, fmt);
    await this.openSession({
      action: "create",
      kind: "document",
      format: fmt,
      title,
    });
  },

  async openFileBrowser() {
    let workdirPath = "/a0/usr/workdir";
    try {
      const response = await callJsonApi("settings_get", null);
      workdirPath = response?.settings?.workdir_path || workdirPath;
    } catch {
      try {
        const home = await callEditor("home");
        workdirPath = home?.path || workdirPath;
      } catch {
        // The file browser can still open with the static fallback.
      }
    }
    await fileBrowserStore.open(workdirPath);
  },

  async openPath(path) {
    await this.openSession({ path: String(path || "") });
  },

  async openSession(payload = {}) {
    this.loading = true;
    this.error = "";
    try {
      const response = await callEditor(payload.action || "open", payload);
      if (response?.ok === false) {
        this.error = response.error || "Markdown could not be opened.";
        return null;
      }
      if (response?.requires_desktop) {
        const document = normalizeMarkdown(response.document || response);
        this.setMessage(`${documentLabel(document)} uses the Desktop surface.`);
        await this.refresh();
        return response;
      }
      const session = normalizeSession(response);
      this.installSession(session);
      await this.refresh();
      return session;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      return null;
    } finally {
      this.loading = false;
    }
  },

  installSession(session) {
    const existingIndex = this.tabs.findIndex((tab) => (
      (session.file_id && tab.file_id === session.file_id)
      || (session.path && tab.path === session.path)
    ));
    if (existingIndex >= 0) {
      this.tabs.splice(existingIndex, 1, { ...this.tabs[existingIndex], ...session, tab_id: this.tabs[existingIndex].tab_id });
      this.activeTabId = this.tabs[existingIndex].tab_id;
    } else {
      this.tabs.push(session);
      this.activeTabId = session.tab_id;
    }
    this.selectTab(this.activeTabId);
  },

  selectTab(tabId, options = {}) {
    this.syncEditorText();
    const tab = this.tabs.find((item) => item.tab_id === tabId) || this.tabs[0] || null;
    this.session = tab;
    this.activeTabId = tab?.tab_id || "";
    this.editorText = String(tab?.text || "");
    this.dirty = Boolean(tab?.dirty);
    this.resetHistory(this.editorText);
    if (tab?.session_id) {
      requestEditor("editor_activate", { session_id: tab.session_id }, 2500).catch(() => {});
    }
    this.queueRender({ focus: Boolean(tab) && options.focus !== false });
  },

  ensureActiveTab() {
    if (this.session && this.tabs.some((tab) => tab.tab_id === this.session.tab_id)) return;
    if (this.tabs.length) this.selectTab(this.tabs[0].tab_id, { focus: false });
  },

  isActiveTab(tab) {
    return Boolean(tab && tab.tab_id === this.activeTabId);
  },

  isTabDirty(tab) {
    return Boolean(tab?.dirty || (this.isActiveTab(tab) && this.dirty));
  },

  hasPendingClose() {
    return Boolean(this.pendingClose);
  },

  pendingCloseTitle() {
    const pending = this.pendingClose;
    if (!pending) return "";
    if (pending.kind === "all") {
      return `Close ${pending.totalCount || 0} open files?`;
    }
    const tab = this.tabs.find((item) => item.tab_id === pending.tabId);
    return `Close ${this.tabTitle(tab || {})}?`;
  },

  pendingCloseMessage() {
    const pending = this.pendingClose;
    if (!pending) return "";
    const dirtyCount = Number(pending.dirtyCount || 0);
    if (pending.kind === "all") {
      if (dirtyCount === 0) return "All open Markdown files will be closed.";
      return `${dirtyCount} open ${dirtyCount === 1 ? "file has" : "files have"} unsaved changes.`;
    }
    if (dirtyCount > 0) return "This file has unsaved changes.";
    return "This file will be closed.";
  },

  pendingCloseHasDirty() {
    return Number(this.pendingClose?.dirtyCount || 0) > 0;
  },

  pendingCloseDiscardLabel() {
    return this.pendingCloseHasDirty() ? "Discard" : "Close";
  },

  beginCloseConfirmation(kind, tabIds = []) {
    const ids = tabIds.filter(Boolean);
    const tabs = ids.map((id) => this.tabs.find((tab) => tab.tab_id === id)).filter(Boolean);
    const dirtyCount = tabs.filter((tab) => this.isTabDirty(tab)).length;
    this.pendingClose = {
      kind,
      tabId: kind === "single" ? ids[0] || "" : "",
      tabIds: ids,
      totalCount: tabs.length,
      dirtyCount,
    };
    if (kind === "single" && ids[0]) {
      this.selectTab(ids[0], { focus: false });
    }
  },

  cancelPendingClose() {
    this.pendingClose = null;
  },

  async confirmPendingClose(options = {}) {
    const pending = this.pendingClose;
    if (!pending || this.loading) return;
    this.pendingClose = null;
    const save = options.save === true;
    if (pending.kind === "all") {
      await this.closeAllFiles({ confirm: false, save, tabIds: pending.tabIds || [] });
      return;
    }
    await this.closeTab(pending.tabId, { confirm: false, save });
  },

  async closeTab(tabId, options = {}) {
    const tab = this.tabs.find((item) => item.tab_id === tabId);
    if (!tab) return;
    if (this.isTabDirty(tab) && options.confirm !== false) {
      this.beginCloseConfirmation("single", [tab.tab_id]);
      return;
    }
    await this.closeTabNow(tab, { save: options.save === true });
  },

  async closeTabNow(tab, options = {}) {
    if (!tab || this.loading) return false;
    const tabId = tab.tab_id;
    if (options.save === true && this.isTabDirty(tab)) {
      const saved = await this.saveTab(tab);
      if (!saved) return false;
    }
    try {
      if (tab.session_id) {
        await requestEditor("editor_close", { session_id: tab.session_id }, 2500).catch(() => null);
      }
      await callEditor("close", {
        session_id: tab.session_id || "",
        store_session_id: tab.store_session_id || "",
        file_id: tab.file_id || "",
      });
    } catch (error) {
      console.warn("Markdown close skipped", error);
    }
    this.tabs = this.tabs.filter((item) => item.tab_id !== tabId);
    if (this.pendingClose?.tabId === tabId || this.pendingClose?.tabIds?.includes(tabId)) {
      this.pendingClose = null;
    }
    if (this.activeTabId === tabId) {
      this.session = null;
      this.activeTabId = "";
      this.editorText = "";
      this.dirty = false;
      this.ensureActiveTab();
    }
    this.ensureActiveTab();
    await this.refresh();
    return true;
  },

  async closeActiveFile() {
    if (!this.session || this.loading) return;
    await this.closeTab(this.session.tab_id);
  },

  async closeAllFiles(options = {}) {
    if (this.loading) return;
    const requestedIds = Array.isArray(options.tabIds) && options.tabIds.length
      ? options.tabIds
      : this.visibleTabs().map((tab) => tab.tab_id);
    const tabs = requestedIds.map((id) => this.tabs.find((tab) => tab.tab_id === id)).filter(Boolean);
    if (!tabs.length) return;

    const dirtyTabs = tabs.filter((tab) => this.isTabDirty(tab));
    if (dirtyTabs.length && options.confirm !== false) {
      this.beginCloseConfirmation("all", tabs.map((tab) => tab.tab_id));
      return;
    }

    this.pendingClose = null;
    for (const tab of [...tabs]) {
      const current = this.tabs.find((item) => item.tab_id === tab.tab_id);
      if (!current) continue;
      const closed = await this.closeTabNow(current, {
        save: options.save === true && this.isTabDirty(current),
      });
      if (!closed) break;
    }
  },

  async save() {
    if (!this.session || this.saving || !this.isMarkdown()) return;
    this.syncEditorText();
    this.saving = true;
    this.error = "";
    try {
      let response;
      const payload = { session_id: this.session.session_id, text: this.editorText };
      try {
        response = await requestEditor("editor_save", payload, 10000);
      } catch (_socketError) {
        response = await callEditor("save", payload);
      }
      if (response?.ok === false) throw new Error(response.error || "Save failed.");
      const document = normalizeMarkdown(response.document || this.session.document || {});
      const updated = {
        ...this.session,
        text: this.editorText,
        dirty: false,
        document,
        path: document.path || this.session.path,
        file_id: document.file_id || this.session.file_id,
        version: document.version || response.version || this.session.version,
      };
      this.replaceActiveSession(updated);
      this.dirty = false;
      this.setMessage("Saved");
      await this.refresh();
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.saving = false;
    }
  },

  async saveTab(tab) {
    if (!tab || this.saving || !this.isMarkdown(tab)) return false;
    if (this.isActiveTab(tab)) {
      this.syncEditorText();
    }
    this.saving = true;
    this.error = "";
    try {
      let response;
      const payload = {
        session_id: tab.session_id,
        text: this.isActiveTab(tab) ? this.editorText : String(tab.text || ""),
      };
      try {
        response = await requestEditor("editor_save", payload, 10000);
      } catch (_socketError) {
        response = await callEditor("save", payload);
      }
      if (response?.ok === false) throw new Error(response.error || "Save failed.");
      const document = normalizeMarkdown(response.document || tab.document || {});
      const updated = {
        ...tab,
        text: payload.text,
        dirty: false,
        document,
        path: document.path || tab.path,
        file_id: document.file_id || tab.file_id,
        version: document.version || response.version || tab.version,
      };
      this.replaceSession(tab, updated);
      if (this.isActiveTab(updated)) {
        this.dirty = false;
      }
      this.setMessage("Saved");
      await this.refresh();
      return true;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      return false;
    } finally {
      this.saving = false;
    }
  },

  async renameActiveFile() {
    if (!this.session || this.saving) return;
    const session = this.session;
    const path = session.path || session.document?.path || "";
    if (!path) {
      this.error = "This document does not have a file path to rename.";
      return;
    }
    const name = basename(path || session.title || "");
    const extension = extensionOf(name);
    await fileBrowserStore.openRenameModal(
      {
        name,
        path,
        is_dir: false,
        size: session.document?.size || 0,
        modified: session.document?.last_modified || "",
        type: "document",
      },
      {
        currentPath: parentPath(path),
        validateName: (newName) => {
          if (!extension) return true;
          return extensionOf(newName) === extension || `Keep the .${extension} extension for this open document.`;
        },
        performRename: async ({ path: renamedPath }) => {
          const payload = {
            file_id: session.file_id || "",
            path: renamedPath,
          };
          if (this.isMarkdown(session)) {
            this.syncEditorText();
            payload.text = this.session?.tab_id === session.tab_id ? this.editorText : session.text || "";
          }
          return await callEditor("renamed", payload);
        },
        onRenamed: async ({ path: renamedPath, response }) => {
          await this.handleActiveFileRenamed(session, renamedPath, response);
        },
      },
    );
  },

  async handleActiveFileRenamed(session, renamedPath, renameResponse = null) {
    const response = renameResponse || await callEditor("renamed", {
      file_id: session.file_id || "",
      path: renamedPath,
    });
    if (response?.ok === false) throw new Error(response.error || "Rename failed.");

    const document = normalizeMarkdown(response.document || session.document || {});
    const updated = {
      ...session,
      document,
      title: document.title || document.basename || basename(document.path),
      path: document.path || renamedPath,
      extension: document.extension || session.extension,
      file_id: document.file_id || session.file_id,
      version: document.version || response.version || session.version,
      text: this.session?.tab_id === session.tab_id ? this.editorText : session.text,
      dirty: false,
    };
    this.replaceSession(session, updated);
    this.dirty = false;
    this.setMessage("Renamed");
    await this.refresh();
  },

  replaceActiveSession(next) {
    if (!this.session) return;
    this.replaceSession(this.session, next);
  },

  replaceSession(previous, next) {
    const wasActive = this.activeTabId === (previous?.tab_id || next.tab_id);
    if (wasActive) this.session = next;
    const index = this.tabs.findIndex((tab) => tab.tab_id === (previous?.tab_id || next.tab_id));
    if (index >= 0) this.tabs.splice(index, 1, next);
    this.queueRender();
  },

  setMessage(value) {
    this.message = value;
    if (this._saveMessageTimer) globalThis.clearTimeout(this._saveMessageTimer);
    this._saveMessageTimer = globalThis.setTimeout(() => {
      this.message = "";
      this._saveMessageTimer = null;
    }, SAVE_MESSAGE_MS);
  },

  resetHistory(text) {
    this._history = [String(text || "")];
    this._historyIndex = 0;
  },

  pushHistory(text) {
    const value = String(text || "");
    if (this._history[this._historyIndex] === value) return;
    this._history = this._history.slice(0, this._historyIndex + 1);
    this._history.push(value);
    if (this._history.length > MAX_HISTORY) this._history.shift();
    this._historyIndex = this._history.length - 1;
  },

  undo() {
    if (this._historyIndex <= 0) return;
    this._historyIndex -= 1;
    this.applyEditorText(this._history[this._historyIndex], true);
  },

  redo() {
    if (this._historyIndex >= this._history.length - 1) return;
    this._historyIndex += 1;
    this.applyEditorText(this._history[this._historyIndex], true);
  },

  canUndo() {
    return this._historyIndex > 0;
  },

  canRedo() {
    return this._historyIndex < this._history.length - 1;
  },

  applyEditorText(text, markDirty = false) {
    this.editorText = String(text || "");
    if (this.session) {
      this.session.text = this.editorText;
      this.session.dirty = markDirty || this.session.dirty;
    }
    if (markDirty) this.markDirty();
    this.queueRender({ force: true, focus: true });
  },

  markDirty() {
    this.dirty = true;
    if (this.session) this.session.dirty = true;
  },

  onSourceInput() {
    this.markDirty();
    this.pushHistory(this.editorText);
    this.scheduleInputPush();
  },

  syncEditorText() {
    if (!this.session) return;
    this.session.text = this.editorText;
  },

  scheduleInputPush() {
    if (!this.session?.session_id || !this.isMarkdown()) return;
    if (this._inputTimer) globalThis.clearTimeout(this._inputTimer);
    this._inputTimer = globalThis.setTimeout(() => {
      this._inputTimer = null;
      this.flushInput();
    }, INPUT_PUSH_DELAY_MS);
  },

  flushInput() {
    if (!this.session?.session_id || !this.isMarkdown()) return;
    this.syncEditorText();
    requestEditor("editor_input", {
      session_id: this.session.session_id,
      text: this.editorText,
    }, 3000).catch(() => {});
  },

  format(command) {
    if (!this.session || !this.isMarkdown()) return;
    const textarea = this._root?.querySelector?.("[data-editor-source]");
    if (!textarea) return;
    const start = textarea.selectionStart || 0;
    const end = textarea.selectionEnd || start;
    const selected = this.editorText.slice(start, end);
    let replacement = selected;
    if (command === "bold") replacement = `**${selected || "text"}**`;
    if (command === "italic") replacement = `*${selected || "text"}*`;
    if (command === "list") replacement = (selected || "item").split("\n").map((line) => `- ${line.replace(/^[-*]\s+/, "")}`).join("\n");
    if (command === "numbered") replacement = (selected || "item").split("\n").map((line, index) => `${index + 1}. ${line.replace(/^\d+\.\s+/, "")}`).join("\n");
    if (command === "table") replacement = "| Column | Value |\n| --- | --- |\n|  |  |";
    if (replacement === selected) return;
    this.editorText = `${this.editorText.slice(0, start)}${replacement}${this.editorText.slice(end)}`;
    this.onSourceInput();
    globalThis.requestAnimationFrame?.(() => {
      textarea.focus();
      textarea.selectionStart = start;
      textarea.selectionEnd = start + replacement.length;
    });
  },

  queueRender(options = {}) {
    if (options.focus) {
      this._pendingFocus = true;
      this._pendingFocusEnd = options.end !== false;
      this._focusAttempts = 0;
    }
    const render = () => {
      if (this._pendingFocus && this.focusEditor({ end: this._pendingFocusEnd })) {
        this._pendingFocus = false;
        this._focusAttempts = 0;
      } else if (this._pendingFocus && this._focusAttempts < 6) {
        this._focusAttempts += 1;
        globalThis.setTimeout(render, 45);
      }
    };
    if (globalThis.requestAnimationFrame) {
      globalThis.requestAnimationFrame(render);
    } else {
      globalThis.setTimeout(render, 0);
    }
  },

  focusEditor(options = {}) {
    if (!this.session || !this.isMarkdown()) return false;
    const source = this._root?.querySelector?.("[data-editor-source]");
    if (!source) return false;
    source.focus?.({ preventScroll: true });
    if (!editorContainsFocus(source)) return false;
    if (options.end !== false) placeCaretAtEnd(source);
    return true;
  },

  isMarkdown(tab = this.session) {
    const ext = String(tab?.extension || tab?.document?.extension || "").toLowerCase();
    return ext === "md";
  },

  hasActiveFile(tab = this.session) {
    return Boolean(tab && this.isMarkdown(tab));
  },

  visibleTabs() {
    return this.tabs.filter((tab) => this.hasActiveFile(tab));
  },

  defaultTitle(kind, fmt) {
    const date = new Date().toISOString().slice(0, 10);
    if (fmt === "md") return `Markdown ${date}`;
    return `Markdown ${date}`;
  },

  tabTitle(tab = {}) {
    tab = tab || {};
    return tab.title || tab.document?.basename || basename(tab.path);
  },

  tabLabel(tab = {}) {
    tab = tab || {};
    const title = this.tabTitle(tab);
    return tab.dirty ? `${title} unsaved` : title;
  },

  tabIcon(tab = {}) {
    tab = tab || {};
    const ext = String(tab.extension || tab.document?.extension || "").toLowerCase();
    if (ext === "md") return "article";
    return "draft";
  },

  async runNewMenuAction(action = "") {
    const normalized = String(action || "").trim().toLowerCase();
    if (normalized === "open") return await this.openFileBrowser();
    if (normalized === "markdown") return await this.create("document", "md");
    return null;
  },

  installHeaderNewMenu(header = null) {
    if (!header || header.querySelector(".editor-header-actions")) return () => {};

    const root = document.createElement("div");
    root.className = "editor-header-actions";
    root.innerHTML = `
      <button type="button" class="editor-header-new-button" aria-haspopup="menu" aria-expanded="false">
        <span class="material-symbols-outlined" aria-hidden="true">add</span>
        <span>New</span>
        <span class="material-symbols-outlined editor-new-chevron" aria-hidden="true">expand_more</span>
      </button>
      <div class="editor-new-menu" role="menu" hidden>
        <button type="button" class="editor-new-menu-item" role="menuitem" data-editor-new-action="open">
          <span class="material-symbols-outlined" aria-hidden="true">folder_open</span>
          <span>Open</span>
        </button>
        <button type="button" class="editor-new-menu-item" role="menuitem" data-editor-new-action="markdown">
          <span class="material-symbols-outlined" aria-hidden="true">article</span>
          <span>Markdown</span>
        </button>
      </div>
    `;

    const button = root.querySelector(".editor-header-new-button");
    const menu = root.querySelector(".editor-new-menu");
    const setOpen = (open) => {
      root.classList.toggle("is-open", open);
      button?.setAttribute("aria-expanded", open.toString());
      if (menu) menu.hidden = !open;
    };
    const onButtonClick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      setOpen(!root.classList.contains("is-open"));
    };
    const onMarkdownClick = (event) => {
      if (!root.contains(event.target)) setOpen(false);
    };
    const onMarkdownKeydown = (event) => {
      if (event.key === "Escape") setOpen(false);
    };

    button?.addEventListener("click", onButtonClick);
    for (const item of root.querySelectorAll("[data-editor-new-action]")) {
      item.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        const action = event.currentTarget?.dataset?.editorNewAction || "";
        setOpen(false);
        await this.runNewMenuAction(action);
      });
    }
    document.addEventListener("click", onMarkdownClick);
    document.addEventListener("keydown", onMarkdownKeydown);

    const firstHeaderAction = header.querySelector(".modal-close");
    if (firstHeaderAction) {
      firstHeaderAction.insertAdjacentElement("beforebegin", root);
    } else {
      header.appendChild(root);
    }

    setOpen(false);
    return () => {
      button?.removeEventListener("click", onButtonClick);
      document.removeEventListener("click", onMarkdownClick);
      document.removeEventListener("keydown", onMarkdownKeydown);
      root.remove();
    };
  },

  setupMarkdownModal(element = null) {
    const root = element || document.querySelector(".editor-panel");
    const inner = root?.closest?.(".modal-inner");
    const header = inner?.querySelector?.(".modal-header");
    if (!inner || !header || inner.dataset.editorModalReady === "1") return;
    inner.dataset.editorModalReady = "1";
    inner.classList.add("editor-modal");
    const cleanup = [];
    const closeButton = inner.querySelector(".modal-close");
    const focusButton = document.createElement("button");
    focusButton.type = "button";
    focusButton.className = "modal-dock-button editor-modal-focus-button";
    focusButton.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">fullscreen</span>';
    const updateFocusButton = (active) => {
      const label = active ? "Restore size" : "Focus mode";
      focusButton.setAttribute("aria-label", label);
      focusButton.setAttribute("title", label);
      focusButton.querySelector(".material-symbols-outlined").textContent = active ? "fullscreen_exit" : "fullscreen";
    };
    updateFocusButton(false);
    const onFocusClick = () => {
      const active = !inner.classList.contains("is-focus-mode");
      inner.classList.toggle("is-focus-mode", active);
      updateFocusButton(active);
    };
    focusButton.addEventListener("click", onFocusClick);
    if (closeButton) {
      closeButton.insertAdjacentElement("beforebegin", focusButton);
    } else {
      header.appendChild(focusButton);
    }
    cleanup.push(() => focusButton.removeEventListener("click", onFocusClick));
    cleanup.push(() => focusButton.remove());

    this._headerCleanup = () => {
      cleanup.splice(0).reverse().forEach((entry) => entry());
      delete inner.dataset.editorModalReady;
      inner.classList.remove("editor-modal", "is-focus-mode");
    };
    const menuCleanup = this.installHeaderNewMenu(header);
    const previousCleanup = this._headerCleanup;
    this._headerCleanup = () => {
      menuCleanup?.();
      previousCleanup?.();
    };
  },
};

export const store = createStore("editor", model);
