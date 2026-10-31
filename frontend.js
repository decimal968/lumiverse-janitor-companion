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

const CSS = `
.jc-root { box-sizing: border-box; height: 100%; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 18px; color: var(--lumiverse-text, inherit); font: inherit; }
.jc-root *, .jc-root *::before, .jc-root *::after { box-sizing: border-box; }
.jc-section h3 { margin: 0 0 6px; font-size: 13px; font-weight: 600; letter-spacing: .02em; }
.jc-note { margin: 0 0 10px; font-size: 12px; line-height: 1.5; color: var(--lumiverse-text-muted, #9a9aa8); }
.jc-row { display: flex; gap: 8px; flex-wrap: wrap; }
.jc-btn { cursor: pointer; border: 1px solid var(--lumiverse-border, rgba(255,255,255,.14)); background: var(--lumiverse-fill-subtle, rgba(255,255,255,.05)); color: inherit; border-radius: var(--lumiverse-radius, 8px); padding: 8px 14px; font: inherit; font-size: 13px; }
.jc-btn:hover { border-color: var(--lumiverse-border-hover, rgba(255,255,255,.3)); }
.jc-btn[data-primary] { background: var(--lumiverse-accent, #8b7cf6); border-color: transparent; color: var(--lumiverse-accent-fg, #fff); font-weight: 600; }
.jc-status { margin-top: 8px; font-size: 12px; color: var(--lumiverse-text-muted, #9a9aa8); min-height: 1.2em; }
.jc-drop { border: 1.5px dashed var(--lumiverse-border, rgba(255,255,255,.2)); border-radius: var(--lumiverse-radius, 10px); padding: 22px 14px; text-align: center; font-size: 13px; cursor: pointer; background: var(--lumiverse-fill-subtle, rgba(255,255,255,.03)); }
.jc-drop[data-over] { border-color: var(--lumiverse-accent, #8b7cf6); }
.jc-list { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; }
.jc-item { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border: 1px solid var(--lumiverse-border, rgba(255,255,255,.1)); border-radius: var(--lumiverse-radius, 8px); font-size: 12px; }
.jc-item-main { flex: 1; min-width: 0; }
.jc-item-title { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.jc-item-sub { color: var(--lumiverse-text-muted, #9a9aa8); overflow-wrap: anywhere; }
.jc-item[data-state="error"] .jc-item-sub { color: #e5736f; }
.jc-item .jc-btn { padding: 5px 10px; font-size: 12px; }
`;

export function setup(ctx) {
  let popup = null;

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

  const root = document.createElement("div");
  root.className = "jc-root";
  root.innerHTML = `
    <section class="jc-section">
      <h3>JanitorAI</h3>
      <p class="jc-note">Opens in its own window next to Lumiverse. Your JAI Exporter extension runs there as normal.
      Allow pop-ups for this site if nothing opens.</p>
      <div class="jc-row">
        <button class="jc-btn" data-primary data-act="open">Open beside Lumiverse</button>
        <button class="jc-btn" data-act="tab">Open in a tab</button>
      </div>
      <div class="jc-status" data-role="window-status"></div>
    </section>
    <section class="jc-section">
      <h3>Import exported cards</h3>
      <p class="jc-note">Drop the .charx (or .json) files from JAI Exporter here.</p>
      <div class="jc-drop" data-role="drop">Drop files here or click to choose</div>
      <input type="file" multiple accept=".charx,.zip,.json" hidden data-role="file" />
      <div class="jc-list" data-role="list"></div>
    </section>`;
  tab.root.replaceChildren(root);

  const $ = (sel) => root.querySelector(sel);
  const windowStatus = $('[data-role="window-status"]');
  const drop = $('[data-role="drop"]');
  const fileInput = $('[data-role="file"]');
  const list = $('[data-role="list"]');

  function openBeside() {
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

  function addRow(title) {
    const item = document.createElement("div");
    item.className = "jc-item";
    item.dataset.state = "working";
    const main = document.createElement("div");
    main.className = "jc-item-main";
    const t = document.createElement("div");
    t.className = "jc-item-title";
    t.textContent = title;
    const s = document.createElement("div");
    s.className = "jc-item-sub";
    s.textContent = "Importing…";
    main.append(t, s);
    item.append(main);
    list.prepend(item);
    return { item, title: t, sub: s };
  }

  async function handleFile(file) {
    const row = addRow(file.name);
    try {
      const parsed = await readCardFile(file);
      row.title.textContent = cardName(parsed.card);
      const character = await importCharacter(parsed);
      const notes = ["Imported"];
      if (!parsed.avatar) notes.push("no avatar in file");
      if (parsed.galleryImages) notes.push(`${parsed.galleryImages} gallery image(s) not imported`);
      row.item.dataset.state = "done";
      row.sub.textContent = notes.join(" · ");
      const surfaces = ctx.host && ctx.host.surfaces;
      if (surfaces && character && character.id) {
        const chat = document.createElement("button");
        chat.className = "jc-btn";
        chat.textContent = "Chat";
        chat.addEventListener("click", () => {
          surfaces
            .invoke({ kind: "entity_action", id: "character_chat" }, { characterId: character.id, mode: "latest" })
            .catch((err) => {
              row.sub.textContent = `Could not open chat: ${err && err.message ? err.message : err}`;
            });
        });
        row.item.append(chat);
      }
    } catch (err) {
      row.item.dataset.state = "error";
      row.sub.textContent = err && err.message ? err.message : String(err);
    }
  }

  async function handleFiles(files) {
    for (const file of Array.from(files)) await handleFile(file);
  }

  const onRootClick = (e) => {
    const act = e.target.closest && e.target.closest("[data-act]");
    if (!act) return;
    if (act.dataset.act === "open") openBeside();
    if (act.dataset.act === "tab") window.open(HOME_URL, "_blank", "noopener");
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

  return () => {
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
