/**
 * Job Apply Kit — Google Sheets link
 * ----------------------------------
 * Lets the Job Apply Kit extension add rows to, and read rows from, two tabs
 * of your job-search spreadsheet:
 *
 *   1. your application tracker  (for example: Position, Company Name,
 *                                 Address, Link, Login Information,
 *                                 Date Applied, Application Status, Notes)
 *   2. "Referral Apps"           (who you messaged, where they work, when)
 *
 * It runs inside your own Google account. Nothing is sent anywhere else.
 *
 * SETUP (once):
 *   1. Open https://script.new  (this makes a NEW, separate script project,
 *      so any script already attached to your sheet is left alone).
 *   2. Delete whatever is in the editor, paste this whole file, click Save.
 *      The extension's "Copy the script" button writes your spreadsheet's
 *      link into SPREADSHEET below. If you copied this file by hand, paste
 *      the link there yourself.
 *   3. Deploy → New deployment → gear icon → Web app.
 *        Execute as:      Me
 *        Who has access:  Anyone
 *      Click Deploy, then Authorize access and allow it.
 *   4. Copy the "Web app URL" and paste it into the extension's Settings.
 *
 * Treat that URL like a password: anyone who has it can read and add rows in
 * these two tabs. If it ever leaks, go to Deploy → Manage deployments,
 * archive it, and make a new deployment.
 *
 * If you edit this file later: Deploy → Manage deployments → pencil →
 * Version: New version → Deploy. (Otherwise the old code keeps running.)
 */

// ---------------------------------------------------------------- settings

// Your job-search spreadsheet: the address from the browser bar when it's open.
const SPREADSHEET = "PASTE_YOUR_SPREADSHEET_LINK_HERE";

// The tracker tab. Leave "" and it is found by its headings (the tab with
// Position / Company Name / Date Applied ...). Or type the tab's exact name.
const APPLICATIONS_TAB = "";

// The tab referrals go in. If no tab with this name exists, one is created.
const REFERRALS_TAB = "Referral Apps";

// Want referrals in a different spreadsheet file instead? Paste its link
// here. Leave "" to keep them in the same spreadsheet as the tracker.
const REFERRALS_SPREADSHEET = "";

// ------------------------------------------------------------------ columns
// Columns are found by their heading, in any order, so your own layout is
// respected. `match` is tested against the heading in lower case; the first
// field in each list that matches a heading claims that column. Common
// misspellings (Compeny, Postion, Loaction ...) are recognised too.

const TABLES = {
  applications: {
    kind: "applications",
    fields: [
      { key: "url",      header: "Link",               match: /\burl\b|link(?!ed)|posting|listing|website/ },
      { key: "date",     header: "Date Applied",       match: /date|submit|summit|applied|when/ },
      { key: "company",  header: "Company Name",       match: /compan|compen[yi]|employer|organi[sz]ation/ },
      { key: "position", header: "Position",           match: /pos\w{0,2}tion|title|role|\bjob\b/ },
      { key: "location", header: "Address",            match: /lo[ac]{2}tion|add?ress|city|where|place|remote/ },
      { key: "login",    header: "Login Information",  match: /log\s?in|account|username|credential/ },
      { key: "status",   header: "Application Status", match: /status|stage|result|outcome|progress/ },
      { key: "notes",    header: "Notes",              match: /note|comment|remark|detail/ }
    ],
    // Headings written only when starting in a brand-new, empty spreadsheet.
    fresh: ["position", "company", "location", "url", "login", "date", "status", "notes"],
    // A row counts as "used" when one of these has a value.
    anchor: ["company", "position"]
  },
  referrals: {
    kind: "referrals",
    fields: [
      { key: "profile",  header: "LinkedIn",       match: /linkedin|profile|\burl\b|link/ },
      { key: "first",    header: "First Name",     match: /first\s*name|^first$|given/ },
      { key: "last",     header: "Last Name",      match: /last\s*name|^last$|surname|family/ },
      { key: "name",     header: "Name",           match: /^(full )?name$|person|contact|^who/ },
      { key: "date",     header: "Date Messaged",  match: /date|mess?age|sent|contacted|reached|when/ },
      { key: "company",  header: "Company",        match: /compan|compen[yi]|employer|organi[sz]ation|works? (at|for)/ },
      { key: "position", header: "Position",       match: /pos\w{0,2}tion|title|role|\bjob\b/ },
      { key: "status",   header: "Status",         match: /status|stage|repl|result|outcome/ },
      { key: "notes",    header: "Notes",          match: /note|comment|remark|detail/ }
    ],
    fresh: ["first", "last", "company", "position", "date", "status", "profile", "notes"],
    anchor: ["first", "last", "name"]
  }
};

const VERSION = 2;
const MADE = {};          // tabs created during this request, for the report

// ----------------------------------------------------------------- web app

function doPost(e) {
  let out;
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    out = route_(req);
  } catch (err) {
    out = { ok: false, error: String((err && err.message) || err) };
  }
  return json_(out);
}

// Opening the web app URL in a browser tab shows this (no sheet data).
function doGet() {
  return json_({
    ok: true,
    app: "Job Apply Kit",
    message: "The link works. Paste it into the extension's Settings."
  });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function route_(req) {
  const action = String(req.action || "");
  if (action === "ping") return withLock_(ping_);
  const kind = String(req.sheet || "");
  if (!TABLES[kind]) throw new Error('Unknown sheet "' + kind + '".');
  if (action === "list") return list_(kind, Number(req.limit) || 300);
  if (action === "add") return withLock_(function () { return add_(kind, req.record || {}, req.id); });
  if (action === "update") {
    return withLock_(function () {
      return update_(kind, Number(req.row), req.fields || {}, req.expect || {});
    });
  }
  throw new Error('Unknown action "' + action + '".');
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

// ------------------------------------------------------------------ actions

function ping_() {
  const out = { ok: true, version: VERSION };
  ["applications", "referrals"].forEach(function (kind) {
    try {
      out[kind] = describe_(table_(kind, true));
    } catch (err) {
      out[kind] = { ok: false, error: String((err && err.message) || err) };
    }
  });
  return out;
}

function list_(kind, limit) {
  const t = table_(kind, false);
  const rows = readRows_(t);
  const newestFirst = rows.slice(-Math.max(1, Math.min(limit, 1000))).reverse();
  return { ok: true, rows: newestFirst, total: rows.length, meta: describe_(t) };
}

function add_(kind, rec, id) {
  const cache = CacheService.getScriptCache();
  const seen = id ? cache.get("add:" + id) : null;
  if (seen) return JSON.parse(seen);            // the same request, sent twice

  const t = table_(kind, true);
  const row = t.lastDataRow + 1;
  const skipped = writeRow_(t, row, normalize_(kind, rec, t), true);
  SpreadsheetApp.flush();

  const out = { ok: true, row: row, record: readRow_(t, row), meta: describe_(t),
                warnings: skipped };
  if (id) cache.put("add:" + id, JSON.stringify(out), 21600);
  return out;
}

function update_(kind, row, fields, expect) {
  const t = table_(kind, false);
  if (!(row > t.headerRow) || row > t.lastDataRow) {
    throw new Error("That row isn't in the sheet anymore. Refresh and try again.");
  }
  const current = readRow_(t, row);
  Object.keys(expect).forEach(function (key) {
    if (same_(current[key]) !== same_(expect[key])) {
      throw new Error("The sheet changed since it was loaded. Refresh and try again.");
    }
  });
  const values = {};
  Object.keys(fields).forEach(function (key) {
    if (!t.cols[key]) throw new Error('Your sheet has no "' + headerFor_(kind, key) + '" column.');
    values[key] = fields[key];
  });
  const skipped = writeRow_(t, row, values, false);
  if (skipped.length) throw new Error("Your sheet didn't accept that. " + skipped.join(" "));
  SpreadsheetApp.flush();
  return { ok: true, row: row, record: readRow_(t, row) };
}

// --------------------------------------------------------------------- tabs

function idFrom_(link) {
  const m = String(link).match(/\/d\/([\w-]{20,})/);
  return m ? m[1] : String(link).trim();
}

function gidFrom_(link) {
  const m = String(link).match(/[#&?]gid=(\d+)/);
  return m ? Number(m[1]) : null;
}

function squash_(s) {
  return String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function tabNames_(ss) {
  return ss.getSheets().map(function (s) { return '"' + s.getName() + '"'; }).join(", ");
}

function byName_(ss, name) {
  const want = squash_(name);
  const sheets = ss.getSheets();
  for (let i = 0; i < sheets.length; i++) {
    if (squash_(sheets[i].getName()) === want) return sheets[i];
  }
  return null;
}

// A tab is "the referrals tab" if its name says so or it has name columns.
function isReferralTab_(sheet) {
  if (/referr/i.test(sheet.getName())) return true;
  const info = findHeader_(TABLES.referrals, sheet);
  return !!(info && (info.cols.first || info.cols.last));
}

// The tracker: the tab whose headings look most like an application list.
// (The link's gid only breaks ties; it may point at a different tab.)
function trackerBook_() {
  if (!/\/d\/[\w-]{20,}/.test(SPREADSHEET)) {
    throw new Error("The script doesn't know your spreadsheet yet. Use “Copy the script” in the " +
      "extension's Settings (it fills in the link), or paste the link into SPREADSHEET at the " +
      "top of the script, then deploy a new version.");
  }
  return SpreadsheetApp.openById(idFrom_(SPREADSHEET));
}

function applicationsTab_() {
  const ss = trackerBook_();
  if (APPLICATIONS_TAB) {
    const named = byName_(ss, APPLICATIONS_TAB);
    if (!named) {
      throw new Error('No tab named "' + APPLICATIONS_TAB + '". Tabs are: ' + tabNames_(ss) + ".");
    }
    return named;
  }
  const sheets = ss.getSheets();
  const gid = gidFrom_(SPREADSHEET);
  let best = null;
  sheets.forEach(function (sh) {
    if (isReferralTab_(sh)) return;
    const info = findHeader_(TABLES.applications, sh);
    if (!info) return;
    const score = info.hits + (sh.getSheetId() === gid ? 0.5 : 0);
    if (!best || score > best.score) best = { sheet: sh, score: score };
  });
  if (best) return best.sheet;
  // A brand-new spreadsheet with one empty tab: start the tracker there.
  if (sheets.length === 1 && sheets[0].getLastRow() === 0) return sheets[0];
  throw new Error("Couldn't find your application tracker: no tab has headings like " +
    "Position, Company Name, Date Applied. Tabs are: " + tabNames_(ss) + ".");
}

// The referrals tab: by name, else by its headings, else a new tab. It is
// never the tracker tab.
function referralsTab_(create) {
  const home = REFERRALS_SPREADSHEET
    ? SpreadsheetApp.openById(idFrom_(REFERRALS_SPREADSHEET)) : trackerBook_();
  const sameFile = home.getId() === idFrom_(SPREADSHEET);
  const sheets = home.getSheets();
  let trackerId = null;
  if (sameFile) {
    try { trackerId = applicationsTab_().getSheetId(); } catch (err) { trackerId = null; }
  }
  const others = sheets.filter(function (s) { return s.getSheetId() !== trackerId; });

  // 1. A tab named "Referral Apps" (or anything with "referral" in its name).
  const exact = byName_(home, REFERRALS_TAB);
  if (exact && exact.getSheetId() !== trackerId) return exact;
  const named = others.filter(function (s) { return /referr/i.test(s.getName()); })[0];
  if (named) return named;

  // 2. A tab laid out like a list of people.
  const shaped = others.map(function (s) {
    return { sheet: s, info: findHeader_(TABLES.referrals, s) };
  }).filter(function (x) { return x.info; });
  const withNames = shaped.filter(function (x) { return x.info.cols.first || x.info.cols.last; })[0];
  if (withNames) return withNames.sheet;
  if (!sameFile && shaped[0]) return shaped[0].sheet;     // a file kept just for referrals

  // 3. An empty tab that is waiting for them.
  if (!sameFile && sheets[0].getLastRow() === 0) return sheets[0];
  if (sameFile && sheets.length > 1) {
    const gid = gidFrom_(SPREADSHEET);                    // the tab in the link, if still empty
    const linked = others.filter(function (s) { return s.getSheetId() === gid; })[0];
    if (linked && linked.getLastRow() === 0) return linked;
  }

  // 4. Otherwise make one.
  if (!create) {
    throw new Error('There is no "' + REFERRALS_TAB + '" tab yet. Press “Save and test” in Settings to create it.');
  }
  MADE.referrals = true;
  return home.insertSheet(REFERRALS_TAB, sheets.length);
}

/** The heading row of a tab for one kind of table, or null if none fits. */
function findHeader_(spec, sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow === 0) return null;
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const scan = sheet.getRange(1, 1, Math.min(lastRow, 10), lastCol).getDisplayValues();
  // The heading row is the one (among the first ten) matching the most fields.
  let best = null;
  for (let r = 0; r < scan.length; r++) {
    const cols = mapHeaders_(spec, scan[r]);
    const hits = Object.keys(cols).length;
    const anchored = spec.anchor.some(function (key) { return cols[key]; });
    if (hits >= 2 && anchored && (!best || hits > best.hits)) {
      best = { headerRow: r + 1, cols: cols, hits: hits, headers: scan[r],
               lastRow: lastRow, lastCol: lastCol };
    }
  }
  return best;
}

function mapHeaders_(spec, headerCells) {
  const cols = {};
  for (let c = 0; c < headerCells.length; c++) {
    const text = String(headerCells[c]).toLowerCase().replace(/\s+/g, " ").trim();
    if (!text) continue;
    for (let f = 0; f < spec.fields.length; f++) {
      const field = spec.fields[f];
      if (!cols[field.key] && field.match.test(text)) { cols[field.key] = c + 1; break; }
    }
  }
  // "Name" next to "Last Name" is the first-name column.
  if (spec.kind === "referrals" && cols.name && cols.last && !cols.first) {
    cols.first = cols.name;
    delete cols.name;
  }
  return cols;
}

/**
 * Locate a table: its tab, heading row, which column holds which field, and
 * the last row in use. With `create`, an empty tab gets headings first.
 */
function table_(kind, create) {
  const spec = TABLES[kind];
  const sheet = kind === "applications" ? applicationsTab_() : referralsTab_(create);
  const ss = sheet.getParent();

  if (sheet.getLastRow() === 0) {
    if (!create) throw new Error('The tab "' + sheet.getName() + '" is empty.');
    const headers = spec.fresh.map(function (key) { return headerFor_(kind, key); });
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight("bold");
    sheet.setFrozenRows(1);
    if (kind === "referrals") {
      const statusCol = spec.fresh.indexOf("status") + 1;
      const rule = SpreadsheetApp.newDataValidation()
        .requireValueInList(["Messaged", "Replied", "Referred", "No reply"], true)
        .setAllowInvalid(true).build();
      sheet.getRange(2, statusCol, Math.max(sheet.getMaxRows() - 1, 1), 1).setDataValidation(rule);
    }
    MADE[kind] = true;
  }

  const found = findHeader_(spec, sheet);
  if (!found) {
    throw new Error('Couldn\'t find column headings in the tab "' + sheet.getName() +
      '". Add a top row with headings such as: ' +
      spec.fresh.map(function (key) { return headerFor_(kind, key); }).join(", ") + ".");
  }

  // Last row in use = last row with a value in an anchor column. (Rows that
  // only hold formatting, checkboxes or dropdowns don't count.)
  let lastDataRow = found.headerRow;
  if (found.lastRow > found.headerRow) {
    const body = sheet.getRange(found.headerRow + 1, 1, found.lastRow - found.headerRow, found.lastCol)
      .getDisplayValues();
    for (let r = body.length - 1; r >= 0; r--) {
      const used = spec.anchor.some(function (key) {
        return found.cols[key] && String(body[r][found.cols[key] - 1]).trim() !== "";
      });
      if (used) { lastDataRow = found.headerRow + 1 + r; break; }
    }
  }

  return { kind: kind, spec: spec, ss: ss, sheet: sheet, tz: ss.getSpreadsheetTimeZone(),
           headerRow: found.headerRow, cols: found.cols, lastCol: found.lastCol,
           lastDataRow: lastDataRow, headers: found.headers };
}

function headerFor_(kind, key) {
  const hit = TABLES[kind].fields.filter(function (f) { return f.key === key; })[0];
  return hit ? hit.header : key;
}

function describe_(t) {
  const columns = {};
  Object.keys(t.cols).forEach(function (key) {
    columns[key] = { letter: letter_(t.cols[key]), heading: String(t.headers[t.cols[key] - 1]) };
  });
  const wanted = t.kind === "applications"
    ? ["company", "position", "location", "date"]
    : ["first", "last", "company", "date"];
  const missing = wanted.filter(function (key) {
    if (key === "first" || key === "last") return !t.cols[key] && !t.cols.name;
    return !t.cols[key];
  }).map(function (key) { return headerFor_(t.kind, key); });
  return {
    ok: true,
    file: t.ss.getName(),
    tab: t.sheet.getName(),
    url: t.ss.getUrl() + "#gid=" + t.sheet.getSheetId(),
    rows: t.lastDataRow - t.headerRow,
    columns: columns,
    missing: missing,
    created: !!MADE[t.kind]
  };
}

function letter_(col) {
  let s = "";
  while (col > 0) { const m = (col - 1) % 26; s = String.fromCharCode(65 + m) + s; col = (col - m - 1) / 26; }
  return s;
}

// --------------------------------------------------------------------- rows

function text_(value) {
  // Page text goes into your sheet, so never let it start a formula.
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim()
    .replace(/^[=+@\s]+/, "").slice(0, 500);
}

function same_(value) {
  return String(value == null ? "" : value).trim().toLowerCase();
}

function normalize_(kind, rec, t) {
  const out = {};
  TABLES[kind].fields.forEach(function (f) {
    if (rec[f.key] != null && rec[f.key] !== "") out[f.key] = text_(rec[f.key]);
  });
  if (kind === "referrals") {
    const full = [out.first, out.last].filter(Boolean).join(" ");
    if (!out.name && full) out.name = full;
    // Only write the combined name when there are no separate columns.
    if (t.cols.first || t.cols.last) delete out.name;
    if (!out.status) out.status = "Messaged";
  }
  if (!out.date) out.date = Utilities.formatDate(new Date(), t.tz, "yyyy-MM-dd");
  return out;
}

/**
 * If the cell is a dropdown, use the option that matches what we want to
 * write ("Applied" → your "Applied" / "Submitted" ...). Returns null when the
 * dropdown has nothing suitable, so the cell is left for you.
 */
function choiceFor_(t, row, col, wanted) {
  let options = [];
  try {
    let rule = t.sheet.getRange(row, col).getDataValidation();
    if (!rule && row - 1 > t.headerRow) rule = t.sheet.getRange(row - 1, col).getDataValidation();
    if (!rule) return wanted;
    const kinds = SpreadsheetApp.DataValidationCriteria;
    const type = rule.getCriteriaType();
    const args = rule.getCriteriaValues();
    if (type === kinds.VALUE_IN_LIST) options = args[0] || [];
    else if (type === kinds.VALUE_IN_RANGE) options = [].concat.apply([], args[0].getValues());
    else return wanted;
  } catch (err) {
    return wanted;
  }
  options = options.map(String).filter(function (o) { return o.trim() !== ""; });
  if (!options.length) return wanted;
  const exact = options.filter(function (o) { return same_(o) === same_(wanted); })[0];
  if (exact) return exact;
  const close = options.filter(function (o) { return /appl|submit|sent/i.test(o); })[0];
  return close || null;
}

/** Writes the given fields into one row. Returns notes about anything it couldn't write. */
function writeRow_(t, row, values, isNew) {
  const skipped = [];
  if (row > t.sheet.getMaxRows()) t.sheet.insertRowsAfter(t.sheet.getMaxRows(), 50);
  if (isNew && row - 1 > t.headerRow) {
    // Carry date formats and dropdowns down from the row above.
    try {
      const above = t.sheet.getRange(row - 1, 1, 1, t.lastCol);
      const here = t.sheet.getRange(row, 1, 1, t.lastCol);
      here.setNumberFormats(above.getNumberFormats());
      const rules = above.getDataValidations();
      if (rules[0].some(function (r) { return r; })) here.setDataValidations(rules);
    } catch (err) { /* formatting is a nicety; the data still gets written */ }
  }
  Object.keys(values).forEach(function (key) {
    const col = t.cols[key];
    if (!col) return;                       // your sheet has no such column
    const heading = String(t.headers[col - 1]);
    let v = values[key];
    if (key === "date" && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
      v = Utilities.parseDate(v, t.tz, "yyyy-MM-dd");   // a real date cell
    }
    if (key === "status" && isNew && t.kind === "applications") {
      const choice = choiceFor_(t, row, col, v);
      if (choice === null) {
        skipped.push("“" + heading + "” was left blank: its dropdown has no option like “" + v + "”.");
        return;
      }
      v = choice;
    }
    try {
      t.sheet.getRange(row, col).setValue(v);
    } catch (err) {
      skipped.push("“" + heading + "” was left blank: the sheet's rules didn't accept “" + v + "”.");
    }
  });
  return skipped;
}

function readRow_(t, row) {
  const cells = t.sheet.getRange(row, 1, 1, t.lastCol).getValues()[0];
  return toRecord_(t, cells, row);
}

function readRows_(t) {
  const count = t.lastDataRow - t.headerRow;
  if (count <= 0) return [];
  const body = t.sheet.getRange(t.headerRow + 1, 1, count, t.lastCol).getValues();
  const rows = [];
  for (let r = 0; r < body.length; r++) {
    const rec = toRecord_(t, body[r], t.headerRow + 1 + r);
    const used = t.spec.anchor.some(function (key) { return rec[key]; });
    if (used) rows.push(rec);
  }
  return rows;
}

function toRecord_(t, cells, row) {
  const rec = { row: row };
  Object.keys(t.cols).forEach(function (key) {
    const v = cells[t.cols[key] - 1];
    if (v instanceof Date) rec[key] = Utilities.formatDate(v, t.tz, "yyyy-MM-dd");
    else rec[key] = String(v == null ? "" : v).trim();
  });
  if (t.kind === "referrals") {
    // A single "Name" column is split so the extension always sees both parts.
    if (!t.cols.first && !t.cols.last && rec.name) {
      const parts = rec.name.split(/\s+/);
      rec.first = parts.shift() || "";
      rec.last = parts.join(" ");
    }
    rec.first = rec.first || "";
    rec.last = rec.last || "";
  }
  return rec;
}
