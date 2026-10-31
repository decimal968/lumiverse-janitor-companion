// JanitorAI Companion for Lumiverse (frontend only, no build step).
//
// 1. Opens JanitorAI in its own window docked beside Lumiverse. JanitorAI cannot
//    be framed inside a Lumiverse extension (raw iframes are blocked by Spindle),
//    and a real top-level window is also what lets the JAI Exporter browser
//    extension run on it untouched.
// 2. Imports the .charx / .json cards that JAI Exporter produces, using the same
//    same-origin Lumiverse endpoints the Datacat extension uses.

const HOME_URL = "https://janitorai.com/";
const WINDOW_NAME = "lumiverse-janitorai";
const IMAGE_MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
};

const ICON = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="14" rx="2"/><path d="M8 21h8M12 18v3"/><path d="M14 9l3 2-3 2"/></svg>`;

// ---------- CHARX / ZIP reading (stored + deflate, no dependencies) ----------

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readZip(buffer) {
  const u8 = new Uint8Array(buffer);
  const dv = new DataView(buffer);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a valid .charx / ZIP file.");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("Corrupt ZIP directory.");
    const method = dv.getUint16(p + 10, true);
    const size = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const offset = dv.getUint32(p + 42, true);
    const name = decoder.decode(u8.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    const start = offset + 30 + dv.getUint16(offset + 26, true) + dv.getUint16(offset + 28, true);
    const raw = u8.subarray(start, start + size);
    entries.set(name, async () => {
      if (method === 0) return raw.slice();
      if (method === 8) return inflateRaw(raw);
      throw new Error(`Unsupported ZIP compression method ${method}.`);
    });
  }
  return entries;
}

function extOf(name) {
  const m = /\.([A-Za-z0-9]+)$/.exec(name);
  return m ? m[1].toLowerCase() : "";
}

// Drop base64 gallery images from extensions.assets: they bloat the import body
// and Lumiverse has no use for them. Returns how many were removed.
function prepareCard(raw) {
  const card = JSON.parse(JSON.stringify(raw));
  let stripped = 0;
  for (const holder of [card.extensions, card.data && card.data.extensions]) {
    if (!holder || !Array.isArray(holder.assets)) continue;
    const keep = holder.assets.filter((a) => !(a && typeof a.data === "string" && a.data.startsWith("data:")));
    stripped += holder.assets.length - keep.length;
    if (keep.length) holder.assets = keep;
    else delete holder.assets;
  }
  return { card, stripped };
}

function cardName(card) {
  return String((card.data && card.data.name) || card.name || "Imported character");
}

// Returns { card, avatar: File|null, stripped, galleryImages }
async function readCardFile(file) {
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".json")) {
    const { card, stripped } = prepareCard(JSON.parse(await file.text()));
    return { card, avatar: null, stripped, galleryImages: 0 };
  }
  const entries = await readZip(await file.arrayBuffer());
  const cardKey = [...entries.keys()].find((k) => k.toLowerCase() === "card.json");
  if (!cardKey) throw new Error("No card.json inside this archive.");
  const json = JSON.parse(new TextDecoder().decode(await entries.get(cardKey)()));
  const { card, stripped } = prepareCard(json);
  const avatarKey = [...entries.keys()].find((k) => /^avatar\.[a-z0-9]+$/i.test(k) && IMAGE_MIME[extOf(k)]);
  let avatar = null;
  if (avatarKey) {
    const ext = extOf(avatarKey);
    avatar = new File([await entries.get(avatarKey)()], `avatar.${ext}`, { type: IMAGE_MIME[ext] });
  }
  const galleryImages = [...entries.keys()].filter((k) => /^assets\//i.test(k) && IMAGE_MIME[extOf(k)]).length;
  return { card, avatar, stripped, galleryImages };
}

// ---------- Lumiverse REST (same endpoints Datacat uses) ----------

async function apiJson(response) {
  let payload = {};
  try {
    payload = await response.json();
  } catch (_) {}
  if (!response.ok || (payload && payload.success === false)) {
    const detail = (payload && (payload.error || payload.message)) || response.statusText || "request failed";
    throw new Error(`Lumiverse ${response.status}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  }
  return payload;
}

async function importCharacter({ card, avatar }) {
  const created = await apiJson(
    await fetch("/api/v1/characters/import", {
      method: "POST",
      credentials: "include",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(card),
    }),
  );
  let character = created && created.character;
  if (!character || !character.id) throw new Error("Lumiverse created no usable character record.");
  if (avatar) {
    const form = new FormData();
    form.append("avatar", avatar);
    const updated = await apiJson(
      await fetch(`/api/v1/characters/${encodeURIComponent(character.id)}/avatar`, {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json" },
        body: form,
      }),
    );
    if (updated && updated.id) character = updated;
  }
  return character;
}

// ---------- UI ----------

const VERSION = "0.2.0";
const HISTORY_KEY = "janitor_companion.imports.v1";
const HISTORY_MAX = 30;

function isMobile() {
  try {
    return window.matchMedia("(pointer: coarse)").matches || /Android|iPhone|iPad/i.test(navigator.userAgent);
  } catch (_) {
    return false;
  }
}

function loadHistory() {
  try {
    const v = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    return Array.isArray(v) ? v : [];
  } catch (_) {
    return [];
  }
}

function saveHistory(items) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, HISTORY_MAX)));
  } catch (_) {}
}

const CSS = `
.jc-drawer-root { width: 100%; height: 100%; min-height: 0; display: flex; overflow: hidden; }
.jc-host { position: absolute !important; inset: 0 !important; width: auto !important; height: auto !important; min-height: 0 !important; display: flex !important; overflow: hidden !important; }
.jc-lumiverse-panel-header { display: none !important; }
.jc-lumiverse-panel-content { padding: 0 !important; overflow: hidden !important; }
.jc-root, .jc-root * { box-sizing: border-box; }
.jc-root {
  --jc-bg: #0f0c16; --jc-panel: #181222; --jc-panel-2: #21192e; --jc-border: rgba(196,150,255,.2);
  --jc-text: #f6f1ff; --jc-muted: #b4a9c4; --jc-accent: #c58cff; --jc-accent-ink: #1b0f2a;
  position: relative; width: 100%; height: 100%; min-height: 0; display: flex; flex-direction: column; overflow: hidden;
  color: var(--jc-text); font: inherit;
  background: radial-gradient(circle at 85% -20%, rgba(150,80,220,.34), transparent 42%), var(--jc-bg);
}
.jc-toolbar { flex: 0 0 auto; display: flex; align-items: center; gap: 6px; padding: 8px 8px 7px 14px; border-bottom: 1px solid var(--jc-border); background: rgba(15,12,22,.92); }
.jc-brand { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; color: var(--jc-accent); font-size: 15px; font-weight: 500; }
.jc-badge { padding: 2px 6px; border-radius: 999px; background: var(--jc-accent); color: var(--jc-accent-ink); font-size: 8px; line-height: 1; }
.jc-close { width: 30px; height: 30px; border: 0; background: transparent; color: var(--jc-muted); font-size: 27px; line-height: 1; cursor: pointer; }
.jc-close:hover { color: var(--jc-accent); }
.jc-tabs { flex: 0 0 auto; display: flex; gap: 4px; padding: 0 8px; border-bottom: 1px solid var(--jc-border); }
.jc-tab { flex: 1; padding: 11px 6px 9px; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--jc-muted); font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
.jc-tab[data-active="true"] { color: var(--jc-accent); border-bottom-color: var(--jc-accent); }
.jc-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 14px; }
.jc-scroll[hidden], .jc-pane[hidden] { display: none; }
.jc-pane { display: flex; flex-direction: column; gap: 14px; }
.jc-card { border: 1px solid var(--jc-border); border-radius: 14px; background: var(--jc-panel); padding: 16px; }
.jc-card h2 { margin: 0 0 6px; font-size: 17px; font-weight: 700; }
.jc-card p { margin: 0 0 12px; font-size: 13px; line-height: 1.55; color: var(--jc-muted); }
.jc-row { display: flex; gap: 8px; flex-wrap: wrap; }
.jc-btn { min-height: 36px; padding: 0 14px; border: 1px solid var(--jc-border); border-radius: 10px; background: var(--jc-panel-2); color: var(--jc-text); font: inherit; font-size: 13px; cursor: pointer; }
.jc-btn:hover { border-color: rgba(197,140,255,.6); }
.jc-btn[data-primary] { background: var(--jc-accent); border-color: var(--jc-accent); color: var(--jc-accent-ink); font-weight: 700; }
.jc-btn[data-primary]:hover { background: var(--jc-panel-2); color: var(--jc-accent); }
.jc-status { margin-top: 10px; min-height: 1.2em; font-size: 12px; color: var(--jc-muted); }
.jc-steps { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 10px; counter-reset: s; }
.jc-steps li { counter-increment: s; display: flex; gap: 10px; font-size: 13px; line-height: 1.5; color: var(--jc-muted); }
.jc-steps li::before { content: counter(s); flex: 0 0 22px; height: 22px; border-radius: 999px; background: var(--jc-panel-2); border: 1px solid var(--jc-border); color: var(--jc-accent); font-size: 12px; font-weight: 700; display: grid; place-items: center; }
.jc-steps b { color: var(--jc-text); font-weight: 600; }
.jc-drop { border: 1.5px dashed var(--jc-border); border-radius: 14px; padding: 26px 14px; text-align: center; font-size: 13px; color: var(--jc-muted); cursor: pointer; background: rgba(255,255,255,.02); }
.jc-drop[data-over] { border-color: var(--jc-accent); color: var(--jc-text); }
.jc-list { display: flex; flex-direction: column; gap: 8px; }
.jc-empty { padding: 18px 8px; text-align: center; font-size: 13px; color: var(--jc-muted); }
.jc-item { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid var(--jc-border); border-radius: 12px; background: var(--jc-panel); }
.jc-item-main { flex: 1; min-width: 0; }
.jc-item-title { font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.jc-item-sub { margin-top: 2px; font-size: 11px; color: var(--jc-muted); overflow-wrap: anywhere; }
.jc-item[data-state="error"] .jc-item-sub { color: #f0817c; }
.jc-item .jc-btn { min-height: 32px; padding: 0 12px; font-size: 12px; }
`;

export function setup(ctx) {
  let popup = null;
  const mobile = isMobile();
  // items: newest first. state: "done" (persisted) | "working" | "error" (session only)
  let items = loadHistory().map((h) => ({ ...h, state: "done" }));

  const tab = ctx.ui.registerDrawerTab({
    id: "janitor-companion",
    title: "JanitorAI",
    shortName: "JAI",
    headerTitle: "JanitorAI",
    description: "Open JanitorAI beside Lumiverse and import exported cards.",
    keywords: ["janitor", "janitorai", "jai", "import", "charx", "exporter"],
    iconSvg: ICON,
  });
  const removeStyle = ctx.dom.addStyle(CSS);

  tab.root.classList.add("jc-drawer-root");
  const root = document.createElement("section");
  root.className = "jc-root";
  root.innerHTML = `
    <header class="jc-toolbar">
      <div class="jc-brand"><span>JanitorAI</span><span class="jc-badge">v${VERSION}</span></div>
      <button class="jc-close" type="button" data-close aria-label="Close JanitorAI">×</button>
    </header>
    <nav class="jc-tabs" aria-label="JanitorAI companion view">
      <button class="jc-tab" type="button" data-view="browse" data-active="true">Browse</button>
      <button class="jc-tab" type="button" data-view="imports" data-active="false">Imports<span data-count></span></button>
    </nav>
    <div class="jc-scroll">
      <div class="jc-pane" data-pane="browse">
        <div class="jc-card">
          <h2>Browse JanitorAI</h2>
          <p data-browse-note></p>
          <div class="jc-row">
            <button class="jc-btn" type="button" data-primary data-act="open"></button>
            <button class="jc-btn" type="button" data-act="tab">Open in a tab</button>
          </div>
          <div class="jc-status" data-window-status></div>
        </div>
        <div class="jc-card">
          <h2>How it works</h2>
          <ol class="jc-steps">
            <li><span>Open JanitorAI and find a character.</span></li>
            <li><span data-step-export><b>Scan &amp; export</b> it with JAI Exporter (pick CHARX).</span></li>
            <li><span>Open <b>Imports</b> here and drop the file in. Then tap <b>Chat</b>.</span></li>
          </ol>
        </div>
      </div>
      <div class="jc-pane" data-pane="imports" hidden>
        <div class="jc-drop" data-drop>Drop .charx / .json files here or tap to choose</div>
        <input type="file" multiple accept=".charx,.zip,.json" hidden data-file />
        <div class="jc-list" data-list></div>
      </div>
    </div>
  `;
  tab.root.replaceChildren(root);

  const $ = (sel) => root.querySelector(sel);
  const windowStatus = $("[data-window-status]");
  const drop = $("[data-drop]");
  const fileInput = $("[data-file]");
  const list = $("[data-list]");
  const countEl = $("[data-count]");
  const openBtn = $('[data-act="open"]');
  const tabBtn = $('[data-act="tab"]');

  if (mobile) {
    $("[data-browse-note]").textContent =
      "Opens JanitorAI in a new tab. Use your browser's back button to return to Lumiverse. Browser extensions don't run on phone browsers, so capture cards with JAI Exporter on a desktop and import the files here.";
    openBtn.textContent = "Open JanitorAI";
    tabBtn.hidden = true;
  } else {
    $("[data-browse-note]").textContent =
      "Opens JanitorAI in its own window beside Lumiverse, so your JAI Exporter extension runs there as normal. Allow pop-ups for this site if nothing opens.";
    openBtn.textContent = "Open beside Lumiverse";
  }

  // ----- Lumiverse drawer frame takeover (same approach the Datacat extension uses) -----
  let raf = 0;
  let attempts = 0;
  let markedHost = null;
  let panelHeader = null;
  let panelContent = null;
  let drawerClose = null;

  const clearFrame = () => {
    if (markedHost) markedHost.classList.remove("jc-host");
    if (panelHeader) panelHeader.classList.remove("jc-lumiverse-panel-header");
    if (panelContent) panelContent.classList.remove("jc-lumiverse-panel-content");
    markedHost = panelHeader = panelContent = drawerClose = null;
  };
  const markHost = () => {
    const host = tab.root.parentElement;
    if (!host || !tab.root.isConnected) {
      clearFrame();
      if (attempts++ < 30) raf = requestAnimationFrame(markHost);
      return;
    }
    if (markedHost && markedHost !== host) clearFrame();
    markedHost = host;
    host.classList.add("jc-host");
    let node = host;
    while (node && node !== document.body) {
      const header = node.previousElementSibling;
      const closeButton = header && header.querySelector && header.querySelector("button");
      if (header instanceof HTMLElement && header.querySelector("h2") && closeButton) {
        panelHeader = header;
        panelContent = node;
        drawerClose = closeButton;
        header.classList.add("jc-lumiverse-panel-header");
        node.classList.add("jc-lumiverse-panel-content");
        break;
      }
      node = node.parentElement;
    }
  };
  const closeDrawer = () => {
    markHost();
    if (drawerClose && drawerClose.isConnected) drawerClose.click();
  };
  markHost();
  const stopActivation = tab.onActivate
    ? tab.onActivate(() => {
        attempts = 0;
        markHost();
      })
    : null;

  // ----- views -----
  function setView(view) {
    for (const b of root.querySelectorAll("[data-view]")) b.dataset.active = String(b.dataset.view === view);
    for (const p of root.querySelectorAll("[data-pane]")) p.hidden = p.dataset.pane !== view;
  }

  function persist() {
    saveHistory(
      items
        .filter((i) => i.state === "done")
        .map(({ name, characterId, at, note }) => ({ name, characterId, at, note })),
    );
  }

  function renderList() {
    const doneCount = items.filter((i) => i.state === "done").length;
    countEl.textContent = doneCount ? ` (${doneCount})` : "";
    list.replaceChildren();
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "jc-empty";
      empty.textContent = "Nothing imported yet.";
      list.append(empty);
      return;
    }
    const surfaces = ctx.host && ctx.host.surfaces;
    for (const it of items) {
      const el = document.createElement("div");
      el.className = "jc-item";
      el.dataset.state = it.state;
      const main = document.createElement("div");
      main.className = "jc-item-main";
      const title = document.createElement("div");
      title.className = "jc-item-title";
      title.textContent = it.name;
      const sub = document.createElement("div");
      sub.className = "jc-item-sub";
      sub.textContent =
        it.state === "working"
          ? "Importing…"
          : it.state === "error"
            ? it.error
            : [it.at ? new Date(it.at).toLocaleString() : "", it.note].filter(Boolean).join(" · ");
      main.append(title, sub);
      el.append(main);
      if (it.state === "done" && surfaces && it.characterId) {
        const chat = document.createElement("button");
        chat.type = "button";
        chat.className = "jc-btn";
        chat.dataset.primary = "";
        chat.textContent = "Chat";
        chat.dataset.chat = it.characterId;
        el.append(chat);
      }
      list.append(el);
    }
  }

  function openJai() {
    if (mobile) {
      window.open(HOME_URL, "_blank", "noopener");
      windowStatus.textContent = "Opened JanitorAI in a new tab.";
      return;
    }
    if (popup && !popup.closed) {
      popup.focus();
      windowStatus.textContent = "JanitorAI window is already open — brought to front.";
      return;
    }
    const sx = window.screen.availLeft || 0;
    const sy = window.screen.availTop || 0;
    const sw = window.screen.availWidth || 1280;
    const sh = window.screen.availHeight || 800;
    const width = Math.max(480, Math.round(sw * 0.45));
    const features = `popup=yes,width=${width},height=${sh},left=${sx + sw - width},top=${sy}`;
    popup = window.open(HOME_URL, WINDOW_NAME, features);
    windowStatus.textContent = popup
      ? "Opened on the right side of your screen."
      : "Pop-up blocked. Allow pop-ups for Lumiverse, or use “Open in a tab”.";
  }

  async function handleFile(file) {
    const item = { name: file.name, state: "working" };
    items.unshift(item);
    setView("imports");
    renderList();
    try {
      const parsed = await readCardFile(file);
      item.name = cardName(parsed.card);
      const character = await importCharacter(parsed);
      const notes = [];
      if (!parsed.avatar) notes.push("no avatar in file");
      if (parsed.galleryImages) notes.push(`${parsed.galleryImages} gallery image(s) not imported`);
      Object.assign(item, {
        state: "done",
        characterId: character.id,
        at: Date.now(),
        note: notes.join(" · "),
      });
      persist();
    } catch (err) {
      Object.assign(item, { state: "error", error: err && err.message ? err.message : String(err) });
    }
    renderList();
  }

  async function handleFiles(files) {
    for (const file of Array.from(files)) await handleFile(file);
  }

  const onRootClick = (e) => {
    const t = e.target.closest && e.target.closest("button");
    if (!t || !root.contains(t)) return;
    if (t.dataset.close !== undefined) return closeDrawer();
    if (t.dataset.view) return setView(t.dataset.view);
    if (t.dataset.act === "open") return openJai();
    if (t.dataset.act === "tab") return void window.open(HOME_URL, "_blank", "noopener");
    if (t.dataset.chat) {
      const surfaces = ctx.host && ctx.host.surfaces;
      if (!surfaces) return;
      Promise.resolve(
        surfaces.invoke({ kind: "entity_action", id: "character_chat" }, { characterId: t.dataset.chat, mode: "latest" }),
      )
        .then(() => closeDrawer())
        .catch((err) => {
          const it = items.find((i) => i.characterId === t.dataset.chat);
          if (it) {
            it.note = `Could not open chat: ${err && err.message ? err.message : err}`;
            renderList();
          }
        });
    }
  };
  const onDropClick = () => fileInput.click();
  const onChange = () => {
    handleFiles(fileInput.files);
    fileInput.value = "";
  };
  const onDragOver = (e) => {
    e.preventDefault();
    drop.dataset.over = "1";
  };
  const onDragLeave = () => delete drop.dataset.over;
  const onDrop = (e) => {
    e.preventDefault();
    delete drop.dataset.over;
    if (e.dataTransfer && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
  };
  root.addEventListener("click", onRootClick);
  drop.addEventListener("click", onDropClick);
  fileInput.addEventListener("change", onChange);
  drop.addEventListener("dragover", onDragOver);
  drop.addEventListener("dragleave", onDragLeave);
  drop.addEventListener("drop", onDrop);
  renderList();

  return () => {
    cancelAnimationFrame(raf);
    clearFrame();
    if (stopActivation) stopActivation();
    root.removeEventListener("click", onRootClick);
    drop.removeEventListener("click", onDropClick);
    fileInput.removeEventListener("change", onChange);
    drop.removeEventListener("dragover", onDragOver);
    drop.removeEventListener("dragleave", onDragLeave);
    drop.removeEventListener("drop", onDrop);
    removeStyle();
    ctx.dom.cleanup();
  };
}

// Exposed for tests only.
export const _internal = { readZip, readCardFile, prepareCard, importCharacter };
