// Job Apply Kit — Job finder (optional).
// Needs the local script (python server/app.py). It pulls new postings from
// official job-board APIs into a checklist; you queue the ones worth applying
// to, and "Applied" logs them to your Google Sheet.

const API = "http://127.0.0.1:8377";
const list = document.getElementById("list");
const dot = document.getElementById("server-dot");
const { esc } = Kit;
let tab = "review";
let jobs = [];
let serverUp = null;     // null until the first check of the local script

document.getElementById("back").href = "popup.html" + location.search;

function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.style.display = "block";
  setTimeout(() => (t.style.display = "none"), 2600);
}

async function api(path, body) {
  const res = await fetch(API + path, body ? {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  } : undefined);
  return res.json();
}

async function load() {
  try {
    const data = await api("/jobs");
    jobs = data.jobs || [];
    serverUp = true;
    dot.textContent = "script: on";
    dot.classList.add("on");
  } catch {
    serverUp = false;
    dot.textContent = "script: off";
    dot.classList.remove("on");
  }
  render();
}

function render() {
  if (serverUp === false) {
    list.innerHTML = `<div class="empty">The job finder needs the local script,
      and it isn't running.<br>Start it from the kit folder:
      <code>python server/app.py</code>
      Everything else in the kit works without it.</div>`;
    return;
  }

  const rows = tab === "review"
    ? jobs.filter((j) => j.status === "New")
    : jobs.filter((j) => j.status === "Queued");

  if (!rows.length) {
    list.innerHTML = `<div class="empty">${tab === "review"
      ? "No new postings to review. “Check sources” pulls the latest."
      : "Queue is empty. Check off postings in Review to queue them."}</div>`;
    return;
  }

  list.innerHTML = rows.map((j) => `
    <div class="row" data-id="${esc(j.id)}">
      ${tab === "review" ? `<input type="checkbox" aria-label="Queue ${esc(j.title)}">` : ""}
      <div class="meta">
        <div class="title">${esc(j.title)}</div>
        <div class="sub">${esc(j.company)} · ${esc(j.location || "—")}
          <span class="chip">${esc(j.source)}</span></div>
      </div>
      <div class="acts">
        ${tab === "queue"
          ? `<button class="btn open" type="button">Open</button>
             <button class="btn primary applied" type="button">Applied</button>`
          : `<button class="btn open" type="button">View</button>`}
      </div>
    </div>`).join("");

  if (tab === "review") {
    const bar = document.createElement("div");
    bar.className = "row";
    bar.innerHTML = `<button class="btn primary" id="queue-checked" type="button"
      style="width:100%">Queue checked postings</button>`;
    list.appendChild(bar);
    bar.querySelector("#queue-checked").onclick = queueChecked;
  }

  list.querySelectorAll(".row[data-id]").forEach((row) => {
    const id = row.dataset.id;
    const job = jobs.find((j) => j.id === id);
    row.querySelector(".open")?.addEventListener("click", () =>
      chrome.tabs.create({ url: job.url, active: true }));
    row.querySelector(".applied")?.addEventListener("click", () => markApplied(job));
  });
}

async function markApplied(job) {
  const r = await api("/status", { id: job.id, status: "Applied" });
  if (r.error) return toast(r.error);
  // Also log it to the Applications sheet.
  const settings = await Kit.loadSettings();
  const record = {
    company: Detect.prettyCompany(job.company), position: job.title,
    location: job.location || "", date: Kit.today(), url: job.url
  };
  if (String(settings.applicationStatus || "").trim()) record.status = settings.applicationStatus.trim();
  if (settings.loginNote) record.login = settings.loginNote;
  const res = await Kit.send({ type: "add", sheet: "applications", record });
  toast(res.ok ? "Logged in your Applications sheet."
    : `Marked applied, but not added to your sheet: ${res.error}`);
  load();
}

async function queueChecked() {
  const checked = [...list.querySelectorAll(".row[data-id] input:checked")]
    .map((c) => c.closest(".row").dataset.id);
  if (!checked.length) return toast("Nothing checked.");
  for (const id of checked) {
    const r = await api("/status", { id, status: "Queued" });
    if (r.error) return toast(r.error);
  }
  toast(`Queued ${checked.length} posting${checked.length > 1 ? "s" : ""}.`);
  load();
}

async function activeTab() {
  const forced = new URLSearchParams(location.search).get("tab");  // testing
  if (forced) return chrome.tabs.get(Number(forced));
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  return t;
}

async function sendToPage(msg) {
  const t = await activeTab();
  try {
    return await chrome.tabs.sendMessage(t.id, msg);
  } catch {
    await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ["content.js"] });
    return chrome.tabs.sendMessage(t.id, msg);
  }
}

document.getElementById("fill").onclick = async () => {
  try {
    const settings = await Kit.loadSettings();
    const r = await sendToPage({
      action: "fill", profile: settings.profile, answers: settings.answers
    });
    if (r?.error) return toast(r.error);
    toast(`Filled ${r.filled} field${r.filled === 1 ? "" : "s"}` +
      (r.skipped ? `, left ${r.skipped} you'd already filled.` : ".") +
      " Review, attach your resume, and submit when ready.");
  } catch {
    toast("Can't fill this page (browser pages are off limits).");
  }
};

document.getElementById("refresh").onclick = async () => {
  toast("Checking sources…");
  try {
    const r = await api("/refresh", {});
    toast(`${r.added} new posting${r.added === 1 ? "" : "s"} added` +
      (r.errors?.length ? `, ${r.errors.length} source error(s): see the terminal.` : "."));
    load();
  } catch {
    toast("Start the local script first: python server/app.py");
  }
};

// Put the job in the current tab into the queue's checklist.
document.getElementById("log-page").onclick = async () => {
  const t = await activeTab();
  try {
    const guess = Detect.jobFromTitle(t.title, t.url);
    const r = await api("/add", {
      title: guess.position || t.title, company: guess.company,
      location: guess.location, url: t.url
    });
    toast(r.error ? r.error :
      (r.added ? "Added to Review as a new posting." : "Already tracked."));
    load();
  } catch {
    toast("Start the local script first: python server/app.py");
  }
};

document.getElementById("tab-review").onclick = (e) => {
  tab = "review"; setTab(e.target); render();
};
document.getElementById("tab-queue").onclick = (e) => {
  tab = "queue"; setTab(e.target); render();
};
function setTab(btn) {
  document.querySelectorAll("nav button").forEach((b) =>
    b.classList.toggle("active", b === btn));
}

load();
