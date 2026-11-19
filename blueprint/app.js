// Sills BluePrint web app. Same service, same song documents and same rules as the desktop app (Source/BluePrint in the
// suite repo); folder sync is desktop-only, but files can be uploaded / downloaded here.
import * as S from "./bp-core.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const KEYS = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const st = {
  client: null, me: null, orgs: [], orgId: "", org: null, projectId: "", project: null,
  songId: "", info: null, doc: null, base: null, comments: [],
  dirty: false, saving: false, saveState: "Ready", online: true, selected: "", timing: false,
  open: new Set(JSON.parse(localStorage.getItem("bp.open") || "[]")), since: 0, titleDirty: false,
};
let saveTimer = 0;

// ------------------------------------------------------------------------------------------------ small UI helpers
function toast(msg, ms = 2600) { const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), ms); }
function ask(title, text, fields, okText = "OK") {
  return new Promise((resolve) => {
    $("mTitle").textContent = title; $("mText").textContent = text || ""; $("mText").hidden = !text;
    $("mFields").innerHTML = fields.map((f, i) => f.html ? f.html
      : f.options ? `<label>${esc(f.label)}</label><select id="mf${i}">${f.options.map((o) => `<option ${o === f.value ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>`
      : `<label>${esc(f.label)}</label><input id="mf${i}" value="${esc(f.value || "")}" placeholder="${esc(f.placeholder || "")}">`).join("");
    $("mOk").textContent = okText; $("mCancel").hidden = okText === "Done";
    $("modal").hidden = false;
    const first = $("mf0"); if (first) setTimeout(() => first.focus(), 30);
    const done = (ok) => { $("modal").hidden = true; $("mOk").onclick = $("mCancel").onclick = null; document.onkeydown = null;
      resolve(ok ? fields.map((f, i) => ($("mf" + i) ? $("mf" + i).value.trim() : "")) : null); };
    $("mOk").onclick = () => done(true); $("mCancel").onclick = () => done(false);
    document.onkeydown = (e) => { if (e.key === "Enter" && e.target.tagName !== "TEXTAREA") done(true); if (e.key === "Escape") done(false); };
  });
}
const tell = (title, text) => ask(title, text, [], "Done");
function menu(x, y, items) {
  const m = $("menu");
  m.innerHTML = items.map((it, i) => it === "-" ? `<div class="sep"></div>` : it.header ? `<div class="hd">${esc(it.header)}</div>`
    : `<div data-i="${i}" class="${it.disabled ? "off" : ""} ${it.ticked ? "tick" : ""}">${esc(it.label)}</div>`).join("");
  m.hidden = false;
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 4)) + "px";
  m.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 4)) + "px";
  m.onclick = (e) => { const i = e.target.dataset.i; if (i === undefined) return; m.hidden = true; items[i].run && items[i].run(); };
  setTimeout(() => document.addEventListener("pointerdown", function off(e) { if (!m.contains(e.target)) { m.hidden = true; document.removeEventListener("pointerdown", off); } }), 0);
}
const memberName = (id) => (st.org?.members || []).find((m) => m.id === id)?.name || "";
const memberColour = (id) => (st.org?.members || []).find((m) => m.id === id)?.color || "#8e8e8e";
const myRole = () => (st.org?.members || []).find((m) => m.id === st.me?.id)?.role || "";
const canManage = () => ["owner", "admin"].includes(myRole());
const canSync = () => ["owner", "admin", "engineer"].includes(myRole());
async function api(method, path, body) {
  const r = await st.client.call(method, path, body);
  st.online = r.status !== 0;
  if (!r.ok && r.status !== 409) renderState();
  return r;
}

// ------------------------------------------------------------------------------------------------ start
async function boot() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  try { st.client = new S.Client(await S.loadIdentity()); }
  catch (e) { $("welcome").hidden = false; $("wName").hidden = true; $("wErr").textContent = e.message; return; }
  wireUi();
  await connect();
}

async function connect() {
  const r = await st.client.call("POST", "/me", {});
  if (r.status === 401) return showWelcome(false);
  if (!r.ok) { showWelcome(false); $("wErr").textContent = r.status === 0 ? "Can't reach the BluePrint service yet." : r.error; return; }
  st.me = r.json.user; st.orgs = r.json.orgs;
  if (!st.orgs.length) return showWelcome(true);
  $("welcome").hidden = true; $("shell").hidden = false;
  const last = localStorage.getItem("bp.org");
  await openOrg(st.orgs.some((o) => o.id === last) ? last : st.orgs[0].id);
  setInterval(poll, 5000);
}

function showWelcome(registered) {
  $("welcome").hidden = false; $("shell").hidden = true;
  $("wName").hidden = registered; $("wOrg").hidden = !registered;
  $("wText").textContent = registered
    ? `Hi ${st.me.name}. Start your label or studio, or join one with the invite code someone sent you. Nobody can see an organization unless they made it or were invited.`
    : "Write songs with your team: lyrics, structure, who's on which verse, samples and the project files - the same as the Sills BluePrint app.";
}

// ------------------------------------------------------------------------------------------------ loading
async function openOrg(id) {
  if (st.dirty) await saveNow();
  st.orgId = id; localStorage.setItem("bp.org", id);
  st.org = null; st.project = null; st.projectId = ""; st.songId = ""; st.doc = null; st.since = 0;
  await refreshOrg();
  const lp = localStorage.getItem("bp.project");
  if (st.org && st.org.projects.some((p) => p.id === lp)) await openProject(lp);
  renderAll();
}
async function refreshOrg() {
  const r = await api("GET", `/orgs/${st.orgId}`);
  if (r.ok) st.org = r.json;
  renderTop(); renderBins(); renderTeam();
}
async function openProject(id) {
  if (st.dirty) await saveNow();
  st.projectId = id; localStorage.setItem("bp.project", id);
  st.open.add("p:" + id); saveOpen();
  st.songId = ""; st.doc = null;
  await refreshProject();
  const ls = localStorage.getItem("bp.song");
  if (st.project && st.project.songs.some((s) => s.id === ls)) await openSong(ls);
  renderAll();
}
async function refreshProject() {
  if (!st.projectId) return;
  const r = await api("GET", `/projects/${st.projectId}`);
  if (r.ok) st.project = r.json;
  renderBins();
}
async function openSong(id) {
  if (st.dirty) await saveNow();
  const r = await api("GET", `/songs/${id}`);
  if (!r.ok) return toast(r.error);
  st.songId = id; localStorage.setItem("bp.song", id);
  const { doc, comments, ...info } = r.json;
  st.info = info; st.doc = doc && typeof doc === "object" ? doc : S.makeDefault();
  if (!Array.isArray(st.doc.sections)) st.doc.sections = [];
  S.renumber(st.doc);
  st.base = S.clone(st.doc); st.comments = comments || []; st.dirty = false; st.titleDirty = false; st.saveState = "Saved";
  if (!st.doc.sections.some((s) => s.id === st.selected)) st.selected = st.doc.sections[0]?.id || "";
  renderAll();
  if (innerWidth <= 900) mview("center");
}
const saveOpen = () => localStorage.setItem("bp.open", JSON.stringify([...st.open]));

// ------------------------------------------------------------------------------------------------ saving / polling
function markDirty() {
  st.dirty = true; if (!st.saving) st.saveState = "Edited";
  clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 1200);
  renderState();
}
async function saveNow() {
  clearTimeout(saveTimer);
  if (!st.dirty || !st.songId || st.saving) return;
  st.saving = true; st.saveState = "Saving..."; renderState();
  const sent = S.clone(st.doc), sid = st.songId;
  const body = { ifVersion: st.info.version, doc: sent };
  if (st.titleDirty) body.title = st.info.title;
  st.dirty = false;
  const r = await api("PUT", `/songs/${sid}`, body);
  st.saving = false;
  if (sid !== st.songId) return;
  if (r.ok) { st.info.version = r.json.version; st.base = sent; st.titleDirty = false; st.saveState = st.dirty ? "Edited" : "Saved"; if (st.dirty) markDirty(); }
  else if (r.status === 409) {
    const theirs = r.json.song;
    st.doc = S.merge(st.base, st.doc, theirs.doc); S.renumber(st.doc);
    st.base = S.clone(theirs.doc); st.info.version = theirs.version; st.comments = theirs.comments || [];
    st.saveState = "Merged a teammate's changes"; st.dirty = true;
    renderSong(); setTimeout(saveNow, 300);
  } else { st.dirty = true; st.saveState = r.status === 0 ? "Offline - changes kept" : "Not saved: " + r.error; if (r.status === 0) saveTimer = setTimeout(saveNow, 10000); }
  renderState();
}
async function poll() {
  if (!st.orgId || document.hidden) return;
  const r = await api("GET", `/orgs/${st.orgId}/changes?since=${st.since}`);
  if (!r.ok) return renderState();
  const first = st.since === 0;
  st.since = r.json.now - 2000;
  if (first) return renderState();
  const j = r.json;
  if (j.projects.length) await refreshOrg();
  if ([...j.songs, ...j.files, ...j.folders].some((x) => x.project_id === st.projectId)) await refreshProject();
  const mineChanged = j.songs.some((s) => s.id === st.songId && s.version > st.info.version) || j.comments.some((c) => c.song_id === st.songId);
  if (mineChanged && !st.dirty && !st.saving && !document.activeElement?.closest?.("#sheet, #top, #insp")) await openSong(st.songId);
  renderState();
}
addEventListener("beforeunload", (e) => { if (st.dirty) { saveNow(); e.preventDefault(); } });

// ------------------------------------------------------------------------------------------------ rendering
function renderAll() { renderTop(); renderBins(); renderStructure(); renderSong(); renderInspector(); renderState(); }

function renderState() {
  const off = !st.online;
  const s = st.songId ? st.saveState : "Ready";
  $("saveText").textContent = off ? "Offline" : s;
  $("saveDot").style.background = off || s.startsWith("Not saved") ? "var(--rec)" : s === "Saved" || s === "Ready" ? "var(--ok)" : "var(--warn)";
}

function renderTop() {
  $("orgSel").innerHTML = st.orgs.map((o) => `<option value="${o.id}" ${o.id === st.orgId ? "selected" : ""}>${esc(o.name)}</option>`).join("");
  const has = !!st.doc;
  for (const id of ["fTitle", "fBpm", "fKey", "fMeter", "fStatus"]) $(id).disabled = !has;
  if (document.activeElement !== $("fTitle")) $("fTitle").value = has ? st.info.title : "";
  if (document.activeElement !== $("fBpm")) $("fBpm").value = has ? st.doc.bpm ?? "" : "";
  $("fKey").value = has ? st.doc.key || "" : ""; $("fMeter").value = has ? st.doc.timeSig || "4/4" : "4/4"; $("fStatus").value = has ? st.doc.status || "Writing" : "Writing";
  $("orgName").textContent = st.org?.name || "No organization";
  $("myRole").textContent = myRole();
  $("bNewProject").disabled = !canSync(); $("bNewSong").disabled = !st.projectId; $("bNewFolder").disabled = !st.projectId || !canSync();
  $("bInvite").disabled = !canManage();
}

function treeRow(kind, id, label, depth, opts = {}) {
  const key = kind === "project" ? "p:" + id : kind === "folder" ? "f:" + id : kind === "dir" ? "d:" + id : "";
  const openable = ["project", "folder", "dir"].includes(kind) || kind === "groupO";
  const isOpen = key && st.open.has(key);
  const cls = ["ti", kind, opts.sel ? "sel" : "", opts.active ? "active" : ""].join(" ");
  return `<div class="${cls}" data-kind="${kind}" data-id="${esc(id)}" style="padding-left:${6 + depth * 14}px">`
    + `<span class="tw" data-tw="${key}">${openable ? (isOpen ? "&#9660;" : "&#9654;") : ""}</span>`
    + (kind === "group" ? "" : `<span class="ic ${kind === "dir" ? "folder" : kind}"></span>`)
    + `<span class="nm">${esc(kind === "group" ? label.toUpperCase() : label)}</span>${opts.sub ? `<span class="sub">${esc(opts.sub)}</span>` : ""}</div>`;
}
function renderBins() {
  if (!st.org) { $("tree").innerHTML = `<div class="empty small">Loading...</div>`; return; }
  let h = "";
  for (const p of st.org.projects) {
    const open = st.open.has("p:" + p.id);
    h += treeRow("project", p.id, p.name, 0, { active: p.id === st.projectId });
    if (!open || p.id !== st.projectId || !st.project) continue;
    h += treeRow("group", "songs", "Songs", 1);
    for (const s of st.project.songs) h += treeRow("song", s.id, s.title, 2, { sel: s.id === st.songId, sub: "v" + s.version });
    h += treeRow("group", "folders", "Project folders", 1);
    for (const f of st.project.folders) {
      h += treeRow("folder", f.id, f.name, 2);
      if (!st.open.has("f:" + f.id)) continue;
      const files = st.project.files.filter((x) => x.folder_id === f.id);
      const dirs = new Set();
      for (const file of files) {
        const parts = file.path.split("/");
        let acc = "", depth = 3, hidden = false;
        for (let i = 0; i < parts.length - 1; i++) {
          acc += parts[i] + "/";
          const dkey = f.id + ":" + acc;
          if (!dirs.has(dkey)) { dirs.add(dkey); if (!hidden) h += treeRow("dir", dkey, parts[i], depth); }
          if (!st.open.has("d:" + dkey)) hidden = true;
          depth++;
        }
        if (!hidden) h += treeRow("file", file.id, parts[parts.length - 1], depth, { sub: S.humanBytes(file.size) });
      }
      if (!files.length) h += `<div class="ti" style="padding-left:62px"><span class="sub">Empty - right-click the folder to upload</span></div>`;
    }
  }
  if (!st.org.projects.length) h = `<div class="empty small">No projects yet.<br>Make one with New Project.</div>`;
  $("tree").innerHTML = h;
  if (!$("infoBody").hidden) renderInfo();
}
function renderInfo() {
  const o = st.org; if (!o) return;
  const used = o.usedBytes, quota = o.quota_mb * 1048576;
  $("infoBody").innerHTML = `<div class="kv"><span class="dim">Kind</span><span>${esc(o.kind[0].toUpperCase() + o.kind.slice(1))}</span>`
    + `<span class="dim">Your role</span><span>${esc(myRole())}</span><span class="dim">Members</span><span>${o.members.length}</span>`
    + `<span class="dim">Projects</span><span>${o.projects.length}</span>`
    + `<span class="dim">Storage</span><span>${S.humanBytes(used)} of ${o.quota_mb} MB</span></div>`
    + `<div class="bar"><i style="width:${Math.max(1, Math.min(100, (used / quota) * 100))}%"></i></div>`
    + `<p class="dim small" style="margin-top:16px">Folder sync runs in the Sills BluePrint desktop app. Here you can upload and download project files.</p>`;
}

function renderStructure() {
  const lane = $("lane"), ruler = $("ruler");
  if (!st.doc) { lane.innerHTML = `<div class="empty small" style="padding:20px;flex:1">Open a song to see its structure</div>`; ruler.innerHTML = ""; $("structInfo").textContent = ""; return; }
  const secs = st.doc.sections;
  const total = secs.reduce((a, s) => a + Math.max(1, s.bars || 8), 0);
  const bpm = Math.max(30, Number(st.doc.bpm) || 90), beats = Math.max(1, parseInt(st.doc.timeSig || "4") || 4);
  $("structInfo").textContent = `${total} bars - ${S.formatTime((total * beats * 60) / bpm).replace(/\.\d$/, "")} at ${bpm} BPM`;
  const px = Math.max(6, Math.min(28, (lane.clientWidth - 24) / Math.max(total, 1)));
  lane.dataset.px = px;
  lane.innerHTML = secs.map((s, i) => {
    const c = s.color || S.sectionColour(s.type);
    return `<div class="clip ${s.id === st.selected ? "sel" : ""}" data-i="${i}" style="width:${Math.max(1, s.bars || 8) * px}px;background:${c}55">`
      + `<div class="cn" style="background:${c}">${esc(S.sectionLabel(s))}</div><div class="cb">`
      + (s.artist ? `<div class="ca"><i style="background:${esc(memberColour(s.artist))}"></i>${esc(memberName(s.artist))}</div>` : "")
      + `<span class="cbars">${s.bars || 8} bars</span></div><div class="grip" data-grip="${i}"></div></div>`;
  }).join("");
  const step = px >= 24 ? 1 : px >= 10 ? 4 : 8;
  let r = "";
  for (let b = 0; b <= total; b += step) r += `<span style="left:${8 + b * px}px">${b + 1}</span>`;
  ruler.innerHTML = r;
}

function renderSong() {
  const sheet = $("sheet");
  $("songTab").textContent = st.doc ? st.info.title : "No song open";
  $("footInfo").textContent = st.doc ? `${st.project?.name || ""}   |   ${st.doc.sections.length} sections` : "";
  if (!st.doc) { sheet.innerHTML = `<div class="empty">${st.projectId ? "Pick a song in Bins, or make one with New Song" : "Pick a project in Bins"}</div>`; return; }
  const members = st.org?.members || [];
  sheet.innerHTML = st.doc.sections.map((s, i) => {
    const c = s.color || S.sectionColour(s.type);
    const first = (s.lines || []).find((l) => l.t >= 0);
    const body = st.timing
      ? (s.lines || []).map((l, li) => l.text.trim() ? `<div class="trow"><input data-time="${i}:${li}" value="${S.formatTime(l.t ?? -1)}"><span>${esc(l.text)}</span><button data-clear="${i}:${li}" title="Clear time">x</button></div>` : "").join("") || `<div class="dim" style="padding:20px">No lines to time yet</div>`
      : `<textarea data-lyr="${i}" placeholder="Write ${esc(S.sectionLabel(s))} here..." spellcheck="true">${esc(S.linesToText(s))}</textarea>`;
    return `<div class="sec ${s.id === st.selected ? "sel" : ""}" data-sec="${i}">`
      + (s.artist ? `<span class="stripe" style="background:${esc(memberColour(s.artist))}"></span>` : "")
      + `<div class="tile"><div class="frame" data-frame="${i}" style="background:linear-gradient(135deg, ${c}, ${c}44)"><b>${esc(S.sectionLabel(s))}</b><small>${s.bars || 8} bars${first ? "   @ " + S.formatTime(first.t) : ""}</small></div>`
      + `<select data-artist="${i}"><option value="">Unassigned</option>${members.map((m) => `<option value="${m.id}" ${m.id === s.artist ? "selected" : ""}>${esc(m.name)}</option>`).join("")}</select>`
      + `<div class="row"><input data-bars="${i}" value="${s.bars || 8} bars"><button data-secmenu="${i}">...</button></div></div>`
      + `<div class="lyr">${body}</div></div>`;
  }).join("");
  sheet.querySelectorAll("textarea[data-lyr]").forEach(grow);
}
function grow(t) { t.style.height = "auto"; t.style.height = Math.max(innerWidth <= 900 ? 60 : 120, t.scrollHeight) + "px"; }

function renderInspector() {
  // comments
  const anchorName = (id) => { const s = st.doc?.sections.find((x) => x.id === id); return s ? S.sectionLabel(s) : ""; };
  $("comments").innerHTML = !st.doc ? "" : st.comments.length ? st.comments.map((c) => `<div class="cm ${c.resolved ? "res" : ""}"><div class="who">${esc(c.name)} - ${new Date(c.created).toLocaleString()}${anchorName(c.anchor) ? " - on " + esc(anchorName(c.anchor)) : ""}${c.resolved ? " (resolved)" : ""}</div>${esc(c.text).replace(/\n/g, "<br>")}`
    + `<div class="acts"><button data-resolve="${c.id}" data-r="${c.resolved ? 0 : 1}">${c.resolved ? "Reopen" : "Resolve"}</button>${c.user_id === st.me.id || canManage() ? `<button data-delc="${c.id}">Delete</button>` : ""}</div></div>`).join("") : `<div class="dim">No comments yet.</div>`;
  $("cText").placeholder = st.selected && anchorName(st.selected) ? `Comment on ${anchorName(st.selected)}...` : "Comment on the song...";
  // notes
  if (document.activeElement !== $("nThemes")) $("nThemes").value = (st.doc?.themes || []).join(", ");
  if (document.activeElement !== $("nNotes")) $("nNotes").value = st.doc?.notes || "";
  $("nThemes").disabled = $("nNotes").disabled = !st.doc;
  // samples
  $("samples").innerHTML = (st.doc?.samples || []).map((s, i) => `<div class="li" data-sample="${i}"><div class="nm">${esc(s.name)}<small>${esc(s.notes || (s.fileId ? "linked to a project file" : "not linked to a file"))}</small></div><button data-smenu="${i}">...</button></div>`).join("")
    || (st.doc ? `<div class="dim">No samples yet.</div>` : "");
  $("bAddSample").disabled = !st.doc;
  renderTeam();
}
function renderTeam() {
  if (!st.org) return;
  $("team").innerHTML = st.org.members.map((m) => `<div class="li" data-member="${m.id}"><span class="sw" style="background:${esc(m.color || "#888")}"></span><div class="nm">${m.id === st.me.id ? "<b>" + esc(m.name) + "</b>" : esc(m.name)}</div><span class="role">${esc(m.role)}</span><button data-mmenu="${m.id}">...</button></div>`).join("");
  $("storage").textContent = `Storage ${S.humanBytes(st.org.usedBytes)} of ${st.org.quota_mb} MB`;
}

// ------------------------------------------------------------------------------------------------ actions
async function newProject() {
  const v = await ask("New project", "An album, EP, mixtape or single.", [{ label: "Project name" }], "Create");
  if (!v || !v[0]) return;
  const r = await api("POST", `/orgs/${st.orgId}/projects`, { name: v[0] });
  if (!r.ok) return toast(r.error);
  await refreshOrg(); await openProject(r.json.id);
}
async function newSong() {
  if (!st.projectId) return toast("Open a project first");
  const v = await ask("New song", "", [{ label: "Title" }], "Create");
  if (!v || !v[0]) return;
  const r = await api("POST", `/projects/${st.projectId}/songs`, { title: v[0], doc: S.makeDefault() });
  if (!r.ok) return toast(r.error);
  await refreshProject(); await openSong(r.json.id);
}
async function newFolder() {
  const v = await ask("New project folder", "A shared folder for session files, stems or beats. Upload files into it here, or keep it in sync with a folder on your computer in the desktop app.", [{ label: "Folder name" }], "Create");
  if (!v || !v[0]) return;
  const r = await api("POST", `/projects/${st.projectId}/folders`, { name: v[0] });
  if (!r.ok) return toast(r.error);
  st.open.add("f:" + r.json.id); saveOpen(); await refreshProject();
}
let uploadTarget = null;
function pickUpload(folderId, dir) { uploadTarget = folderId; const inp = dir ? $("dirPick") : $("filePick"); inp.value = ""; inp.click(); }
async function doUpload(files) {
  if (!uploadTarget || !files.length) return;
  const folderId = uploadTarget;
  let n = 0;
  for (const f of files) {
    n++;
    let path = f.webkitRelativePath ? f.webkitRelativePath.split("/").slice(1).join("/") : f.name;
    if (!path) path = f.name;
    try {
      const sha = await st.client.uploadFile(st.orgId, f, (d, t) => toast(`Uploading ${f.name} (${n}/${files.length}) ${t ? Math.round((100 * d) / t) : 100}%`, 60000));
      const r = await api("POST", `/folders/${folderId}/files`, { path, size: f.size, sha, mtime: f.lastModified });
      if (!r.ok) throw new Error(r.error);
    } catch (e) { toast(`${f.name}: ${e.message}`, 5000); return; }
  }
  toast(`Uploaded ${files.length} file${files.length > 1 ? "s" : ""}`);
  await refreshProject(); refreshOrg();
}
async function downloadFile(file) {
  toast("Downloading " + file.path.split("/").pop() + "...", 60000);
  try {
    const blob = await st.client.download(st.orgId, file.sha);
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = file.path.split("/").pop();
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    toast("Downloaded " + a.download);
  } catch (e) { toast(e.message, 5000); }
}
function treeMenu(e, row) {
  const kind = row.dataset.kind, id = row.dataset.id;
  const items = [];
  if (kind === "project") {
    const p = st.org.projects.find((x) => x.id === id);
    items.push({ label: "Open", run: () => openProject(id) },
      { label: "Rename...", disabled: !canSync(), run: async () => { const v = await ask("Rename project", "", [{ label: "Name", value: p.name }]); if (v && v[0]) { await api("POST", `/projects/${id}`, { name: v[0] }); refreshOrg(); refreshProject(); } } }, "-",
      { label: "Delete project...", disabled: !canManage(), run: async () => { if (await ask("Delete project", `Delete "${p.name}" for everyone in the organization?`, [], "Delete")) { await api("POST", `/projects/${id}`, { deleted: true }); st.projectId = ""; st.project = null; st.doc = null; st.songId = ""; await refreshOrg(); renderAll(); } } });
  } else if (kind === "song") {
    const s = st.project.songs.find((x) => x.id === id);
    items.push({ label: "Open", run: () => openSong(id) }, "-",
      { label: "Delete song...", run: async () => { if (await ask("Delete song", `Delete "${s.title}" for everyone?`, [], "Delete")) { await api("DELETE", `/songs/${id}`); if (st.songId === id) { st.songId = ""; st.doc = null; } await refreshProject(); renderAll(); } } });
  } else if (kind === "folder") {
    const f = st.project.folders.find((x) => x.id === id);
    items.push({ label: "Upload files...", disabled: !canSync(), run: () => pickUpload(id, false) },
      { label: "Upload a folder...", disabled: !canSync(), run: () => pickUpload(id, true) }, "-",
      { label: "Remove from project...", disabled: !canManage(), run: async () => { if (await ask("Remove folder", `Remove "${f.name}" from the project for everyone? Files on computers stay where they are.`, [], "Remove")) { await api("DELETE", `/folders/${id}`); refreshProject(); } } });
  } else if (kind === "file") {
    const file = st.project.files.find((x) => x.id === id);
    items.push({ label: "Download", run: () => downloadFile(file) },
      { label: "Add to song samples", disabled: !st.doc, run: () => { st.doc.samples = st.doc.samples || []; st.doc.samples.push({ id: S.newId(), name: file.path.split("/").pop(), fileId: file.id, notes: "" }); markDirty(); renderInspector(); itab("samples"); } },
      { label: "Link to song as...", disabled: !st.doc, run: () => menu(e.clientX, e.clientY, ["Session", "Beat", "Rough mix", "Reference", "Master"].map((role) => ({ label: role, run: () => { st.doc.links = st.doc.links || []; st.doc.links.push({ fileId: file.id, role, name: file.path.split("/").pop() }); markDirty(); toast(`Linked as ${role}`); } }))) }, "-",
      { label: "Remove from project", disabled: !canSync(), run: async () => { await api("DELETE", `/files/${id}`); refreshProject(); } });
  } else return;
  menu(e.clientX, e.clientY, items);
}
function sectionMenu(x, y, i) {
  const s = st.doc.sections[i];
  const changed = () => { S.renumber(st.doc); markDirty(); renderStructure(); renderSong(); };
  const sub = (title, list) => ({ label: title + "  >", run: () => menu(x, y, list) });
  menu(x, y, [
    { header: S.sectionLabel(s) },
    sub("Type", S.SECTION_TYPES.map((t) => ({ label: t, ticked: s.type === t, run: () => { s.type = t; changed(); } }))),
    sub("Artist", [{ label: "Unassigned", ticked: !s.artist, run: () => { s.artist = ""; changed(); } }, ...(st.org?.members || []).map((m) => ({ label: m.name, ticked: s.artist === m.id, run: () => { s.artist = m.id; changed(); } }))]),
    sub("Colour", [["Default", ""], ["Blue", "#3d8af7"], ["Teal", "#3aa6a0"], ["Green", "#4f9a55"], ["Gold", "#c99a2e"], ["Orange", "#cf6f2e"], ["Red", "#c2453f"], ["Purple", "#8b5fd1"], ["Grey", "#5d6470"]].map(([n, c]) => ({ label: n, run: () => { s.color = c; changed(); } }))),
    { label: "Rename...", run: async () => { const v = await ask("Rename section", "Leave empty to go back to automatic names (Verse 1, Verse 2...).", [{ label: "Name", value: S.sectionLabel(s) }]); if (v) { s.customName = !!v[0]; s.name = v[0]; changed(); } } },
    "-",
    { label: "Move earlier", disabled: i === 0, run: () => { st.doc.sections.splice(i - 1, 0, st.doc.sections.splice(i, 1)[0]); changed(); } },
    { label: "Move later", disabled: i === st.doc.sections.length - 1, run: () => { st.doc.sections.splice(i + 1, 0, st.doc.sections.splice(i, 1)[0]); changed(); } },
    { label: "Duplicate", run: () => { const c = S.clone(s); c.id = S.newId(); c.lines.forEach((l) => (l.t = -1)); st.doc.sections.splice(i + 1, 0, c); changed(); } },
    { label: "Add section after...", run: () => addSectionMenu(x, y, i) },
    { label: "Delete", run: () => { st.doc.sections.splice(i, 1); changed(); } },
  ]);
}
function addSectionMenu(x, y, after) {
  if (!st.doc) return;
  menu(x, y, S.SECTION_TYPES.map((t) => ({ label: "Add " + t, run: () => {
    const bars = t === "Hook" ? 8 : t === "Verse" ? 16 : t === "Intro" || t === "Outro" ? 4 : 8;
    const ns = S.newSection(t, bars);
    st.doc.sections.splice(after < 0 ? st.doc.sections.length : after + 1, 0, ns);
    st.selected = ns.id; S.renumber(st.doc); markDirty(); renderStructure(); renderSong();
  } })));
}
function select(id, scroll = true) {
  st.selected = id;
  document.querySelectorAll(".clip").forEach((c) => c.classList.toggle("sel", st.doc.sections[c.dataset.i]?.id === id));
  document.querySelectorAll(".sec").forEach((c) => c.classList.toggle("sel", st.doc.sections[c.dataset.sec]?.id === id));
  if (scroll) { const el = document.querySelector(`.sec[data-sec="${st.doc.sections.findIndex((s) => s.id === id)}"]`); el && el.scrollIntoView({ behavior: "smooth", block: "start" }); }
  renderInspector();
}
async function invite() {
  if (!canManage()) return toast("Only the owner and admins can invite people.");
  const v = await ask("Invite people", "Artists write lyrics, comment and download files. Engineers also make projects and folders. Admins also invite and manage members.",
    [{ label: "Role", options: ["artist", "engineer", "admin"], value: "artist" }, { label: "Who is it for? (note)" }, { label: "How many people can use it", value: "1" }, { label: "Days it stays valid", value: "7" }], "Make code");
  if (!v) return;
  const r = await api("POST", `/orgs/${st.orgId}/invites`, { role: v[0], note: v[1], uses: Number(v[2]) || 1, days: Number(v[3]) || 7 });
  if (!r.ok) return toast(r.error);
  try { await navigator.clipboard.writeText(r.json.code); } catch {}
  await ask("Invite code (copied)", `Send this to them. They open Sills BluePrint (app or web) and choose "Join with an invite code". It works ${r.json.uses} time(s) and isn't shown again.`,
    [{ html: `<div class="code">${esc(r.json.code)}</div>` + (navigator.share ? `<button id="mShare" class="primary" style="width:100%">Share...</button>` : "") }], "Done");
}
function memberMenu(x, y, id) {
  const m = st.org.members.find((q) => q.id === id), self = id === st.me.id;
  const set = async (body) => { const r = await api("POST", `/orgs/${st.orgId}/members/${id}`, body); if (!r.ok) toast(r.error); await refreshOrg(); renderStructure(); renderSong(); };
  menu(x, y, [
    { header: m.name + " - " + m.role },
    ...["admin", "engineer", "artist"].map((r) => ({ label: "Make " + r, ticked: m.role === r, disabled: !canManage() || m.role === "owner", run: () => set({ role: r }) })),
    { label: "Colour  >", disabled: !(self || canManage()), run: () => menu(x, y, ["#e0a43a", "#5fb26b", "#c96ad6", "#e26a5a", "#4fb8c9", "#d6c34a", "#8c7bea", "#e58cb1", "#4f8fe8"].map((c) => ({ label: c, run: () => set({ color: c }) }))) },
    "-",
    { label: self ? "Leave organization..." : "Remove from organization...", disabled: m.role === "owner" || !(self || canManage()), run: async () => {
      if (!(await ask(self ? "Leave" : "Remove member", self ? "Leave this organization? You'll need a new invite to come back." : `Remove ${m.name}? They lose access straight away.`, [], self ? "Leave" : "Remove"))) return;
      const r = await api("DELETE", `/orgs/${st.orgId}/members/${id}`); if (!r.ok) return toast(r.error);
      if (self) location.reload(); else refreshOrg();
    } },
  ]);
}
function accountMenu(x, y) {
  menu(x, y, [
    { header: st.me?.name || "" },
    ...st.orgs.map((o) => ({ label: `${o.name} (${o.role})`, ticked: o.id === st.orgId, run: () => openOrg(o.id) })), "-",
    { label: "Invite people...", disabled: !canManage(), run: invite },
    { label: "Create a new organization...", run: createOrg },
    { label: "Join with an invite code...", run: joinOrg },
    { label: "Rename organization...", disabled: !canManage(), run: async () => { const v = await ask("Rename", "", [{ label: "Name", value: st.org.name }]); if (v && v[0]) { await api("POST", `/orgs/${st.orgId}`, { name: v[0] }); await reloadMe(); refreshOrg(); } } }, "-",
    { label: "Change my name...", run: async () => { const v = await ask("Your name", "", [{ label: "Name", value: st.me.name }]); if (v && v[0]) { await api("POST", "/me", { name: v[0] }); await reloadMe(); refreshOrg(); } } },
    { label: "Link another computer or phone...", run: async () => { const r = await api("POST", "/me/link", {}); if (!r.ok) return toast(r.error); try { await navigator.clipboard.writeText(r.json.code); } catch {} ask("Link another computer or phone", "On the other device choose \"I already use BluePrint on another computer or phone\" and enter this code (valid 10 minutes).", [{ html: `<div class="code">${esc(r.json.code)}</div>` }], "Done"); } },
    { label: "Export lyrics as text", disabled: !st.doc, run: exportText },
  ]);
}
async function reloadMe() { const r = await api("POST", "/me", {}); if (r.ok) { st.me = r.json.user; st.orgs = r.json.orgs; renderTop(); } }
async function createOrg() {
  const v = await ask("Create an organization", "Your label, studio or crew. You can invite people once it exists.", [{ label: "Name" }, { label: "Kind", options: ["label", "studio", "band", "personal"], value: "label" }], "Create");
  if (!v || !v[0]) return;
  const r = await api("POST", "/orgs", { name: v[0], kind: v[1] });
  if (!r.ok) return toast(r.error);
  localStorage.setItem("bp.org", r.json.id); location.reload();
}
async function joinOrg() {
  const v = await ask("Join an organization", "Paste the invite code you were sent (BP-XXXX-XXXX-XXXX-XXXX).", [{ label: "Invite code" }], "Join");
  if (!v || !v[0]) return;
  const r = await api("POST", "/join", { code: v[0] });
  if (!r.ok) return toast(r.error, 4000);
  localStorage.setItem("bp.org", r.json.id); location.reload();
}
function exportText() {
  let out = st.info.title + "\n";
  for (const s of st.doc.sections) { const who = memberName(s.artist); out += `\n[${S.sectionLabel(s)}${who ? " - " + who : ""}]\n${S.linesToText(s)}\n`; }
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([out], { type: "text/plain" })); a.download = st.info.title.replace(/[\\/:*?"<>|]/g, "") + ".txt"; a.click();
}
function itab(name) {
  document.querySelectorAll("[data-itab]").forEach((b) => b.classList.toggle("on", b.dataset.itab === name));
  for (const p of ["comments", "notes", "samples", "team"]) $("ip-" + p).hidden = p !== name;
}
function mview(name) {
  if (name === "follow") return openFollow();
  document.querySelectorAll("#mnav button").forEach((b) => b.classList.toggle("on", b.dataset.mview === name));
  for (const p of ["bins", "center", "insp"]) $(p).classList.toggle("mshow", p === name);
  if (name === "center") requestAnimationFrame(() => { renderStructure(); document.querySelectorAll("textarea[data-lyr]").forEach(grow); });
}

// ------------------------------------------------------------------------------------------------ follow-along
const fl = { t: 0, playing: false, last: 0, armed: false, cursor: [-1, -1], raf: 0 };
function openFollow() {
  if (!st.doc) return toast("Open a song first");
  $("follow").hidden = false; $("flTitle").textContent = st.info.title;
  fl.t = Math.max(0, fl.t); drawFollow(true);
}
function closeFollow() { fl.playing = false; $("flPlay").textContent = "Play"; $("follow").hidden = true; cancelAnimationFrame(fl.raf); if (innerWidth <= 900) mview("center"); }
function flatLines() { const out = []; st.doc.sections.forEach((s, si) => (s.lines || []).forEach((l, li) => { if (l.text.trim()) out.push({ si, li, text: l.text, t: l.t ?? -1, sec: si }); })); return out; }
function nextLine(from) { const all = flatLines(); const k = all.findIndex((x) => x.si === from[0] && x.li === from[1]); const n = all[k + 1] || (from[0] < 0 ? all[0] : null); return n ? [n.si, n.li] : [-1, -1]; }
function drawFollow(force) {
  $("flClock").textContent = S.formatTime(fl.t);
  const all = flatLines(), [cs, cl] = S.lineAt(st.doc, fl.t);
  let idx = all.findIndex((x) => x.si === cs && x.li === cl);
  const focus = Math.max(0, idx);
  const view = $("flView"), H = view.clientHeight, big = Math.max(22, Math.min(40, innerWidth / 18)), small = big * 0.62;
  if (force || view.childElementCount !== all.length * 2) {
    view.innerHTML = all.map((x, i) => (i === 0 || x.sec !== all[i - 1].sec ? `<div class="fl sech" data-h="${i}">${esc(S.sectionLabel(st.doc.sections[x.sec]).toUpperCase())}${st.doc.sections[x.sec].artist ? "  -  " + esc(memberName(st.doc.sections[x.sec].artist)) : ""}</div>` : `<div class="fl sech" data-h="${i}" style="display:none"></div>`)
      + `<div class="fl" data-l="${i}" data-si="${x.si}" data-li="${x.li}">${esc(x.text)}</div>`).join("");
  }
  let y = H * 0.38 - big * 0.6;
  // lay out upwards and downwards from the focus line
  const pos = new Array(all.length);
  pos[focus] = y;
  let yy = y + big * 1.5;
  for (let i = focus + 1; i < all.length; i++) { if (all[i].sec !== all[i - 1].sec) yy += 22; pos[i] = yy; yy += small * 1.45; }
  let yu = y;
  for (let i = focus - 1; i >= 0; i--) { yu -= small * 1.45; if (all[i + 1].sec !== all[i].sec) yu -= 22; pos[i] = yu; }
  view.querySelectorAll(".fl[data-l]").forEach((el) => {
    const i = Number(el.dataset.l), cur = i === idx;
    el.classList.toggle("cur", cur || (idx < 0 && i === 0));
    el.style.top = pos[i] + "px"; el.style.fontSize = (i === focus ? big : small) + "px";
    el.style.opacity = i < focus ? 0.35 : Math.max(0.3, 1 - (i - focus) * 0.1);
    if (fl.armed && fl.cursor[0] === all[i].si && fl.cursor[1] === all[i].li) el.style.color = "var(--rec)"; else el.style.color = "";
    const prog = el.querySelector(".prog");
    if (cur) {
      const next = all.slice(i + 1).find((x) => x.t > all[i].t);
      const p = next ? Math.max(0, Math.min(1, (fl.t - all[i].t) / (next.t - all[i].t))) : 0;
      if (!prog) el.insertAdjacentHTML("beforeend", `<div class="prog"><i></i></div>`);
      el.querySelector(".prog i").style.width = p * 100 + "%";
    } else if (prog) prog.remove();
  });
  view.querySelectorAll(".fl[data-h]").forEach((el) => { const i = Number(el.dataset.h); el.style.top = pos[i] - 20 + "px"; el.style.opacity = i < focus ? 0.3 : 0.8; });
  const n = fl.armed && fl.cursor[0] >= 0 ? st.doc.sections[fl.cursor[0]].lines[fl.cursor[1]].text : "";
  $("flNext").textContent = n ? "NEXT  " + n : "";
}
function tick(now) {
  if (!fl.playing) return;
  fl.t += (now - fl.last) / 1000; fl.last = now;
  drawFollow(false);
  fl.raf = requestAnimationFrame(tick);
}
function stamp() {
  if (!fl.armed) return;
  if (fl.cursor[0] < 0) fl.cursor = nextLine([-1, -1]);
  if (fl.cursor[0] < 0) return;
  st.doc.sections[fl.cursor[0]].lines[fl.cursor[1]].t = Math.round(fl.t * 100) / 100;
  markDirty();
  fl.cursor = nextLine(fl.cursor);
  if (fl.cursor[0] < 0) { fl.armed = false; $("flArm").classList.remove("on"); toast("Every line has a time"); }
  drawFollow(false);
}

// ------------------------------------------------------------------------------------------------ wiring
function wireUi() {
  // welcome
  $("wGo").onclick = async () => {
    const name = $("wNameIn").value.trim(); if (!name) return;
    const r = await st.client.call("POST", "/me", { name, label: navigator.userAgentData?.platform || navigator.platform || "Browser" });
    if (!r.ok) { $("wErr").textContent = r.error; return; }
    st.me = r.json.user; st.orgs = r.json.orgs; $("wErr").textContent = "";
    if (st.orgs.length) connect(); else showWelcome(true);
  };
  $("wNameIn").onkeydown = (e) => { if (e.key === "Enter") $("wGo").click(); };
  $("wLink").onclick = async () => {
    const v = await ask("Use BluePrint here too", "On your other computer open BluePrint > Account > Link another computer, then type the code here.", [{ label: "Link code" }], "Link");
    if (!v || !v[0]) return;
    const r = await st.client.call("POST", "/me/claim", { code: v[0], label: "Browser" });
    if (!r.ok) { $("wErr").textContent = r.error; return; }
    connect();
  };
  $("wCreate").onclick = createOrg; $("wJoin").onclick = joinOrg;

  // top bar
  $("fKey").innerHTML = `<option value="">Key</option>` + [...KEYS.map((k) => k + " major"), ...KEYS.map((k) => k + " minor")].map((k) => `<option>${k}</option>`).join("");
  $("fMeter").innerHTML = ["4/4", "3/4", "6/8", "12/8", "5/4", "7/8"].map((k) => `<option>${k}</option>`).join("");
  $("fStatus").innerHTML = ["Idea", "Writing", "Recording", "Mixing", "Mastering", "Done"].map((k) => `<option>${k}</option>`).join("");
  $("orgSel").onchange = (e) => openOrg(e.target.value);
  $("fTitle").oninput = (e) => { st.info.title = e.target.value; st.titleDirty = true; $("songTab").textContent = e.target.value; markDirty(); };
  $("fTitle").onchange = () => refreshProject();
  $("fBpm").oninput = (e) => { st.doc.bpm = Math.min(300, Math.max(30, parseInt(e.target.value) || 90)); markDirty(); renderStructure(); };
  $("fKey").onchange = (e) => { st.doc.key = e.target.value; markDirty(); };
  $("fMeter").onchange = (e) => { st.doc.timeSig = e.target.value; markDirty(); renderStructure(); };
  $("fStatus").onchange = (e) => { st.doc.status = e.target.value; markDirty(); };
  $("bMenu").onclick = (e) => { const r = e.target.getBoundingClientRect(); accountMenu(r.left, r.bottom + 2); };
  $("bFollow").onclick = openFollow;

  // bins
  document.querySelectorAll("[data-btab]").forEach((b) => (b.onclick = () => {
    document.querySelectorAll("[data-btab]").forEach((x) => x.classList.toggle("on", x === b));
    $("binsBody").hidden = b.dataset.btab !== "bins"; $("infoBody").hidden = b.dataset.btab !== "info"; renderInfo();
  }));
  $("bNewProject").onclick = newProject; $("bNewSong").onclick = newSong; $("bNewFolder").onclick = newFolder;
  $("tree").onclick = (e) => {
    const tw = e.target.closest("[data-tw]");
    const row = e.target.closest(".ti"); if (!row) return;
    const kind = row.dataset.kind, id = row.dataset.id;
    if (tw && tw.dataset.tw) { const k = tw.dataset.tw; st.open.has(k) ? st.open.delete(k) : st.open.add(k); saveOpen(); if (kind === "project" && id !== st.projectId && st.open.has(k)) openProject(id); else renderBins(); return; }
    if (kind === "project") { if (id !== st.projectId) openProject(id); else { st.open.add("p:" + id); renderBins(); } }
    else if (kind === "song") openSong(id);
    else if (kind === "folder" || kind === "dir") { const k = (kind === "folder" ? "f:" : "d:") + id; st.open.has(k) ? st.open.delete(k) : st.open.add(k); saveOpen(); renderBins(); }
    else if (kind === "file") treeMenu(e, row);
  };
  $("tree").oncontextmenu = (e) => { const row = e.target.closest(".ti"); if (!row) return; e.preventDefault(); treeMenu(e, row); };
  $("filePick").onchange = (e) => doUpload([...e.target.files]);
  $("dirPick").onchange = (e) => doUpload([...e.target.files]);

  // structure: click = select, drag = reorder, edge = length, right-click / long-press = menu
  let drag = null;
  $("lane").onpointerdown = (e) => {
    const clip = e.target.closest(".clip"); if (!clip) return;
    const i = Number(clip.dataset.i);
    drag = { i, x: e.clientX, grip: !!e.target.dataset.grip, bars: st.doc.sections[i].bars || 8, moved: false, timer: setTimeout(() => { if (!drag?.moved) { const d = drag; drag = null; sectionMenu(e.clientX, e.clientY, d.i); } }, 550) };
    clip.setPointerCapture(e.pointerId);
  };
  $("lane").onpointermove = (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, px = Number($("lane").dataset.px) || 14;
    if (Math.abs(dx) > 4) { drag.moved = true; clearTimeout(drag.timer); }
    if (!drag.moved) return;
    if (drag.grip) {
      const bars = Math.max(1, Math.min(256, drag.bars + Math.round(dx / px)));
      if (bars !== st.doc.sections[drag.i].bars) { st.doc.sections[drag.i].bars = bars; markDirty(); const c = $("lane").querySelector(`.clip[data-i="${drag.i}"]`); c.style.width = bars * px + "px"; c.querySelector(".cbars").textContent = bars + " bars"; }
      return;
    }
    $("lane").querySelectorAll(".clip").forEach((c) => c.classList.remove("drop"));
    const over = document.elementFromPoint(e.clientX, e.clientY)?.closest(".clip");
    drag.to = over ? Number(over.dataset.i) : -1;
    if (over && drag.to !== drag.i) over.classList.add("drop");
  };
  $("lane").onpointerup = (e) => {
    if (!drag) return;
    clearTimeout(drag.timer);
    const d = drag; drag = null;
    $("lane").querySelectorAll(".clip").forEach((c) => c.classList.remove("drop"));
    if (!d.moved) { select(st.doc.sections[d.i].id); return; }
    if (d.grip) { renderStructure(); renderSong(); return; }
    if (d.to >= 0 && d.to !== d.i) { const s = st.doc.sections.splice(d.i, 1)[0]; st.doc.sections.splice(d.to, 0, s); S.renumber(st.doc); markDirty(); }
    renderStructure(); renderSong();
  };
  $("lane").oncontextmenu = (e) => { e.preventDefault(); const clip = e.target.closest(".clip"); if (drag) { clearTimeout(drag.timer); drag = null; } if (clip) sectionMenu(e.clientX, e.clientY, Number(clip.dataset.i)); else addSectionMenu(e.clientX, e.clientY, -1); };
  $("bAddSection").onclick = (e) => addSectionMenu(e.clientX, e.clientY, -1);
  addEventListener("resize", () => renderStructure());

  // script view
  $("bTiming").onclick = () => { st.timing = !st.timing; $("bTiming").classList.toggle("on", st.timing); renderSong(); };
  $("sheet").oninput = (e) => {
    const t = e.target;
    if (t.dataset.lyr !== undefined) { const s = st.doc.sections[t.dataset.lyr]; S.setLinesFromText(s, t.value); grow(t); markDirty(); }
  };
  $("sheet").onchange = (e) => {
    const t = e.target;
    if (t.dataset.artist !== undefined) { st.doc.sections[t.dataset.artist].artist = t.value; markDirty(); renderStructure(); renderSong(); }
    if (t.dataset.bars !== undefined) { const b = Math.max(1, Math.min(256, parseInt(t.value) || 8)); st.doc.sections[t.dataset.bars].bars = b; t.value = b + " bars"; markDirty(); renderStructure(); }
    if (t.dataset.time !== undefined) { const [si, li] = t.dataset.time.split(":").map(Number); st.doc.sections[si].lines[li].t = S.parseTime(t.value); t.value = S.formatTime(st.doc.sections[si].lines[li].t); markDirty(); }
  };
  $("sheet").onclick = (e) => {
    const t = e.target;
    if (t.dataset.secmenu !== undefined) return sectionMenu(e.clientX, e.clientY, Number(t.dataset.secmenu));
    if (t.dataset.clear !== undefined) { const [si, li] = t.dataset.clear.split(":").map(Number); st.doc.sections[si].lines[li].t = -1; markDirty(); renderSong(); return; }
    const sec = t.closest(".sec"); if (sec && st.doc.sections[sec.dataset.sec].id !== st.selected) select(st.doc.sections[sec.dataset.sec].id, false);
  };
  $("sheet").addEventListener("focusin", (e) => { const sec = e.target.closest(".sec"); if (sec && st.doc.sections[sec.dataset.sec].id !== st.selected) select(st.doc.sections[sec.dataset.sec].id, false); });

  // inspector
  document.querySelectorAll("[data-itab]").forEach((b) => (b.onclick = () => itab(b.dataset.itab)));
  $("cPost").onclick = async () => {
    const text = $("cText").value.trim(); if (!text || !st.songId) return;
    $("cText").value = "";
    const r = await api("POST", `/songs/${st.songId}/comments`, { anchor: st.selected, text });
    if (!r.ok) return toast(r.error);
    st.comments = r.json.comments; renderInspector();
  };
  $("cText").onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("cPost").click(); } };
  $("comments").onclick = async (e) => {
    const t = e.target;
    let r;
    if (t.dataset.resolve) r = await api("POST", `/comments/${t.dataset.resolve}`, { resolved: t.dataset.r === "1" });
    if (t.dataset.delc) r = await api("DELETE", `/comments/${t.dataset.delc}`);
    if (r && r.ok) { st.comments = r.json.comments; renderInspector(); }
  };
  $("nThemes").oninput = (e) => { st.doc.themes = e.target.value.split(",").map((x) => x.trim()).filter(Boolean); markDirty(); };
  $("nNotes").oninput = (e) => { st.doc.notes = e.target.value; markDirty(); };
  $("bAddSample").onclick = async () => {
    const v = await ask("Add sample", "Name the sample (right-click a project file in Bins to link the file itself).", [{ label: "Name" }, { label: "Notes (source, clearance...)" }], "Add");
    if (!v || !v[0]) return;
    st.doc.samples = st.doc.samples || []; st.doc.samples.push({ id: S.newId(), name: v[0], fileId: "", notes: v[1] }); markDirty(); renderInspector();
  };
  $("samples").onclick = (e) => {
    const i = e.target.dataset.smenu; if (i === undefined) return;
    const s = st.doc.samples[i];
    const file = s.fileId && st.project?.files.find((f) => f.id === s.fileId);
    menu(e.clientX, e.clientY, [
      { label: "Edit...", run: async () => { const v = await ask("Sample", "", [{ label: "Name", value: s.name }, { label: "Notes", value: s.notes }]); if (v) { s.name = v[0]; s.notes = v[1]; markDirty(); renderInspector(); } } },
      { label: "Download the file", disabled: !file, run: () => downloadFile(file) },
      { label: "Remove", run: () => { st.doc.samples.splice(i, 1); markDirty(); renderInspector(); } },
    ]);
  };
  $("team").onclick = (e) => { const id = e.target.dataset.mmenu; if (id) memberMenu(e.clientX, e.clientY, id); };
  $("bInvite").onclick = invite;
  document.addEventListener("click", (e) => { if (e.target.id === "mShare") navigator.share({ text: document.querySelector(".code").textContent }).catch(() => {}); });

  // mobile nav
  document.querySelectorAll("#mnav button").forEach((b) => (b.onclick = () => mview(b.dataset.mview)));
  mview("center");

  // follow
  $("flClose").onclick = closeFollow;
  $("flPlay").onclick = () => { fl.playing = !fl.playing; $("flPlay").textContent = fl.playing ? "Pause" : "Play"; if (fl.playing) { fl.last = performance.now(); fl.raf = requestAnimationFrame(tick); } };
  $("flBack").onclick = () => { fl.t = Math.max(0, fl.t - 5); drawFollow(false); };
  $("flZero").onclick = () => { fl.t = 0; drawFollow(false); };
  $("flArm").onclick = () => { fl.armed = !fl.armed; $("flArm").classList.toggle("on", fl.armed); if (fl.armed && fl.cursor[0] < 0) fl.cursor = nextLine([-1, -1]); drawFollow(false); };
  $("flStamp").onclick = stamp;
  $("flView").onclick = (e) => { const el = e.target.closest(".fl[data-l]"); if (!el) return; fl.cursor = [Number(el.dataset.si), Number(el.dataset.li)]; const l = st.doc.sections[fl.cursor[0]].lines[fl.cursor[1]]; if (!fl.armed && l.t >= 0) fl.t = l.t; drawFollow(false); };
  document.addEventListener("keydown", (e) => {
    if ($("follow").hidden || !$("modal").hidden) {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); saveNow(); }
      return;
    }
    if (e.key === "t" || e.key === "T") stamp();
    if (e.key === " ") { e.preventDefault(); $("flPlay").click(); }
    if (e.key === "Escape") closeFollow();
  });
}

boot();
