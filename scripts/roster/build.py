# 疏文法會名冊產生器（GitHub Actions 執行；小幫手在 LINE「疏文法會」群組下指令）
# 版面：A4、12 欄、注音芫荽 20.8pt。從最右邊一欄開始，由上往下排滿 10 格再往左一欄（唱名順序）。
# 人名（三字以內 → 四字）照方案順序全部排在前面；公司行號和其他長名全部放最後，一欄 3 格、格子一樣大。
# 用法：
#   python build.py job.json outdir          # 本機：讀 job.json 產生 PDF
#   python build.py --job <id> --api <url>   # Actions：用 GitHub OIDC 向網站拿工作、做好上傳
# job.json：{"title":..., "plans":[{"name":..,"names":[..]}], "split":{"parts":5,"first_extra":30,"company_weight":2} 或 null}
# 紀錄只印數量，不印任何名字。
import html, json, math, os, re, sys, urllib.request

FONT = os.environ.get("BPMF_FONT", os.path.expanduser("~/.fonts/BpmfIansui-Regular.ttf"))
SURNAME_VS = {"曾": "\U000E01E1", "查": "\U000E01E1", "任": "\U000E01E1", "樂": "\U000E01E1"}   # 曾ㄗㄥ、查ㄓㄚ、任ㄖㄣˊ、樂ㄩㄝˋ
VERT = {"（": "︵", "）": "︶", "(": "︵", ")": "︶", "【": "︻", "】": "︼", "「": "﹁", "」": "﹂", "《": "︽", "》": "︾"}
SH = 80.3            # 人名一格高（pt）
SUB = SH / 3         # 表格用 30 小列：人名一格＝3 小列、長名一格＝10 小列
cjk = lambda ch: bool(re.match(r"[㐀-鿿豈-﫿\U00020000-\U0002ffff]", ch))
def short(n): return len(n) <= 3 and all(cjk(c) for c in n)
def is4(n): return len(n) == 4 and all(cjk(c) for c in n)
def ncls(n): return "n c4" if is4(n) else "n"

def cell_html(n):
    if short(n) or is4(n):
        cs = [n[0] + SURNAME_VS.get(n[0], "")] + list(n[1:])
        return "".join(f"<div>{html.escape(c)}</div>" for c in cs)
    out, buf = [], ""
    def flush():
        nonlocal buf
        if buf.strip(): out.append(f'<div class="lat"><span>{html.escape(buf.strip())}</span></div>')
        buf = ""
    for c in n:
        if re.match(r"[A-Za-z0-9\-\.&' ,]", c) and not (c == "." and not buf): buf += c; continue
        flush()
        if c.strip(): out.append(f'<div class="{"p" if c in VERT else ""}">{html.escape(VERT.get(c, c))}</div>')
    flush()
    return "".join(out)

CSS = f"""@font-face {{ font-family: Bpmf; src: url(file://{FONT}); }}
@page {{ size: A4; margin: 0; }} body {{ margin: 0; }}
section {{ width: 595pt; height: 842pt; position: relative; page-break-after: always; overflow: hidden; }}
table {{ position: absolute; left: 15pt; top: 18.7pt; border-collapse: collapse; table-layout: fixed; width: 532.4pt; }}
td {{ border: 0.6pt solid #8c8c8c; vertical-align: top; padding: 0; overflow: hidden; }}
.n {{ font-family: Bpmf, 'Noto Sans CJK TC'; font-size: 20.8pt; line-height: 20.8pt; padding: 1.7pt 0 4pt 6.2pt; direction: ltr; }}
.n.c4 {{ font-size: 18.2pt; line-height: 18.6pt; }}
.n .p {{ font-family: 'Noto Sans CJK TC'; padding-left: 2pt; }}
.n .lat {{ font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; font-size: 12pt; line-height: 20.8pt; padding: 3pt 0 3pt 3pt; }}
.n .lat span {{ writing-mode: vertical-rl; display: inline-block; letter-spacing: 0.3pt; }}
.pg {{ position: absolute; left: 0; right: 0; top: 826pt; text-align: center; font: 9pt 'Helvetica Neue', Helvetica, Arial, sans-serif; }}"""
COLS = "".join("<col style='width:44.2pt'>" if i != 5 else "<col style='width:46.5pt'>" for i in range(12))

def flows(plans):
    sf = [n for p in plans for n in [x for x in p["names"] if short(x)] + [x for x in p["names"] if is4(x)]]
    lf = [n for p in plans for n in p["names"] if not short(n) and not is4(n)]
    return sf, lf

def build(job, outdir):
    from playwright.sync_api import sync_playwright
    os.makedirs(outdir, exist_ok=True)
    plans = [{"name": p["name"], "names": [str(x).strip() for x in p["names"] if str(x).strip()]} for p in job["plans"]]
    sf, lf = flows(plans)
    out = []
    with sync_playwright() as pw:
        b = pw.chromium.launch(); pg = b.new_page()
        def load(body, name="tmp.html"):
            path = os.path.join(outdir, name)
            open(path, "w", encoding="utf8").write(f"<!doctype html><meta charset=utf-8><style>{CSS}</style>{body}")
            pg.goto("file://" + os.path.abspath(path)); pg.wait_for_timeout(1500)
        # 量長名高度：太長的字縮小一點，塞進一樣大小的格子
        hl = {}
        if lf:
            load(f"<table dir=rtl style='position:static'>{COLS}" + "".join(f'<tr><td><div class="n">{cell_html(n)}</div></td>' + "<td></td>" * 11 + "</tr>" for n in lf) + "</table>")
            hl = dict(zip(lf, pg.evaluate("[...document.querySelectorAll('.n')].map(e => e.getBoundingClientRect().height * 0.75)")))
        LH = SUB * 10 - 6
        def long_cell(n):
            h = hl.get(n, 0)
            if h <= LH: return f'<div class="n">{cell_html(n)}</div>'
            k = LH / h
            return f'<div class="n" style="font-size:{20.8 * k:.1f}pt;line-height:{20.8 * k:.1f}pt">{cell_html(n)}</div>'
        def page_html(cols):
            grid = [[None] * 12 for _ in range(30)]
            for c, (kind, names) in enumerate(cols):
                span = 3 if kind == "S" else 10
                for j in range(30 // span):
                    grid[j * span][c] = (names[j] if j < len(names) else None, span, kind)
                    for t in range(1, span): grid[j * span + t][c] = "cov"
            span = 3 if cols[-1][0] == "S" else 10   # 空著的欄跟著前一欄的格子大小，橫線對齊
            for r in range(0, 30, span):
                for c in range(len(cols), 12):
                    grid[r][c] = (None, span, "S")
                    for t in range(1, span): grid[r + t][c] = "cov"
            trs = []
            for r in range(30):
                tds = []
                for c in range(12):
                    g = grid[r][c]
                    if g == "cov": continue
                    n, span, kind = g
                    inner = "" if n is None else (f'<div class="{ncls(n)}">{cell_html(n)}</div>' if kind == "S" else long_cell(n))
                    tds.append(f'<td rowspan="{span}">{inner}</td>')
                trs.append(f'<tr style="height:{SUB:.3f}pt">' + "".join(tds) + "</tr>")
            return "".join(trs)
        def render(s_, l_, fname):
            cols = [("S", s_[i:i + 10]) for i in range(0, len(s_), 10)] + [("L", l_[i:i + 3]) for i in range(0, len(l_), 3)]
            pages = [cols[i:i + 12] for i in range(0, len(cols), 12)]
            load("".join(f'<section><table dir=rtl>{COLS}{page_html(p)}</table><div class="pg">{i + 1}</div></section>' for i, p in enumerate(pages)))
            path = os.path.join(outdir, fname)
            pg.pdf(path=path, width="210mm", height="297mm", print_background=True)
            return path, len(pages)
        title = re.sub(r'[\\/:*?"<>|]', "", job.get("title") or "名冊")[:40]
        path, np_ = render(sf, lf, f"{title}.pdf")
        out.append({"file": path, "label": "完整名冊", "people": len(sf), "companies": len(lf), "pages": np_, "first": (sf + lf)[0] if sf + lf else "", "last": (sf + lf)[-1] if sf + lf else ""})
        sp = job.get("split") or None
        if sp and int(sp.get("parts") or 0) > 1:
            n, extra, cw = int(sp["parts"]), int(sp.get("first_extra") or 0), int(sp.get("company_weight") or 2)
            seq = [(x, 1, "S") for x in sf] + [(x, cw, "L") for x in lf]
            W = sum(w for _, w, _ in seq)
            first = math.ceil((W - extra) / n) + extra if n > 1 else W
            rest = W - first
            targets = [first] + [rest // (n - 1) + (1 if i < rest % (n - 1) else 0) for i in range(n - 1)]
            i = 0
            for k, t in enumerate(targets):
                cur, acc = [], 0
                while i < len(seq) and acc + seq[i][1] <= t: cur.append(seq[i]); acc += seq[i][1]; i += 1
                if k == n - 1: cur += seq[i:]; acc += sum(w for _, w, _ in seq[i:]); i = len(seq)
                s_ = [x for x, w, kd in cur if kd == "S"]; l_ = [x for x, w, kd in cur if kd == "L"]
                if not cur: continue
                path, np_ = render(s_, l_, f"{title}_第{k + 1}份.pdf")
                out.append({"file": path, "label": f"第 {k + 1} 份", "count": acc, "people": len(s_), "companies": len(l_), "pages": np_, "first": cur[0][0], "last": cur[-1][0]})
        b.close()
    return out, {"people": len(sf), "companies": len(lf), "total": len(sf) + len(lf)}

# ---------- GitHub Actions：用 OIDC 證明身分，向網站拿工作、上傳結果 ----------
def oidc():
    url = os.environ["ACTIONS_ID_TOKEN_REQUEST_URL"] + "&audience=taxtools-roster"
    req = urllib.request.Request(url, headers={"Authorization": "bearer " + os.environ["ACTIONS_ID_TOKEN_REQUEST_TOKEN"]})
    return json.load(urllib.request.urlopen(req))["value"]
def call(api, path, tok, data=None, ctype="application/json"):
    body = data if isinstance(data, (bytes, type(None))) else json.dumps(data).encode()
    req = urllib.request.Request(api + path, data=body, method="POST" if body is not None else "GET",
                                 headers={"Authorization": "Bearer " + tok, "content-type": ctype, "user-agent": "roster-builder"})
    return json.load(urllib.request.urlopen(req, timeout=120))

def run_job(job_id, api):
    tok = oidc()
    job = call(api, f"/api/roster/job?id={job_id}", tok)
    try:
        files, summary = build(job, "out")
        for f in files:
            r = call(api, f"/api/roster/file?id={job_id}&name={urllib.parse.quote(os.path.basename(f['file']))}", oidc(), open(f["file"], "rb").read(), "application/pdf")
            f["url"] = r.get("url"); f["fid"] = r.get("fid")
            print("uploaded", f["label"], f["pages"], "pages")
        call(api, f"/api/roster/done?id={job_id}", oidc(), {"ok": True, "summary": summary, "files": [{k: v for k, v in f.items() if k != "file"} for f in files]})
    except Exception as e:
        print("failed", type(e).__name__)
        call(api, f"/api/roster/done?id={job_id}", oidc(), {"ok": False, "error": type(e).__name__ + ": " + str(e)[:200]})
        raise

if __name__ == "__main__":
    import urllib.parse
    if sys.argv[1] == "--job":
        run_job(sys.argv[2], sys.argv[4] if len(sys.argv) > 4 else "https://taxtools.tw")
    else:
        files, summary = build(json.load(open(sys.argv[1], encoding="utf8")), sys.argv[2])
        print(json.dumps(summary, ensure_ascii=False))
        for f in files: print({k: v for k, v in f.items() if k not in ("first", "last")})
