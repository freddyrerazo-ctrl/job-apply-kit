// Job Apply Kit — talks to your Google Sheet through the small Apps Script
// web app you deployed (see Code.gs). Used by the background worker only.

const Sheets = (() => {
  const EXEC = /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/;

  // Accepts the link with stray spaces, a query string, or /dev on the end.
  function tidy(url) {
    return String(url || "").trim().replace(/[?#].*$/, "").replace(/\/dev$/, "/exec");
  }

  function check(url) {
    const u = tidy(url);
    if (!u) return "Paste your web app link first.";
    if (/docs\.google\.com\/spreadsheets/.test(u)) {
      return "That's the spreadsheet's own link. Paste the web app link from " +
        "Apps Script → Deploy instead (it ends in /exec).";
    }
    if (!EXEC.test(u)) {
      return "That doesn't look like a web app link. It starts with " +
        "https://script.google.com/macros/s/ and ends in /exec.";
    }
    return "";
  }

  const SIGN_IN = "Google asked for a sign-in. In Apps Script: Deploy → " +
    "Manage deployments → pencil → set “Who has access” to “Anyone”.";
  const GONE = "That web app link no longer exists. Deploy the script again " +
    "and paste the new link.";

  // The request failed outright. Work out why with harmless GETs (opening
  // the link only returns a "the link works" note, never sheet data).
  async function diagnose(u) {
    const quiet = { method: "GET", credentials: "omit", cache: "no-store" };
    try {
      const first = await fetch(u, Object.assign({ redirect: "manual" }, quiet));
      if (first.status === 404) return GONE;
      if (first.type === "opaqueredirect") {
        // Google answered with a redirect. A working link redirects to its
        // result; a restricted one redirects to a sign-in page we can't follow.
        try {
          const hello = JSON.parse(await (await fetch(u, quiet)).text());
          if (hello && hello.app) return "Google didn't answer just now. Try again in a moment.";
        } catch { /* fall through */ }
        return SIGN_IN;
      }
    } catch { /* not reachable at all */ }
    return "Couldn't reach Google. Check your internet connection.";
  }

  async function call(url, body) {
    const u = tidy(url);
    const problem = check(u);
    if (problem) throw new Error(problem);

    let res, text;
    try {
      res = await fetch(u, {
        method: "POST",
        // text/plain keeps this a "simple" request; the script parses JSON.
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(body),
        redirect: "follow",
        credentials: "omit",
        cache: "no-store"
      });
      text = await res.text();
    } catch {
      throw new Error(await diagnose(u));
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      if (/accounts\.google\.com/.test(res.url) || /sign in|ServiceLogin/i.test(text)) {
        throw new Error(SIGN_IN);
      }
      if (res.status === 404) throw new Error(GONE);
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`Google had a problem (status ${res.status}). Try again in a moment.`);
      }
      throw new Error("The sheet link answered with something unexpected " +
        `(status ${res.status}). Re-check the deployment steps in Settings.`);
    }
    if (!data || data.ok !== true) {
      throw new Error((data && data.error) || "The sheet reported a problem.");
    }
    return data;
  }

  return { call, check, tidy };
})();

if (typeof module !== "undefined") module.exports = Sheets;
