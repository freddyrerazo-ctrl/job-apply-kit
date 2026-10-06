// Job Apply Kit — referral message builder.
// Pure text helpers: no network calls and no access to any web page. The
// popup shows the result and copies it to your clipboard; you paste it and
// press Send yourself. Wording comes from Settings.

const Referral = (() => {
  // Shown in the message until the Position box is filled in.
  const BLANK = "[position]";

  // Fallback wording, used only if Settings has none.
  const DEFAULTS = {
    note_limit: 200,
    headline: "",
    pitch: "",
    note: "Hi {name}, I'm {me}, {headline}. I'm applying for the {position} " +
      "role at {company}. Would you be open to referring me?",
    followup: "Hi {name}, just following up on my note about the {position} " +
      "role at {company}. I'd really appreciate a referral if you're open to " +
      "it, and no worries at all if not. Thanks again!",
    message: [
      "Hi {name},",
      "",
      "I'm {me}, {headline}. I'm applying for the {position} role at " +
        "{company} and wanted to ask whether you'd be open to referring me.",
      "",
      "{pitch}",
      "",
      "{resume_line}",
      "{job_line}",
      "",
      "No pressure at all if it's not a fit. Thank you for your time!",
      "",
      "{full_name}"
    ].join("\n")
  };

  const clean = (s) => String(s == null ? "" : s).trim();

  // "stripe" -> "Stripe", "scale-ai" -> "Scale Ai". Names that already have
  // capitals or spaces are left alone.
  function prettyCompany(raw) {
    const s = clean(raw);
    if (!s || /[A-Z\s]/.test(s)) return s;
    return s.split(/[-_]/).filter(Boolean)
      .map((p) => p[0].toUpperCase() + p.slice(1)).join(" ");
  }

  // A tracked posting whose title is exactly what's in the Position box.
  // Manually logged pages have no company, so they're skipped.
  function matchJob(jobs, position, company) {
    const p = clean(position).toLowerCase();
    if (!p) return null;
    const c = clean(company).toLowerCase();
    const hits = (jobs || []).filter((j) =>
      j && j.company && clean(j.title).toLowerCase() === p);
    if (!c) return hits.length === 1 ? hits[0] : null;
    return hits.find((j) =>
      prettyCompany(j.company).toLowerCase() === c ||
      clean(j.company).toLowerCase() === c) || null;
  }

  // Fill {placeholders}. A line that is nothing but one empty placeholder is
  // removed, and leftover punctuation from empty inline ones is tidied up.
  function fill(template, values) {
    const vars = Object.assign({}, values);
    // A template may be a single text or a list of lines.
    let t = Array.isArray(template) ? template.join("\n") : String(template || "");
    if (!vars.company) {
      // "the Analyst role at {company}" -> "the Analyst role"
      t = t.replace(/\s+(?:at|with)\s+\{company\}/g, "");
      vars.company = "your company";
    }
    const lines = [];
    for (const line of t.split("\n")) {
      const solo = line.trim().match(/^\{(\w+)\}$/);
      if (solo && solo[1] in vars && !vars[solo[1]]) continue;
      const out = line
        .replace(/\{(\w+)\}/g, (m, key) => (key in vars ? vars[key] : m))
        .replace(/\s*,\s*(?=[.!?,])/g, "")   // "Sam, ." -> "Sam."
        .replace(/[ \t]{2,}/g, " ")
        .replace(/\s+([.!?,])/g, "$1");
      lines.push(out.trimEnd());
    }
    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  // opts: { mode: "full" | "note", position, company, name,
  //         profile, settings, jobUrl }
  // Returns { text, hint, limit } — limit is null for the full message.
  function build(opts) {
    const profile = opts.profile || {};
    const cfg = Object.assign({}, DEFAULTS, opts.settings || {});
    const limit = Number(cfg.note_limit) > 0 ? Number(cfg.note_limit) : 200;

    const position = clean(opts.position);
    const company = clean(opts.company);
    const me = clean(profile.first_name) ||
      clean(profile.full_name).split(/\s+/)[0] || "";
    const fullName = clean(profile.full_name) ||
      [clean(profile.first_name), clean(profile.last_name)]
        .filter(Boolean).join(" ") || me;
    const resumeUrl = clean(profile.resume_url);
    const jobUrl = clean(opts.jobUrl);

    const vars = {
      name: clean(opts.name) || "there",
      me: me || "[your name]",
      full_name: fullName || "[your name]",
      headline: clean(cfg.headline),
      pitch: clean(cfg.pitch),
      position: position || BLANK,
      company: company,
      resume_url: resumeUrl,
      job_url: jobUrl,
      resume_line: resumeUrl ? "Resume: " + resumeUrl
        : "I'm happy to send my resume.",
      job_line: jobUrl ? "Job posting: " + jobUrl : ""
    };

    const noName = me ? "" : "Your name isn't set in Settings. ";
    const noLink = "No resume link yet. Add one in Settings.";

    if (opts.mode === "note") {
      const base = fill(cfg.note, vars).replace(/\s*\n\s*/g, " ");
      const withLink = resumeUrl ? base + " Resume: " + resumeUrl : null;
      if (withLink && withLink.length <= limit) {
        return { text: withLink, limit, hint: noName + "Resume link included." };
      }
      const offer = base + " Happy to send my resume.";
      const text = offer.length <= limit ? offer : base;
      const hint = resumeUrl
        ? "Resume link left out to fit " + limit + " characters. Send the " +
          "full message once they accept."
        : noLink;
      return { text, limit, hint: noName + hint };
    }

    return {
      text: fill(cfg.message, vars),
      limit: null,
      hint: noName + (resumeUrl ? "Resume link included." : noLink)
    };
  }

  // A short nudge for someone who hasn't answered.
  function followup(opts) {
    const profile = opts.profile || {};
    const cfg = Object.assign({}, DEFAULTS, opts.settings || {});
    const me = clean(profile.first_name) ||
      clean(profile.full_name).split(/\s+/)[0] || "";
    return fill(cfg.followup, {
      name: clean(opts.name) || "there",
      me: me,
      full_name: clean(profile.full_name) || me,
      position: clean(opts.position) || "open",
      company: clean(opts.company)
    }).replace(/\s*\n\s*/g, " ");
  }

  // First name from a LinkedIn profile tab's title ("Ana Smith | LinkedIn").
  // Reads only what the browser already shows on the tab — nothing is read
  // from the page itself. Returns "" when unsure.
  function firstNameFromTab(tab) {
    try {
      const u = new URL(tab.url);
      if (!/(^|\.)linkedin\.com$/i.test(u.hostname)) return "";
      if (!u.pathname.startsWith("/in/")) return "";
      let t = clean(tab.title).replace(/^\(\d+\+?\)\s*/, "");
      t = t.split(/\s[|\-–—]\s/)[0].trim();
      if (!t || /linkedin/i.test(t)) return "";
      const words = t.split(/\s+/)
        .filter((w) => !/^(dr|mr|mrs|ms|mx|prof)\.?$/i.test(w));
      const first = (words[0] || "").replace(/,$/, "");
      return /^\p{L}[\p{L}'’.-]*$/u.test(first) ? first : "";
    } catch {
      return "";
    }
  }

  return { BLANK, DEFAULTS, build, followup, fill, matchJob, prettyCompany, firstNameFromTab };
})();

if (typeof module !== "undefined") module.exports = Referral;
