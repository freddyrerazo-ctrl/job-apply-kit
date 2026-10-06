// Job Apply Kit — Settings page.

const $ = (id) => document.getElementById(id);
const { esc, send } = Kit;

const PROFILE_FIELDS = [
  ["first_name", "First name"], ["last_name", "Last name"],
  ["full_name", "Full name"], ["email", "Email", "email"],
  ["phone", "Phone"], ["location", "City / location", "text", "e.g. Atlanta, GA"],
  ["linkedin", "LinkedIn", "url"], ["github", "GitHub", "url", "leave blank if none"],
  ["website", "Website or portfolio", "url", "leave blank if none"],
  ["current_company", "Current company"], ["current_title", "Current title"],
  ["years_experience", "Years of experience", "text", "e.g. 2"],
  ["work_authorized", "Authorized to work here?", "text", "Yes or No"],
  ["needs_sponsorship", "Need visa sponsorship?", "text", "Yes or No"],
  ["how_heard", "How did you hear about us?"]
];
const REFERRAL_FIELDS = ["headline", "pitch", "message", "note", "note_limit", "followup"];

let settings = null;
let saveTimer = null;

function flashSaved(text) {
  const el = $("saved");
  el.textContent = text || "Saved";
  el.classList.add("show");
  clearTimeout(flashSaved.timer);
  flashSaved.timer = setTimeout(() => el.classList.remove("show"), 1400);
}

// ------------------------------------------------------------------ answers

function answerRow(a) {
  const row = document.createElement("div");
  row.className = "answer";
  row.innerHTML = `
    <input type="text" class="a-match" aria-label="Words in the question"
      placeholder="salary, compensation" value="${esc(a.match || "")}">
    <input type="text" class="a-answer" aria-label="Your answer"
      placeholder="Your answer" value="${esc(a.answer || "")}">
    <button class="btn sm a-remove" type="button">Remove</button>`;
  row.querySelector(".a-remove").onclick = () => { row.remove(); queueSave(); };
  return row;
}

function readAnswers() {
  return Array.from(document.querySelectorAll("#answers .answer")).map((row) => ({
    match: row.querySelector(".a-match").value.trim(),
    answer: row.querySelector(".a-answer").value.trim()
  })).filter((a) => a.match || a.answer);
}

// --------------------------------------------------------------- load / save

function collect() {
  const next = JSON.parse(JSON.stringify(settings));
  for (const [key] of PROFILE_FIELDS) next.profile[key] = $("p-" + key).value.trim();
  next.profile.resume_url = $("p-resume_url").value.trim();
  for (const key of REFERRAL_FIELDS) {
    const v = $("r-" + key).value;
    next.referral[key] = key === "note_limit" ? (Number(v) || 200) : v.trim();
  }
  next.followUpDays = Number($("follow-days").value) || 7;
  next.applicationsSheet = $("sheet-link").value.trim();
  next.applicationStatus = $("app-status").value.trim();
  next.loginNote = $("app-login-note").value.trim();
  next.readLinkedIn = $("read-linkedin").checked;
  next.answers = readAnswers();
  return next;
}

function queueSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    settings = collect();
    await Kit.saveSettings(settings);
    flashSaved();
  }, 350);
}

async function load() {
  settings = await Kit.loadSettings();

  $("profile-grid").innerHTML = PROFILE_FIELDS.map(([key, label, type, hint]) => `
    <div><label for="p-${key}">${esc(label)}</label>
      <input id="p-${key}" type="${type || "text"}" placeholder="${esc(hint || "")}"
        spellcheck="false"></div>`).join("");
  for (const [key] of PROFILE_FIELDS) $("p-" + key).value = settings.profile[key] || "";
  $("p-resume_url").value = settings.profile.resume_url || "";

  for (const key of REFERRAL_FIELDS) {
    const v = settings.referral[key];
    $("r-" + key).value = Array.isArray(v) ? v.join("\n") : (v == null ? "" : v);
  }
  $("follow-days").value = settings.followUpDays || 7;
  $("app-status").value = settings.applicationStatus == null ? "Applied" : settings.applicationStatus;
  $("app-login-note").value = settings.loginNote || "";
  $("read-linkedin").checked = settings.readLinkedIn !== false;

  const box = $("answers");
  (settings.answers.length ? settings.answers : [{}]).forEach((a) => box.appendChild(answerRow(a)));
  $("answer-add").onclick = () => {
    const row = answerRow({});
    box.appendChild(row);
    row.querySelector("input").focus();
  };

  $("sheet-url").value = settings.sheetUrl || "";
  $("sheet-link").value = settings.applicationsSheet || "";
  const showLink = () => {
    $("open-apps-sheet").href = sheetLink() || "https://docs.google.com/spreadsheets/";
  };
  $("sheet-link").addEventListener("input", showLink);
  showLink();

  document.querySelector(".page").addEventListener("input", (e) => {
    if (e.target.id !== "sheet-url") queueSave();
  });
  $("copy-script").onclick = copyScript;
  $("sheet-test").onclick = testLink;
  if (settings.sheetUrl) testLink();
}

// ---------------------------------------------------------------- sheet link

const LINK_SLOT = "PASTE_YOUR_SPREADSHEET_LINK_HERE";

// The spreadsheet link typed above, or "" if it isn't a Google Sheets link.
function sheetLink() {
  const link = $("sheet-link").value.trim();
  return /^https:\/\/docs\.google\.com\/spreadsheets\/d\/[\w-]{20,}[^\s"'\\]*$/.test(link) ? link : "";
}

// Copies Code.gs with your spreadsheet's link written into it.
async function copyScript() {
  const btn = $("copy-script");
  const note = $("copy-note");
  const link = sheetLink();
  note.textContent = "";
  try {
    let text = await (await fetch(chrome.runtime.getURL("Code.gs"))).text();
    if (text.includes(LINK_SLOT)) {
      if (!link) {
        $("sheet-link").focus();
        note.textContent = "Paste your spreadsheet's link in the box above first.";
        return;
      }
      text = text.replace(LINK_SLOT, link);
    }
    await navigator.clipboard.writeText(text);
    btn.textContent = "Copied";
  } catch {
    note.textContent = "Couldn't copy. Open extension/Code.gs in a text editor and copy it from there.";
  }
  setTimeout(() => (btn.textContent = "Copy the script"), 2500);
}

function sheetCard(title, info) {
  if (!info || info.ok === false) {
    return `<div class="card"><b>${esc(title)}</b>
      <div class="msg bad">${esc((info && info.error) || "Not available.")}</div></div>`;
  }
  const cols = Object.entries(info.columns || {})
    .filter(([key]) => key !== "name" || !info.columns.first)
    .map(([, c]) => `${esc(c.heading)} (column ${esc(c.letter)})`).join(", ");
  const missing = (info.missing || []).length
    ? `<div class="msg warn">No column found for: ${esc(info.missing.join(", "))}.
        Add a heading with that name to have it filled in.</div>` : "";
  const has = info.columns || {};
  const absent = title !== "Applications" ? []
    : [["url", "Link", "posting links"], ["notes", "Notes", "your notes"]]
        .filter(([key]) => !has[key]);
  const noLink = absent.length
    ? `<div class="msg warn">${absent.map(([, heading, what]) =>
        `There's no “${heading}” column, so ${what} aren't kept.`).join(" ")}
        Add ${absent.length > 1 ? "those headings" : "that heading"} to your sheet if you want them.</div>` : "";
  return `<div class="card"><b>${esc(title)}</b>
    “${esc(info.file)}”, tab “${esc(info.tab)}”${info.created ? " (created just now)" : ""}, ${info.rows} row${info.rows === 1 ? "" : "s"}.
    <a href="${esc(info.url)}" target="_blank" rel="noopener">Open</a>
    <div class="cols">Writes to: ${cols || "nothing yet"}</div>${missing}${noLink}</div>`;
}

async function testLink() {
  const out = $("sheet-result");
  const btn = $("sheet-test");
  const url = $("sheet-url").value.trim().replace(/[?#].*$/, "").replace(/\/dev$/, "/exec");
  const changed = url !== (settings.sheetUrl || "");

  if (!url) {
    if (changed) {
      settings = collect(); settings.sheetUrl = "";
      await Kit.saveSettings(settings);
      await send({ type: "reset" });
      out.innerHTML = `<div class="msg warn">Unlinked. Nothing will be logged until you add a link.</div>`;
    } else {
      out.innerHTML = "";
    }
    return;
  }

  btn.disabled = true; btn.textContent = "Testing…";
  out.innerHTML = `<div class="note">Asking your sheet… the first time can take a few seconds.</div>`;
  const res = await send({ type: "ping", url });
  btn.disabled = false; btn.textContent = "Save and test";

  if (!res.ok) {
    out.innerHTML = `<div class="msg bad">${esc(res.error)}${changed ? " The link was not saved." : ""}</div>`;
    return;
  }
  if (changed) {
    settings = collect(); settings.sheetUrl = url;
    await Kit.saveSettings(settings);
    $("sheet-url").value = url;
    await send({ type: "reset" });
  }
  send({ type: "sync", force: true });
  out.innerHTML = `<div class="msg good">Linked${changed ? " and saved" : ""}. You can close this tab.</div>` +
    sheetCard("Applications", res.applications) + sheetCard("Referrals", res.referrals);
}

load();
