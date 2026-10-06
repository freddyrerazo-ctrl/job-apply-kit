// Job Apply Kit — popup.
//
// Two tabs, each backed by a Google Sheet:
//   Applications  company / position / location / date submitted
//   Referrals     who you messaged, the company they work for, and when
//
// The popup only shows and collects; the background worker does the saving
// so nothing is lost when the popup closes.

const $ = (id) => document.getElementById(id);
const val = (id) => $(id).value.trim();
const { esc, send } = Kit;

const STATUSES = ["Messaged", "Replied", "Referred", "No reply"];

const S = {
  settings: null,
  ui: null,              // remembered between opens (tab, draft, positions)
  tab: null,             // the browser tab the popup was opened on
  apps: { rows: [] },
  refs: { rows: [] },
  view: "apps",          // "apps" | "refs"
  refView: "list",       // "write" | "list"
  mode: "full",          // "full" | "note"
  limit: null,
  edited: false,         // the message was changed by hand
  autoPosition: "",      // position we filled in (safe to replace)
  profileUrl: "",
  appFrom: null,         // what the application form was pre-filled with
  syncing: false
};

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.style.display = "block";
  clearTimeout(toast.timer);
  // longer messages stay up longer
  toast.timer = setTimeout(() => (t.style.display = "none"),
    Math.min(9000, 2400 + msg.length * 30));
}

const linked = () => !!(S.settings && S.settings.sheetUrl);

async function activeTab() {
  const forced = new URLSearchParams(location.search).get("tab");  // testing
  if (forced) return chrome.tabs.get(Number(forced));
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  return t;
}

function saveUi(patch) {
  Object.assign(S.ui, patch);
  chrome.storage.local.set({ ui: S.ui });
}

function openSettings() { chrome.runtime.openOptionsPage(); }

async function copyText(text, box) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    if (!box) return false;
    box.focus(); box.select();
    return document.execCommand("copy");
  }
}

// ---------------------------------------------------------------- start-up

async function init() {
  S.settings = await Kit.loadSettings();
  const got = await chrome.storage.local.get(["ui", "apps", "refs"]);
  S.ui = Object.assign({ tab: "apps", refView: "list", mode: "full",
                         company: "", position: "", positions: {} }, got.ui);
  S.apps = got.apps || { rows: [] };
  S.refs = got.refs || { rows: [] };
  try { S.tab = await activeTab(); } catch { S.tab = null; }

  // On someone's LinkedIn profile, go straight to writing them a message.
  const onProfile = !!S.tab && Detect.isLinkedInProfile(S.tab.url);
  S.view = onProfile ? "refs" : S.ui.tab;
  S.refView = onProfile ? "write" : S.ui.refView;
  S.mode = S.ui.mode === "note" ? "note" : "full";

  wire();
  showView();
  renderSheetState();
  renderApps();
  renderRefs();
  prefillApplication();
  prefillReferral();

  chrome.storage.onChanged.addListener(onStorage);
  sync(false);
}

async function sync(force) {
  if (!linked()) return;
  S.syncing = true; renderSheetState();
  await send({ type: "sync", force });
  S.syncing = false; renderSheetState();
}

function onStorage(changes, area) {
  if (area !== "local") return;
  if (changes.apps) {
    S.apps = changes.apps.newValue || { rows: [] };
    renderApps(); appHint(); refExtras();
    // An application at this company just arrived: use its position.
    const pos = $("ref-position");
    if (!pos.value) {
      S.autoPosition = positionFor(val("ref-company"));
      pos.value = S.autoPosition;
      if (!S.edited) rebuildReferral();
    }
  }
  if (changes.refs) {
    S.refs = changes.refs.newValue || { rows: [] };
    renderRefs(); refExtras();
  }
  if (changes.apps || changes.refs) renderSheetState();
}

function showView() {
  $("view-apps").hidden = S.view !== "apps";
  $("view-refs").hidden = S.view !== "refs";
  $("tab-apps").classList.toggle("active", S.view === "apps");
  $("tab-refs").classList.toggle("active", S.view === "refs");
  $("ref-write").hidden = S.refView !== "write";
  $("ref-people").hidden = S.refView !== "list";
  $("ref-v-write").classList.toggle("active", S.refView === "write");
  $("ref-v-list").classList.toggle("active", S.refView === "list");
}

function renderSheetState() {
  const el = $("sheet-state");
  const err = S.apps.error || S.refs.error;
  el.className = "";
  el.title = "Open Settings";
  if (!linked()) {
    el.textContent = "sheet: not linked";
  } else if (S.syncing) {
    el.textContent = "sheet: syncing…"; el.classList.add("on");
  } else if (err) {
    el.textContent = "sheet: problem"; el.classList.add("bad"); el.title = err;
  } else {
    el.textContent = "sheet: linked"; el.classList.add("on");
  }
}

function notLinkedHtml(what) {
  return `<div class="empty">Link your Google Sheet to keep ${what} here.
    It takes about two minutes, once.<br>
    <button class="btn primary setup" type="button">Set up the link</button></div>`;
}

function problemRow(error) {
  return `<div class="row failed"><div class="meta">
      <div class="sub">Couldn't read your sheet: ${esc(error)}</div></div>
    <div class="acts"><button class="btn sm resync" type="button">Try again</button></div>
  </div>`;
}

function pendingActs(r) {
  if (r.pending === "failed") {
    return `<button class="btn sm retry" type="button">Retry</button>
            <button class="btn sm discard" type="button">Remove</button>`;
  }
  return `<span class="note">saving…</span>`;
}

// Clicks shared by both lists.
function listClick(e) {
  const row = e.target.closest(".row");
  if (e.target.closest(".setup")) return openSettings();
  if (e.target.closest(".resync")) return sync(true);
  if (!row) return;
  if (e.target.closest(".retry")) return send({ type: "retry", id: row.dataset.id });
  if (e.target.closest(".discard")) return send({ type: "discard", id: row.dataset.id });
  const link = e.target.closest("a[data-url]");
  if (link) { e.preventDefault(); chrome.tabs.create({ url: link.dataset.url }); }
}

// ============================================================ Applications

function renderApps() {
  const rows = S.apps.rows || [];
  const saved = rows.filter((r) => !r.pending).length;
  const total = Math.max(typeof S.apps.total === "number" ? S.apps.total : 0, saved);
  $("app-count").textContent = total ? `Applications logged: ${total}` : "Applications";
  $("app-open").hidden = !(S.apps.meta && S.apps.meta.url);

  notesHint();
  loginField();
  const box = $("app-list");
  if (!linked()) { box.innerHTML = notLinkedHtml("your applications"); return; }
  let html = S.apps.error ? problemRow(S.apps.error) : "";
  if (!rows.length && !S.apps.error) {
    html = `<div class="empty">${S.apps.at
      ? "Nothing logged yet. Add your first application above."
      : "Reading your sheet…"}</div>`;
  }
  box.innerHTML = html + rows.map(appRowHtml).join("");
}

function appRowHtml(r) {
  const title = r.url
    ? `<a href="#" data-url="${esc(r.url)}" title="Open the posting">${esc(r.company || "(no company)")}</a>`
    : esc(r.company || "(no company)");
  const sub = r.pending === "failed"
    ? `Not saved: ${esc(r.error || "unknown problem")}`
    : esc([r.position, r.location].filter(Boolean).join(" · ") || "—");
  const note = r.notes && r.pending !== "failed"
    ? `<div class="sub" title="${esc(r.notes)}">Note: ${esc(r.notes)}</div>` : "";
  const acts = r.pending
    ? pendingActs(r)
    : `<span class="note">${esc(Kit.prettyDate(r.date))}</span>
       <button class="btn sm people" type="button"
         title="Search LinkedIn for people at this company">Find people</button>`;
  return `<div class="row ${r.pending || ""}" data-id="${esc(r.id || "")}"
      data-company="${esc(r.company)}" data-position="${esc(r.position)}">
    <div class="meta"><div class="title">${title}</div><div class="sub">${sub}</div>${note}</div>
    <div class="acts">${acts}</div></div>`;
}

// Notes are only kept if your sheet has a column for them. Returns null
// until the sheet has been read once.
function hasNotesColumn() {
  const cols = S.apps.meta && S.apps.meta.columns;
  return cols ? !!cols.notes : null;
}

// "Login used" is only offered when your tracker has a column for it.
function loginField() {
  const cols = S.apps.meta && S.apps.meta.columns;
  const show = !!(linked() && cols && cols.login);
  $("app-login-wrap").hidden = !show;
  $("app-extra").classList.toggle("solo", !show);
  const box = $("app-login");
  if (show && !box.value && !S.loginTouched) box.value = S.settings.loginNote || "";
}

function notesHint() {
  const el = $("app-notes-hint");
  const missing = linked() && hasNotesColumn() === false;
  el.hidden = !missing;
  if (missing) {
    el.innerHTML = `<span class="chip warn">won't be saved</span> Your sheet has ` +
      `no Notes column. Add a column headed “Notes” to keep these.`;
  }
}

// Pre-fill the form from the job posting in the current tab.
async function prefillApplication() {
  $("app-date").value = Kit.today();
  const t = S.tab;
  if (!t || !/^https?:/.test(t.url || "") || Detect.isLinkedInProfile(t.url)) return;
  let page = null;
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: t.id }, func: Detect.readJobPage
    });
    page = res && res.result;
  } catch { /* a page we can't read: fall back to the tab title */ }
  const job = Detect.job(t, page);
  if (!job.confident || (!job.company && !job.position)) return;
  if (val("app-company") || val("app-position") || val("app-location")) return;
  $("app-company").value = job.company;
  $("app-position").value = job.position;
  $("app-location").value = job.location;
  S.appFrom = job;
  appHint();
}

// The same posting (by its link) or the same company + position.
function appDuplicate() {
  const key = Kit.companyKey(val("app-company"));
  const position = val("app-position");
  const from = S.appFrom;
  const here = from && Kit.same(from.company, val("app-company")) &&
    Kit.same(from.position, position) ? from.url : "";
  return (S.apps.rows || []).find((r) =>
    (here && r.url && r.url === here) ||
    (key && Kit.companyKey(r.company) === key && Kit.same(r.position, position))) || null;
}

function appHint() {
  const dupe = appDuplicate();
  const hint = $("app-hint");
  if (dupe && dupe.pending) {
    hint.innerHTML = `<span class="chip warn">in the list below</span> not saved yet`;
  } else if (dupe) {
    hint.innerHTML = `<span class="chip warn">already logged</span> ` +
      esc(dupe.date ? `on ${Kit.prettyDate(dupe.date)}` : "in your sheet");
  } else if (S.appFrom && Kit.same(S.appFrom.company, val("app-company")) &&
             Kit.same(S.appFrom.position, val("app-position"))) {
    hint.textContent = "Read from this page. Check it, then add.";
  } else {
    hint.textContent = "";
  }
}

async function addApplication(e) {
  e.preventDefault();
  const rec = {
    company: val("app-company"), position: val("app-position"),
    location: val("app-location"), date: $("app-date").value || Kit.today()
  };
  if (val("app-notes")) rec.notes = val("app-notes");
  if (!$("app-login-wrap").hidden && val("app-login")) rec.login = val("app-login");
  const status = String(S.settings.applicationStatus || "").trim();
  if (status) rec.status = status;
  if (!rec.company && !rec.position) {
    $("app-company").focus();
    return toast("Type the company and position first.");
  }
  if (!linked()) return toast("Link your Google Sheet first (Settings).");
  // Keep the posting's link when the form still describes this page.
  const from = S.appFrom;
  if (from && (Kit.same(from.company, rec.company) || Kit.same(from.position, rec.position))) {
    rec.url = from.url;
  }
  const btn = $("app-add");
  btn.disabled = true; btn.textContent = "Adding…";
  const r = await send({ type: "add", sheet: "applications", record: rec });
  btn.disabled = false; btn.textContent = "Add to sheet";
  // The sheet answers with the row as it was written, so a note that had
  // nowhere to go is reported instead of quietly disappearing.
  const noteLost = r.ok && rec.notes && r.record && !("notes" in r.record);
  const caveats = (noteLost
    ? ["The note wasn't saved: your sheet has no Notes column."] : [])
    .concat(r.warnings || []);
  toast(r.ok
    ? `Added ${rec.company || rec.position} to your sheet.` +
      (caveats.length ? " " + caveats.join(" ") : "")
    : `Not saved yet: ${r.error} It's kept in the list below.`);
  ["app-company", "app-position", "app-location", "app-notes"]
    .forEach((id) => ($(id).value = ""));
  S.appFrom = null;
  appHint();
}

function findPeople(company, position) {
  if (!company && !position) return toast("Type a company first.");
  // Have the Referrals tab ready for when you land on someone's profile.
  const positions = Object.assign({}, S.ui.positions);
  if (company && position) positions[Kit.companyKey(company)] = position;
  saveUi({ company, position, positions });
  chrome.tabs.create({ url: Detect.peopleSearchUrl(company, position) });
}

// =============================================================== Referrals

// The position to suggest for a company: what you used last time, else the
// one you applied for there.
function positionFor(company) {
  const key = Kit.companyKey(company);
  if (!key) return S.ui.position || "";
  if (S.ui.positions && S.ui.positions[key]) return S.ui.positions[key];
  const applied = (S.apps.rows || []).find((r) =>
    r.position && Kit.companyKey(r.company) === key);
  if (applied) return applied.position;
  return Kit.companyKey(S.ui.company) === key ? (S.ui.position || "") : "";
}

function jobUrlFor(company, position) {
  const key = Kit.companyKey(company);
  if (!key || !position) return "";
  const hit = (S.apps.rows || []).find((r) =>
    r.url && Kit.companyKey(r.company) === key && Kit.same(r.position, position));
  return hit ? hit.url : "";
}

// Find the person's name and company from the profile in the current tab.
async function prefillReferral() {
  const t = S.tab;
  let name = "", company = "", via = "";
  const onProfile = !!t && Detect.isLinkedInProfile(t.url);
  if (onProfile) {
    name = Detect.nameFromTitle(t.title);
    S.profileUrl = Detect.profileUrl(t.url);
    if (S.settings.readLinkedIn !== false) {
      try {
        const [res] = await chrome.scripting.executeScript({
          target: { tabId: t.id }, func: Detect.readLinkedInProfile
        });
        const p = (res && res.result) || {};
        name = p.name || name;
        company = p.company || "";
        via = p.via || "";
      } catch { /* couldn't read the page: the tab title still gives the name */ }
    }
  }
  const who = Detect.splitName(name);
  if (!val("ref-first") && !val("ref-last")) {
    $("ref-first").value = who.first;
    $("ref-last").value = who.last;
  }
  const kept = !company && !!S.ui.company;     // fall back to last time's
  if (!val("ref-company")) $("ref-company").value = company || S.ui.company || "";
  if (!val("ref-position")) {
    S.autoPosition = positionFor(val("ref-company"));
    $("ref-position").value = S.autoPosition;
  }

  const found = $("ref-found");
  if (!onProfile) {
    found.textContent = "";
  } else if (company && via === "headline") {
    found.textContent = "Name read from this profile. The company is a guess " +
      "from their headline, so check it.";
  } else if (company) {
    found.textContent = "Name and company read from this profile.";
  } else if (who.first && kept) {
    found.textContent = "Name read from this profile. Couldn't find their " +
      "company, so it's the one from last time. Check it.";
  } else if (who.first) {
    found.textContent = "Name read from this profile. Couldn't find their " +
      "company, so type it in.";
  } else {
    found.textContent = "Couldn't read this profile. Type their name and company.";
  }

  rebuildReferral();
  refExtras();
}

function saveDraft() {
  const company = val("ref-company"), position = val("ref-position");
  const positions = Object.assign({}, S.ui.positions);
  const key = Kit.companyKey(company);
  if (key && position) positions[key] = position;
  saveUi({ company, position, positions, mode: S.mode });
}

function rebuildReferral() {
  const company = val("ref-company"), position = val("ref-position");
  const out = Referral.build({
    mode: S.mode, position, company, name: val("ref-first"),
    profile: S.settings.profile, settings: S.settings.referral,
    jobUrl: jobUrlFor(company, position)
  });
  S.limit = out.limit;
  S.edited = false;
  $("ref-text").value = out.text;
  $("ref-hint").textContent = out.hint;
  for (const m of ["full", "note"]) {
    const b = $("ref-mode-" + m);
    b.classList.toggle("active", S.mode === m);
    b.setAttribute("aria-pressed", String(S.mode === m));
  }
  countReferral();
}

function countReferral() {
  const n = $("ref-text").value.length;
  const c = $("ref-count");
  c.textContent = S.limit ? `${n} / ${S.limit}` : "";
  c.classList.toggle("over", !!S.limit && n > S.limit);
}

function refDuplicate() {
  const first = val("ref-first"), last = val("ref-last");
  const here = S.profileUrl.toLowerCase();
  return (S.refs.rows || []).find((r) => {
    const theirs = String(r.profile || "").toLowerCase().replace(/\/+$/, "");
    if (here && theirs && theirs === here) return true;
    return !!first && !!last && Kit.same(r.first, first) && Kit.same(r.last, last);
  }) || null;
}

// The bits around the message that depend on the sheets.
function refExtras() {
  const dupe = refDuplicate();
  const banner = $("ref-dupe");
  banner.hidden = !dupe;
  if (dupe) {
    const who = [dupe.first, dupe.last].filter(Boolean).join(" ");
    const when = dupe.pending ? "just now"
      : (dupe.date ? `on ${Kit.prettyDate(dupe.date)}` : "before");
    const status = dupe.status && !dupe.pending ? ` (${dupe.status})` : "";
    banner.textContent = `You already messaged ${who} ${when}${status}.`;
  }
  const company = val("ref-company");
  $("ref-find").textContent = company
    ? `Find people at ${company} on LinkedIn` : "Find people on LinkedIn";

  // Suggest positions you've applied for, this company's first.
  const key = Kit.companyKey(company);
  const seen = new Set();
  const rows = (S.apps.rows || []).filter((r) => r.position);
  const ordered = rows.filter((r) => Kit.companyKey(r.company) === key)
    .concat(rows.filter((r) => Kit.companyKey(r.company) !== key));
  const list = $("ref-jobs");
  list.textContent = "";
  for (const r of ordered) {
    const k = r.position.toLowerCase();
    if (seen.has(k) || seen.size >= 30) continue;
    seen.add(k);
    const o = document.createElement("option");
    o.value = r.position;
    if (r.company) o.label = r.company;
    list.appendChild(o);
  }
}

async function copyReferral(log) {
  const box = $("ref-text");
  const text = box.value.trim();
  if (!text) return toast("Nothing to copy yet.");
  if (text.includes(Referral.BLANK)) {
    $("ref-position").focus();
    return toast("Add the position first.");
  }
  if (!(await copyText(text, box))) {
    return toast("Couldn't copy. Select the text and press Ctrl+C.");
  }
  const over = S.limit && text.length > S.limit
    ? ` It's over ${S.limit} characters for a connection note.` : "";
  if (!log) {
    return toast("Copied. Paste it into your message and send it yourself." + over);
  }

  const first = val("ref-first"), last = val("ref-last");
  if (!first && !last) {
    $("ref-first").focus();
    return toast("Copied. Add their name to log them." + over);
  }
  if (!linked()) {
    return toast("Copied. Link your Google Sheet in Settings to log who you message.");
  }
  saveDraft();                 // remember this position for this company
  // Not awaited: the background worker finishes this even if the popup closes.
  send({ type: "add", sheet: "referrals", record: {
    first, last, company: val("ref-company"), position: val("ref-position"),
    date: Kit.today(), status: "Messaged", profile: S.profileUrl
  } }).then((r) => { if (r && r.ok === false) toast(`Not logged yet: ${r.error}`); });
  const who = [first, last].filter(Boolean).join(" ");
  toast(`Copied, and logging ${who} to your sheet.` + over);
}

function isDue(r, days) {
  if (r.pending) return false;
  const since = Kit.daysSince(r.date);
  return (r.status || "Messaged") === "Messaged" && since !== null && since >= days;
}

function renderRefs() {
  const rows = S.refs.rows || [];
  const days = Number(S.settings.followUpDays) || 7;
  const saved = rows.filter((r) => !r.pending).length;
  const total = Math.max(typeof S.refs.total === "number" ? S.refs.total : 0, saved);
  const due = rows.filter((r) => isDue(r, days)).length;
  $("ref-v-list").textContent = total ? `People messaged (${total})` : "People messaged";
  $("ref-total").textContent = due
    ? `${due} to follow up` : (total ? "Newest first" : "People messaged");
  $("ref-open").hidden = !(S.refs.meta && S.refs.meta.url);

  const box = $("ref-list");
  if (!linked()) { box.innerHTML = notLinkedHtml("the people you message"); return; }
  let html = S.refs.error ? problemRow(S.refs.error) : "";
  if (!rows.length && !S.refs.error) {
    html = `<div class="empty">${S.refs.at
      ? "No one logged yet. Open someone's LinkedIn profile, then use “Write a message”."
      : "Reading your sheet…"}</div>`;
  }
  const canSetStatus = !!(S.refs.meta && S.refs.meta.columns && S.refs.meta.columns.status);
  box.innerHTML = html + rows.map((r) => refRowHtml(r, days, canSetStatus)).join("");
}

function refRowHtml(r, days, canSetStatus) {
  const name = [r.first, r.last].filter(Boolean).join(" ") || "(no name)";
  const title = r.profile
    ? `<a href="#" data-url="${esc(r.profile)}" title="Open their profile">${esc(name)}</a>`
    : esc(name);
  const due = isDue(r, days);
  let sub;
  if (r.pending === "failed") {
    sub = `Not saved: ${esc(r.error || "unknown problem")}`;
  } else {
    sub = esc([r.company, r.position, Kit.prettyDate(r.date)].filter(Boolean).join(" · "));
  }
  const nudge = due
    ? `<div class="sub"><span class="chip warn">${Kit.daysSince(r.date)} days, no reply</span></div>` : "";
  let acts;
  if (r.pending) {
    acts = pendingActs(r);
  } else {
    const current = r.status || "Messaged";
    const options = (STATUSES.includes(current) ? STATUSES : [current].concat(STATUSES))
      .map((s) => `<option${s === current ? " selected" : ""}>${esc(s)}</option>`).join("");
    acts = (due ? `<button class="btn sm nudge" type="button"
        title="Copy a short follow-up message">Follow up</button>` : "") +
      (canSetStatus
        ? `<select class="status" aria-label="Status for ${esc(name)}">${options}</select>` : "");
  }
  return `<div class="row ${r.pending || ""}" data-id="${esc(r.id || "")}" data-row="${r.row || ""}">
    <div class="meta"><div class="title">${title}</div><div class="sub">${sub}</div>${nudge}</div>
    <div class="acts">${acts}</div></div>`;
}

function refByRow(el) {
  const n = Number(el.closest(".row").dataset.row);
  return (S.refs.rows || []).find((r) => r.row === n && !r.pending);
}

async function setStatus(select) {
  const r = refByRow(select);
  if (!r) return;
  const before = r.status || "Messaged";
  select.disabled = true;
  const res = await send({
    type: "update", sheet: "referrals", row: r.row,
    fields: { status: select.value }, expect: { first: r.first, last: r.last }
  });
  select.disabled = false;
  if (!res.ok) { select.value = before; toast(`Not changed: ${res.error}`); }
}

async function copyFollowUp(btn) {
  const r = refByRow(btn);
  if (!r) return;
  const text = Referral.followup({
    name: r.first, position: r.position, company: r.company,
    profile: S.settings.profile, settings: S.settings.referral
  });
  if (!(await copyText(text))) return toast("Couldn't copy the follow-up.");
  toast(`Follow-up for ${r.first || "them"} copied. Click their name to open the profile.`);
}

// ============================================================ Fill the page

async function sendToPage(msg) {
  const t = S.tab || (await activeTab());
  try {
    return await chrome.tabs.sendMessage(t.id, msg);
  } catch {
    // Not a job board we auto-load on: load the filler on demand, then retry.
    await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ["content.js"] });
    return chrome.tabs.sendMessage(t.id, msg);
  }
}

async function fillPage() {
  try {
    const r = await sendToPage({
      action: "fill", profile: S.settings.profile, answers: S.settings.answers
    });
    if (r && r.error) return toast(r.error);
    toast(`Filled ${r.filled} field${r.filled === 1 ? "" : "s"}` +
      (r.skipped ? `, left ${r.skipped} you'd already filled.` : ".") +
      " Review, attach your resume, and submit when ready.");
  } catch {
    toast("Can't fill this page (browser pages and the Web Store are off limits).");
  }
}

// ------------------------------------------------------------------- wiring

function wire() {
  $("tab-apps").onclick = () => { S.view = "apps"; saveUi({ tab: "apps" }); showView(); };
  $("tab-refs").onclick = () => { S.view = "refs"; saveUi({ tab: "refs" }); showView(); };
  $("ref-v-write").onclick = () => {
    S.refView = "write"; saveUi({ refView: "write" }); showView();
  };
  $("ref-v-list").onclick = () => {
    S.refView = "list"; saveUi({ refView: "list" }); showView();
  };

  $("sheet-state").onclick = openSettings;
  $("settings").onclick = openSettings;
  $("finder").onclick = () => { location.href = "finder.html" + location.search; };
  $("fill").onclick = fillPage;

  // Applications
  $("app-form").addEventListener("submit", addApplication);
  ["app-company", "app-position"].forEach((id) => $(id).addEventListener("input", appHint));
  $("app-login").addEventListener("input", () => { S.loginTouched = true; });
  $("app-open").onclick = (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: S.apps.meta.url });
  };
  $("app-list").addEventListener("click", (e) => {
    const people = e.target.closest(".people");
    if (people) {
      const row = people.closest(".row");
      return findPeople(row.dataset.company, row.dataset.position);
    }
    listClick(e);
  });

  // Referrals: writing
  ["ref-first", "ref-last"].forEach((id) => $(id).addEventListener("input", () => {
    rebuildReferral(); refExtras();
  }));
  $("ref-company").addEventListener("input", () => {
    const pos = $("ref-position");
    if (!pos.value || pos.value === S.autoPosition) {
      S.autoPosition = positionFor(val("ref-company"));
      pos.value = S.autoPosition;
    }
    saveDraft(); rebuildReferral(); refExtras();
  });
  $("ref-position").addEventListener("input", () => {
    S.autoPosition = "";
    saveDraft(); rebuildReferral();
  });
  $("ref-mode-full").onclick = () => { S.mode = "full"; saveDraft(); rebuildReferral(); };
  $("ref-mode-note").onclick = () => { S.mode = "note"; saveDraft(); rebuildReferral(); };
  $("ref-text").addEventListener("input", () => { S.edited = true; countReferral(); });
  $("ref-copy").onclick = () => copyReferral(false);
  $("ref-log").onclick = () => copyReferral(true);
  $("ref-find").onclick = (e) => {
    e.preventDefault();
    findPeople(val("ref-company"), val("ref-position"));
  };

  // Referrals: the list
  $("ref-open").onclick = (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: S.refs.meta.url });
  };
  $("ref-list").addEventListener("click", (e) => {
    const nudge = e.target.closest(".nudge");
    if (nudge) return copyFollowUp(nudge);
    listClick(e);
  });
  $("ref-list").addEventListener("change", (e) => {
    if (e.target.matches("select.status")) setStatus(e.target);
  });
}

init();
