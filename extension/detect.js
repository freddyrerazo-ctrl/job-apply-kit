// Job Apply Kit — working out who / what the current tab is about.
//
// Two kinds of helpers live here:
//   * plain text helpers (tab titles, names, URLs), and
//   * two "readers" that the popup runs inside the tab you're looking at,
//     once, when you open the popup. They only read what is already on your
//     screen, change nothing, click nothing, and make no requests.

const Detect = (() => {
  const clean = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();

  function host(url) {
    try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
  }
  function pathOf(url) {
    try { return new URL(url).pathname; } catch { return ""; }
  }

  // ------------------------------------------------------------- LinkedIn

  function isLinkedInProfile(url) {
    return /(^|\.)linkedin\.com$/.test(host(url)) && /^\/in\/[^/]+/.test(pathOf(url));
  }

  // https://www.linkedin.com/in/ana-smith/details/x?y=1 -> .../in/ana-smith
  function profileUrl(url) {
    const m = pathOf(url).match(/^\/in\/[^/]+/);
    return m ? "https://www.linkedin.com" + m[0] : "";
  }

  // "(3) Ana Smith | LinkedIn" -> "Ana Smith"
  function nameFromTitle(title) {
    let t = clean(title).replace(/^\(\d+\+?\)\s*/, "");
    t = t.split(/\s[|\-–—]\s/)[0].trim();
    return !t || /linkedin/i.test(t) ? "" : t;
  }

  // "Dr. Ana María Smith, PhD (She/Her)" -> { first: "Ana", last: "María Smith" }
  function splitName(full) {
    let t = clean(full)
      .replace(/\([^)]*\)/g, " ")                    // (She/Her), (Ana)
      .replace(/,.*$/, "")                           // ", PhD", ", MBA"
      .replace(/[^\p{L}\p{M}\s'’.-]/gu, " ");        // emoji, symbols, digits
    const words = clean(t).split(" ")
      .filter((w) => w && !/^(dr|mr|mrs|ms|mx|prof)\.?$/i.test(w));
    if (!words.length) return { first: "", last: "" };
    return { first: words[0], last: words.slice(1).join(" ") };
  }

  // Runs inside a LinkedIn profile tab. Self-contained on purpose: it is
  // handed to the page as text, so it can't use anything defined outside.
  function readLinkedInProfile() {
    const T = (el) => ((el && (el.innerText || el.textContent)) || "")
      .replace(/\s+/g, " ").trim();
    const out = { name: "", company: "", via: "" };
    const root = document.querySelector("main") || document.body;

    // Name. The tab title is the steadiest source; the page heading is next.
    let t = document.title.replace(/^\(\d+\+?\)\s*/, "").split(/\s[|\-–—]\s/)[0].trim();
    if (t && !/linkedin/i.test(t)) out.name = t;
    if (!out.name) out.name = T(root.querySelector("h1"));

    // Company, attempt 1: the "Current company" shortcut in the intro card.
    const labelled = root.querySelector('[aria-label^="Current company" i]');
    if (labelled) {
      const v = (labelled.getAttribute("aria-label") || "")
        .replace(/^current company:?\s*/i, "")
        .replace(/\.?\s*click to.*$/i, "").trim();
      if (v) { out.company = v; out.via = "intro"; }
    }

    // Attempt 2: the first entry of the Experience section.
    if (!out.company) {
      let section = null;
      const anchor = document.getElementById("experience");
      if (anchor) section = anchor.closest("section");
      if (!section) {
        section = Array.from(root.querySelectorAll("section")).find((s) => {
          const h = s.querySelector("h2");
          return h && /^experience/i.test(T(h));   // may read "ExperienceExperience"
        }) || null;
      }
      const item = section && section.querySelector("li");
      if (item) {
        const seen = new Set();
        const lines = Array.from(item.querySelectorAll('span[aria-hidden="true"]'))
          .map(T).filter((x) => x && !seen.has(x) && seen.add(x));
        const kind = /^(full-time|part-time|contract|internship|self-employed|freelance|temporary|apprenticeship|seasonal)\b/i;
        const span = /\b\d+\s*(yrs?|mos?)\b/i;
        const a = lines[0] || "", b = lines[1] || "";
        let v = "";
        if (b && (kind.test(b) || (span.test(b) && !/[a-z]{3}\s+\d{4}/i.test(b.split("·")[0])))) {
          v = a;                              // several roles grouped under one company
        } else if (b && !/\b(19|20)\d{2}\b/.test(b)) {
          v = b.split("·")[0].trim();         // "Acme · Full-time"
        }
        if (v && v.length <= 80) { out.company = v; out.via = "experience"; }
      }
    }

    // Attempt 3: a headline such as "Data Analyst at Acme".
    if (!out.company) {
      const h1 = root.querySelector("h1");
      let headline = "";
      const tagged = root.querySelector(".text-body-medium");
      if (tagged) headline = T(tagged);
      if (!headline && h1) {
        // the first short line of text after the name
        let box = h1.parentElement;
        for (let i = 0; i < 4 && box && !headline; i++, box = box.parentElement) {
          const next = box.nextElementSibling;
          const txt = T(next);
          if (txt && txt.length < 220) headline = txt;
        }
      }
      const m = headline.match(/(?:\bat|@)\s+(\p{Lu}[^|·•,;()]*)/u);
      if (m) { out.company = m[1].trim(); out.via = "headline"; }
    }

    return out;
  }

  // ------------------------------------------------------------ job pages

  const JOB_HOSTS = /(greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|smartrecruiters\.com|myworkdayjobs\.com|icims\.com|jobvite\.com|bamboohr\.com|taleo\.net|oraclecloud\.com|breezy\.hr|recruitee\.com|workday\.com|indeed\.com|glassdoor\.com|ziprecruiter\.com|wellfound\.com|dice\.com|handshake\.com)$/;

  function looksLikeJob(url) {
    const h = host(url), p = pathOf(url).toLowerCase();
    if (!h) return false;
    if (/(^|\.)linkedin\.com$/.test(h)) return /^\/jobs\/(view|collections|search)/.test(p);
    if (JOB_HOSTS.test(h)) return true;
    return /\/(jobs?|careers?|positions?|openings?|opportunit|vacanc|apply|requisition)/.test(p);
  }

  function prettyCompany(raw) {
    const s = clean(raw);
    if (!s || /[A-Z\s]/.test(s)) return s;
    return s.split(/[-_]/).filter(Boolean)
      .map((p) => p[0].toUpperCase() + p.slice(1)).join(" ");
  }

  // Best guess from a tab title alone.
  function jobFromTitle(title, url) {
    const t = clean(title).replace(/^\(\d+\+?\)\s*/, "");
    const h = host(url);
    const out = { position: "", company: "", location: "" };
    let m;
    if ((m = t.match(/^Job Application for (.+?) at (.+)$/i))) {          // Greenhouse
      out.position = m[1]; out.company = m[2];
    } else if (/linkedin\.com$/.test(h)) {
      const parts = t.split(" | ");
      if ((m = t.match(/^(.+?) hiring (.+?) in (.+?) \| LinkedIn$/i))) {
        out.company = m[1]; out.position = m[2]; out.location = m[3];
      } else if (parts.length >= 3) {
        out.position = parts[0]; out.company = parts[1];
      }
    } else if (/lever\.co$/.test(h) && (m = t.match(/^(.+?) - (.+)$/))) { // Lever
      out.company = m[1]; out.position = m[2];
    } else if ((m = t.match(/^(.+?) @ (.+)$/))) {                         // Ashby
      out.position = m[1]; out.company = m[2];
    } else if ((m = t.match(/^(.+?) at (.+?)(?:\s[|–—-]\s.*)?$/))) {
      out.position = m[1]; out.company = m[2];
    } else {
      const parts = t.split(/\s[|–—-]\s/);
      out.position = parts[0] || "";
      if (parts.length >= 2) out.company = parts[parts.length - 1];
    }
    // ATS board URLs carry the company: boards.greenhouse.io/<company>/...
    if (!out.company && /(greenhouse\.io|lever\.co|ashbyhq\.com)$/.test(h)) {
      const slug = pathOf(url).split("/").filter(Boolean)[0] || "";
      if (slug && !/^(embed|jobs?)$/.test(slug)) out.company = prettyCompany(slug);
    }
    out.company = clean(out.company.replace(/\b(careers?|jobs?( board)?)$/i, ""));
    // "... - Indeed.com": that's the job board, not the employer.
    if (/^(indeed|glassdoor|ziprecruiter|linkedin|dice|wellfound|handshake)\b/i.test(out.company)) {
      out.company = "";
    }
    out.position = clean(out.position.replace(/^(careers?|jobs?)\s*[:\-–]\s*/i, ""));
    return out;
  }

  // Runs inside the tab. Reads the posting's own structured data (the
  // "JobPosting" block most job boards publish for search engines).
  function readJobPage() {
    const out = { posting: false, position: "", company: "", location: "" };
    const str = (v) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
    const place = (loc) => {
      if (!loc) return "";
      if (Array.isArray(loc)) return place(loc[0]);
      const a = loc.address || loc;
      if (typeof a === "string") return str(a);
      const region = str(a.addressRegion);
      const country = typeof a.addressCountry === "object" && a.addressCountry
        ? str(a.addressCountry.name) : str(a.addressCountry);
      return [str(a.addressLocality), region || country].filter(Boolean).join(", ");
    };
    const visit = (node, depth) => {
      if (!node || typeof node !== "object" || depth > 4 || out.posting) return;
      if (Array.isArray(node)) { node.forEach((n) => visit(n, depth + 1)); return; }
      const types = [].concat(node["@type"] || []);
      if (types.includes("JobPosting")) {
        out.posting = true;
        out.position = str(node.title);
        const org = node.hiringOrganization;
        out.company = typeof org === "string" ? str(org) : str(org && org.name);
        out.location = place(node.jobLocation);
        const remote = [].concat(node.jobLocationType || []).join(" ");
        if (/telecommute/i.test(remote)) {
          out.location = out.location ? "Remote (" + out.location + ")" : "Remote";
        }
        return;
      }
      if (node["@graph"]) visit(node["@graph"], depth + 1);
    };
    document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
      try { visit(JSON.parse(s.textContent), 0); } catch { /* not valid JSON */ }
    });
    return out;
  }

  // Combine what the page published with what the tab title suggests.
  function job(tab, page) {
    const url = (tab && tab.url) || "";
    const guess = jobFromTitle((tab && tab.title) || "", url);
    const p = page && page.posting ? page : null;
    return {
      confident: !!p || looksLikeJob(url),
      position: clean((p && p.position) || guess.position).slice(0, 150),
      company: clean((p && p.company) || guess.company).slice(0, 100),
      location: clean((p && p.location) || guess.location).slice(0, 100),
      url
    };
  }

  function peopleSearchUrl(company, position) {
    const q = clean([position, company].filter(Boolean).join(" "));
    return "https://www.linkedin.com/search/results/people/?keywords=" +
      encodeURIComponent(q);
  }

  return { isLinkedInProfile, profileUrl, nameFromTitle, splitName,
           readLinkedInProfile, looksLikeJob, prettyCompany, jobFromTitle,
           readJobPage, job, peopleSearchUrl };
})();

if (typeof module !== "undefined") module.exports = Detect;
