// Job Apply Kit — background worker.
// All writes to your Google Sheet go through here, so a row you log keeps
// saving even when the popup closes the moment you click back into the page.
// Rows are shown immediately, saved in the background, and retried if the
// connection drops.

importScripts("sheets.js");

const STORE = { applications: "apps", referrals: "refs" };
const FRESH_MS = 30000;            // don't re-read a sheet more often than this

const get = async (key) => (await chrome.storage.local.get(key))[key];
const set = (obj) => chrome.storage.local.set(obj);

// One storage edit at a time.
let editing = Promise.resolve();
function withLock(fn) {
  const run = editing.then(fn);
  editing = run.catch(() => {});
  return run;
}

// One network call per sheet at a time.
const queues = {};
function enqueue(sheet, fn) {
  const run = (queues[sheet] || Promise.resolve()).then(fn);
  queues[sheet] = run.catch(() => {});
  return run;
}

async function sheetUrl() {
  const s = await get("settings");
  return ((s && s.sheetUrl) || "").trim();
}

function patchList(sheet, fn) {
  return withLock(async () => {
    const key = STORE[sheet];
    const cur = (await get(key)) || {};
    cur.rows = cur.rows || [];
    fn(cur);
    await set({ [key]: cur });
  });
}

function patchOutbox(fn) {
  return withLock(async () => {
    const box = (await get("outbox")) || [];
    await set({ outbox: fn(box) });
  });
}

// ------------------------------------------------------------------- reading

async function refresh(sheet, force) {
  const url = await sheetUrl();
  if (!url) return { ok: false, error: "not-linked" };
  const cur = (await get(STORE[sheet])) || {};
  if (!force && !cur.error && cur.at && Date.now() - cur.at < FRESH_MS) return { ok: true };
  return enqueue(sheet, async () => {
    try {
      const data = await Sheets.call(url, { action: "list", sheet, limit: 300 });
      await patchList(sheet, (list) => {
        const waiting = list.rows.filter((r) => r.pending);
        list.rows = waiting.concat(data.rows || []);
        list.total = data.total;
        list.meta = data.meta;
        list.at = Date.now();
        list.error = "";
      });
      return { ok: true };
    } catch (e) {
      await patchList(sheet, (list) => { list.error = e.message; });
      return { ok: false, error: e.message };
    }
  });
}

// ------------------------------------------------------------------- writing

const flying = new Set();          // ids being sent right now

async function add(sheet, record) {
  if (!STORE[sheet]) return { ok: false, error: "Unknown sheet." };
  if (!(await sheetUrl())) {
    return { ok: false, error: "Link your Google Sheet in Settings first." };
  }
  const item = { id: crypto.randomUUID(), sheet, record, at: Date.now() };
  await patchOutbox((box) => box.concat(item));
  await patchList(sheet, (list) => {
    list.rows.unshift(Object.assign({}, record, { id: item.id, pending: "saving" }));
  });
  return enqueue(sheet, () => deliver(item));
}

async function deliver(item) {
  if (flying.has(item.id)) return { ok: true, busy: true };
  flying.add(item.id);
  try {
    const url = await sheetUrl();
    if (!url) throw new Error("Link your Google Sheet in Settings first.");
    // The id lets the sheet ignore the same row if it's ever sent twice.
    const data = await Sheets.call(url, {
      action: "add", sheet: item.sheet, record: item.record, id: item.id
    });
    await patchOutbox((box) => box.filter((x) => x.id !== item.id));
    await patchList(item.sheet, (list) => {
      list.rows = list.rows.filter((r) => r.id !== item.id && r.row !== data.record.row);
      list.rows.unshift(data.record);
      if (data.meta) list.meta = data.meta;
      if (typeof list.total === "number") list.total += 1;
      list.error = "";
    });
    return { ok: true, record: data.record, warnings: data.warnings || [] };
  } catch (e) {
    await patchList(item.sheet, (list) => {
      const row = list.rows.find((r) => r.id === item.id);
      const mark = { pending: "failed", error: e.message };
      if (row) Object.assign(row, mark);
      else list.rows.unshift(Object.assign({}, item.record, { id: item.id }, mark));
    });
    return { ok: false, error: e.message };
  } finally {
    flying.delete(item.id);
  }
}

// Send anything that didn't make it last time.
async function flush() {
  const box = (await get("outbox")) || [];
  for (const item of box) {
    if (!flying.has(item.id)) await enqueue(item.sheet, () => deliver(item));
  }
}

async function retry(id) {
  const item = ((await get("outbox")) || []).find((x) => x.id === id);
  if (!item) return { ok: false, error: "Nothing to retry." };
  await patchList(item.sheet, (list) => {
    const row = list.rows.find((r) => r.id === id);
    if (row) { row.pending = "saving"; delete row.error; }
  });
  return enqueue(item.sheet, () => deliver(item));
}

async function discard(id) {
  await patchOutbox((box) => box.filter((x) => x.id !== id));
  for (const sheet of Object.keys(STORE)) {
    await patchList(sheet, (list) => { list.rows = list.rows.filter((r) => r.id !== id); });
  }
  return { ok: true };
}

async function update(sheet, row, fields, expect) {
  const url = await sheetUrl();
  if (!url) return { ok: false, error: "Link your Google Sheet in Settings first." };
  return enqueue(sheet, async () => {
    try {
      const data = await Sheets.call(url, { action: "update", sheet, row, fields, expect });
      await patchList(sheet, (list) => {
        const i = list.rows.findIndex((r) => r.row === row && !r.pending);
        if (i >= 0) list.rows[i] = data.record;
      });
      return { ok: true, record: data.record };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}

// ------------------------------------------------------------------ messages

const HANDLERS = {
  // Popup opened: send leftovers, then re-read both sheets.
  async sync(msg) {
    await flush();
    const [a, r] = await Promise.all([
      refresh("applications", msg.force), refresh("referrals", msg.force)
    ]);
    return { ok: a.ok && r.ok, applications: a, referrals: r };
  },
  add: (msg) => add(msg.sheet, msg.record || {}),
  update: (msg) => update(msg.sheet, msg.row, msg.fields || {}, msg.expect || {}),
  retry: (msg) => retry(msg.id),
  discard: (msg) => discard(msg.id),
  // Settings page: try a link before saving it.
  async ping(msg) {
    try {
      return await Sheets.call(msg.url, { action: "ping" });
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },
  // The link changed: forget what was cached from the old one.
  async reset() {
    await withLock(() => set({ apps: { rows: [] }, refs: { rows: [] } }));
    return { ok: true };
  }
};

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  const run = HANDLERS[msg && msg.type];
  if (!run) return false;
  Promise.resolve().then(() => run(msg)).then(reply, (e) =>
    reply({ ok: false, error: String((e && e.message) || e) }));
  return true;                      // reply comes later
});

chrome.runtime.onStartup.addListener(() => { flush(); });
