#!/usr/bin/env python3
"""Job Apply Kit — local companion server.

Discovers job postings via official, public ATS APIs (Greenhouse, Lever,
Ashby), keeps them in applications.xlsx, and serves a small localhost API
that the browser extension talks to.

Run:  python app.py     (then leave it running while you work the queue)
"""

import json
import hashlib
import datetime
import urllib.request
import urllib.error
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path

import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation

ROOT = Path(__file__).resolve().parent
CONFIG_PATH = ROOT / "config.json"
XLSX_PATH = ROOT.parent / "applications.xlsx"
PORT = 8377

HEADERS = ["ID", "Found", "Company", "Title", "Location", "URL",
           "Source", "Status", "Applied", "Notes"]
STATUSES = ["New", "Queued", "Applied", "Interview", "Offer",
            "Rejected", "Archived"]
INK = "1A1D21"


def load_config():
    return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))


# ---------------------------------------------------------------- spreadsheet

def ensure_workbook():
    if XLSX_PATH.exists():
        return
    wb = openpyxl.Workbook()

    ws = wb.active
    ws.title = "Applications"
    header_fill = PatternFill("solid", fgColor=INK)
    for col, name in enumerate(HEADERS, 1):
        c = ws.cell(row=1, column=col, value=name)
        c.font = Font(name="Arial", bold=True, color="FFFFFF")
        c.fill = header_fill
        c.alignment = Alignment(vertical="center")
    widths = [12, 12, 22, 38, 22, 55, 12, 12, 12, 30]
    for i, w in enumerate(widths, 1):
        ws.column_dimensions[get_column_letter(i)].width = w
    ws.freeze_panes = "A2"
    dv = DataValidation(type="list",
                        formula1='"' + ",".join(STATUSES) + '"',
                        allow_blank=True, showDropDown=False)
    ws.add_data_validation(dv)
    dv.add("H2:H2000")

    g = wb.create_sheet("Guide")
    g.column_dimensions["A"].width = 26
    g.column_dimensions["B"].width = 62
    rows = [
        ("Job Apply Kit — tracker", ""),
        ("", ""),
        ("How rows get here", "The local script adds a row for every new posting it finds "
                              "via official job-board APIs, and the extension updates Status."),
        ("Editable by you", "Status (dropdown) and Notes. Everything else is machine-written; "
                            "edit freely, but the script never overwrites your edits."),
        ("Statuses", " / ".join(STATUSES)),
        ("", ""),
        ("Pipeline summary", ""),
    ]
    for r, (a, b) in enumerate(rows, 1):
        g.cell(row=r, column=1, value=a).font = Font(name="Arial", bold=(r in (1, 7)))
        g.cell(row=r, column=2, value=b).font = Font(name="Arial")
    for i, status in enumerate(STATUSES):
        r = 8 + i
        g.cell(row=r, column=1, value=status).font = Font(name="Arial")
        f = g.cell(row=r, column=2,
                   value=f'=COUNTIF(Applications!$H:$H,"{status}")')
        f.font = Font(name="Arial", bold=True)

    wb.save(XLSX_PATH)


def read_rows():
    ensure_workbook()
    wb = openpyxl.load_workbook(XLSX_PATH, data_only=False)
    ws = wb["Applications"]
    rows = []
    for r in range(2, ws.max_row + 1):
        if not ws.cell(row=r, column=1).value:
            continue
        rows.append({k.lower(): ws.cell(row=r, column=i + 1).value
                     for i, k in enumerate(HEADERS)} | {"_row": r})
    return wb, ws, rows


def save(wb):
    try:
        wb.save(XLSX_PATH)
        return None
    except PermissionError:
        return ("Could not write applications.xlsx — close it in Excel and "
                "try again.")


def job_id(url):
    return hashlib.md5(url.encode()).hexdigest()[:10]


def append_jobs(jobs):
    """jobs: list of dicts with company/title/location/url/source."""
    wb, ws, rows = read_rows()
    known = {r["id"] for r in rows}
    today = datetime.date.today().isoformat()
    added = 0
    for j in jobs:
        jid = job_id(j["url"])
        if jid in known:
            continue
        known.add(jid)
        ws.append([jid, today, j.get("company", ""), j.get("title", ""),
                   j.get("location", ""), j["url"], j.get("source", "manual"),
                   "New", "", ""])
        for cell in ws[ws.max_row]:
            cell.font = Font(name="Arial")
        added += 1
    err = save(wb) if added else None
    return added, err


def set_status(jid, status):
    wb, ws, rows = read_rows()
    for r in rows:
        if r["id"] == jid:
            ws.cell(row=r["_row"], column=8, value=status)
            if status == "Applied":
                ws.cell(row=r["_row"], column=9,
                        value=datetime.date.today().isoformat())
            return save(wb)
    return f"No job with id {jid}"


# ------------------------------------------------------- official ATS APIs

def _get_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "job-apply-kit"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch_greenhouse(slug):
    data = _get_json(f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs")
    return [{"company": slug, "title": j["title"],
             "location": (j.get("location") or {}).get("name", ""),
             "url": j["absolute_url"], "source": "greenhouse"}
            for j in data.get("jobs", [])]


def fetch_lever(slug):
    data = _get_json(f"https://api.lever.co/v0/postings/{slug}?mode=json")
    return [{"company": slug, "title": j.get("text", ""),
             "location": (j.get("categories") or {}).get("location", ""),
             "url": j.get("hostedUrl", ""), "source": "lever"}
            for j in data if j.get("hostedUrl")]


def fetch_ashby(slug):
    data = _get_json(f"https://api.ashbyhq.com/posting-api/job-board/{slug}")
    return [{"company": slug, "title": j.get("title", ""),
             "location": j.get("location", ""),
             "url": j.get("jobUrl", ""), "source": "ashby"}
            for j in data.get("jobs", []) if j.get("jobUrl")]


FETCHERS = {"greenhouse": fetch_greenhouse, "lever": fetch_lever,
            "ashby": fetch_ashby}


def matches(cfg, job):
    title = (job["title"] or "").lower()
    inc = [k.lower() for k in cfg.get("keywords_include", [])]
    exc = [k.lower() for k in cfg.get("keywords_exclude", [])]
    locs = [k.lower() for k in cfg.get("locations", [])]
    if inc and not any(k in title for k in inc):
        return False
    if any(k in title for k in exc):
        return False
    if locs:
        loc = (job["location"] or "").lower()
        if not any(k in loc for k in locs):
            return False
    return True


def refresh():
    cfg = load_config()
    found, errors = [], []
    for source, slugs in cfg.get("sources", {}).items():
        fetcher = FETCHERS.get(source)
        if not fetcher:
            errors.append(f"unknown source '{source}'")
            continue
        for slug in slugs:
            try:
                found += [j for j in fetcher(slug) if matches(cfg, j)]
            except (urllib.error.URLError, urllib.error.HTTPError,
                    json.JSONDecodeError, KeyError) as e:
                errors.append(f"{source}/{slug}: {e}")
    added, err = append_jobs(found)
    if err:
        errors.append(err)
    return {"checked": sum(len(s) for s in load_config()
                           .get("sources", {}).values()),
            "matched": len(found), "added": added, "errors": errors}


# ------------------------------------------------------------------ server

class Handler(BaseHTTPRequestHandler):
    def _send(self, obj, code=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods",
                         "GET, POST, OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self._send({})

    def do_GET(self):
        if self.path.startswith("/jobs"):
            _, _, rows = read_rows()
            jobs = [{k: r.get(k) for k in
                     ("id", "found", "company", "title", "location",
                      "url", "source", "status", "applied")}
                    for r in rows if r.get("status") not in ("Archived",)]
            self._send({"jobs": jobs})
        elif self.path == "/profile":
            self._send(load_config().get("profile", {}))
        elif self.path == "/":
            self._send({"ok": True, "spreadsheet": str(XLSX_PATH)})
        else:
            self._send({"error": "not found"}, 404)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        data = json.loads(self.rfile.read(length) or b"{}")
        if self.path == "/refresh":
            self._send(refresh())
        elif self.path == "/status":
            err = set_status(data.get("id", ""), data.get("status", "New"))
            self._send({"error": err} if err else {"ok": True})
        elif self.path == "/add":
            if not data.get("url"):
                self._send({"error": "url required"}, 400)
                return
            added, err = append_jobs([{
                "company": data.get("company", ""),
                "title": data.get("title", ""),
                "location": data.get("location", ""),
                "url": data["url"], "source": "manual"}])
            self._send({"error": err} if err else
                       {"ok": True, "added": added})
        else:
            self._send({"error": "not found"}, 404)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    ensure_workbook()
    print(f"Job Apply Kit server → http://127.0.0.1:{PORT}")
    print(f"Tracker              → {XLSX_PATH}")
    print("Leave this running; use the extension popup. Ctrl+C to stop.")
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
