// Job Apply Kit — helpers shared by the popup, Settings and Job finder pages.

const Kit = (() => {
  let defaultsCache = null;

  async function defaults() {
    if (!defaultsCache) {
      const res = await fetch(chrome.runtime.getURL("defaults.json"));
      defaultsCache = await res.json();
    }
    return JSON.parse(JSON.stringify(defaultsCache));
  }

  function merge(def, saved) {
    const s = saved || {};
    const out = Object.assign({}, def, s);
    out.profile = Object.assign({}, def.profile, s.profile);
    out.referral = Object.assign({}, def.referral, s.referral);
    out.answers = Array.isArray(s.answers) ? s.answers : (def.answers || []);
    return out;
  }

  // Settings = defaults.json overlaid with whatever you saved in Settings.
  async function loadSettings() {
    const def = await defaults();
    const got = await chrome.storage.local.get(["settings", "profile"]);
    let saved = got.settings;
    if (!saved) {
      // First run of this version: keep a resume link set in the old one.
      saved = {};
      if (got.profile && got.profile.resume_url) {
        saved.profile = { resume_url: got.profile.resume_url };
      }
      await chrome.storage.local.set({ settings: saved });
    }
    return merge(def, saved);
  }

  async function saveSettings(next) {
    await chrome.storage.local.set({ settings: next });
  }

  function esc(s) {
    const d = document.createElement("span");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML.replace(/"/g, "&quot;");
  }

  const pad = (n) => String(n).padStart(2, "0");

  function today() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function parseDate(s) {
    const m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
    const us = String(s || "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (us) return new Date(+us[3] < 100 ? 2000 + +us[3] : +us[3], +us[1] - 1, +us[2]);
    return null;
  }

  // "2026-10-05" -> "Oct 5" (with the year when it isn't this year).
  function prettyDate(s) {
    const d = parseDate(s);
    if (!d || isNaN(d)) return String(s || "");
    const opts = { month: "short", day: "numeric" };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
    return d.toLocaleDateString("en-US", opts);
  }

  function daysSince(s) {
    const d = parseDate(s);
    if (!d || isNaN(d)) return null;
    const now = new Date();
    const a = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    const b = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
    return Math.round((a - b) / 86400000);
  }

  // "Acme, Inc." and "acme" should count as the same company.
  function companyKey(name) {
    return String(name || "").toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\b(inc|llc|ltd|corp|corporation|co|company|plc|gmbh|the)\b/g, " ")
      .replace(/\s+/g, " ").trim();
  }

  const same = (a, b) =>
    String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();

  function send(msg) {
    return chrome.runtime.sendMessage(msg).catch((e) =>
      ({ ok: false, error: String((e && e.message) || e) }));
  }

  return { defaults, merge, loadSettings, saveSettings, esc, today, parseDate,
           prettyDate, daysSince, companyKey, same, send };
})();

if (typeof module !== "undefined") module.exports = Kit;
