// Job Apply Kit — autofill content script.
// Fills application form fields from your profile and from the answers you
// saved in Settings. It never clicks Submit, never touches file inputs, and
// never overwrites something you typed.

(() => {
  if (window.__jak === 2) return;
  window.__jak = 2;

  // Ordered rules: first match wins. Keys refer to profile fields.
  const RULES = [
    [/first\s*name|given\s*name/i, "first_name"],
    [/last\s*name|family\s*name|surname/i, "last_name"],
    [/full\s*name|^name$|your\s*name/i, "full_name"],
    [/e-?mail/i, "email"],
    [/phone|mobile/i, "phone"],
    [/linkedin/i, "linkedin"],
    [/github/i, "github"],
    [/portfolio|website|personal\s*site|url/i, "website"],
    [/current\s*(company|employer)|^company$/i, "current_company"],
    [/current\s*(title|role)|job\s*title/i, "current_title"],
    [/years.*experience|experience.*years/i, "years_experience"],
    [/city|location|where.*(located|based)/i, "location"],
    [/sponsor(ship)?/i, "needs_sponsorship"],
    [/authoriz|legally.*work|right\s*to\s*work|work\s*permit/i, "work_authorized"],
    [/how.*(hear|find|learn).*(about|us|role|position)/i, "how_heard"]
  ];

  function labelText(el) {
    const bits = [];
    if (el.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lab) bits.push(lab.textContent);
    }
    const wrap = el.closest("label");
    if (wrap) bits.push(wrap.textContent);
    const aria = el.getAttribute("aria-label");
    if (aria) bits.push(aria);
    if (el.getAttribute("aria-labelledby")) {
      el.getAttribute("aria-labelledby").split(/\s+/).forEach((id) => {
        const n = document.getElementById(id);
        if (n) bits.push(n.textContent);
      });
    }
    bits.push(el.placeholder || "", el.name || "", el.id || "");
    // Nearby question text (common in ATS layouts).
    const holder = el.closest("div, fieldset, li");
    if (holder) {
      const q = holder.querySelector("label, legend, .label, [class*='label']");
      if (q) bits.push(q.textContent);
    }
    return bits.join(" ").replace(/\s+/g, " ").slice(0, 300);
  }

  function profileKeyFor(text) {
    for (const [re, key] of RULES) if (re.test(text)) return key;
    return null;
  }

  // Your own answers from Settings. Each has words or phrases separated by
  // commas; a question containing any of them gets that answer.
  function answerFor(text, answers) {
    const t = text.toLowerCase();
    for (const a of answers || []) {
      const keys = String((a && a.match) || "").toLowerCase()
        .split(",").map((k) => k.trim()).filter(Boolean);
      if (a && a.answer && keys.some((k) => t.includes(k))) return a.answer;
    }
    return null;
  }

  // React-controlled inputs ignore plain .value writes; use the native setter.
  function setValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function pickOption(select, want) {
    const w = String(want).toLowerCase();
    const opts = Array.from(select.options);
    const hit =
      opts.find((o) => o.text.trim().toLowerCase() === w) ||
      opts.find((o) => o.text.trim().toLowerCase().startsWith(w)) ||
      opts.find((o) => o.text.toLowerCase().includes(w));
    if (!hit) return false;
    select.value = hit.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  // Does this radio button / checkbox stand for the wanted answer? Only the
  // choice's own caption counts ("Yes", "No, I don't"), never the question
  // around it, so "No" can't match a question that contains "now".
  function choiceMatches(el, want) {
    const w = String(want).toLowerCase().trim();
    if (!w) return false;
    const captions = [];
    if (el.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lab) captions.push(lab.textContent);
    }
    const wrap = el.closest("label");
    if (wrap) captions.push(wrap.textContent);
    captions.push(el.getAttribute("aria-label") || "", el.value || "");
    return captions.some((c) => {
      const t = String(c).replace(/\s+/g, " ").trim().toLowerCase();
      return t === w || (t.startsWith(w) && /[^a-z0-9]/.test(t.charAt(w.length)));
    });
  }

  function flash(el) {
    const old = el.style.boxShadow;
    el.style.boxShadow = "0 0 0 2px #0E6E5C";
    setTimeout(() => { el.style.boxShadow = old; }, 1600);
  }

  function fill(profile, answers) {
    let filled = 0, skipped = 0;
    const fields = document.querySelectorAll(
      "input:not([type=hidden]):not([type=file]):not([type=submit])" +
      ":not([type=button]), textarea, select"
    );
    for (const el of fields) {
      if (el.disabled || el.readOnly) continue;
      const text = labelText(el);
      // Your saved answers win over the built-in profile rules.
      const value = answerFor(text, answers) || profile[profileKeyFor(text)];
      if (!value) continue;

      if (el.tagName === "SELECT") {
        if (pickOption(el, value)) { filled++; flash(el); }
        continue;
      }
      if (el.type === "radio" || el.type === "checkbox") {
        if (choiceMatches(el, value) && !el.checked) {
          el.click(); filled++; flash(el);
        }
        continue;
      }
      if (el.value && el.value.trim()) { skipped++; continue; } // yours, not ours
      setValue(el, value);
      filled++; flash(el);
    }
    return { filled, skipped };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === "fill") {
      if (!msg.profile) {
        sendResponse({ error: "No profile yet. Fill in “About you” in Settings." });
        return;
      }
      sendResponse(fill(msg.profile, msg.answers || []));
      return;
    }
    if (msg.action === "pageInfo") {
      sendResponse({ title: document.title, url: location.href });
    }
  });
})();
