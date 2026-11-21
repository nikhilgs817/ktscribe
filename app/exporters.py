"""Exports: Markdown -> DOCX / PDF (with embedded screenshots), transcript -> TXT / SRT / MD."""
import os
import re
from pathlib import Path

from . import prompts

# ----------------------------------------------------------------------------- markdown parsing

_LIST = re.compile(r"^(\s*)([-*+]|\d+[.)])\s+(.*)$")
_IMG = re.compile(r"^!\[([^\]]*)\]\(([^)\s]+)\)\s*$")
_INLINE = re.compile(r"(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|(?<![\w*])\*[^*\s][^*]*\*(?!\w)|\[[^\]]+\]\([^)]+\))")


def parse_blocks(md: str) -> list[tuple]:
    lines = md.replace("\r\n", "\n").split("\n")
    out, i, para = [], 0, []

    def flush():
        if para:
            out.append(("p", " ".join(x.strip() for x in para)))
            para.clear()

    while i < len(lines):
        ln = lines[i]
        s = ln.strip()
        if s.startswith("```"):
            flush()
            lang, code = s[3:].strip(), []
            i += 1
            while i < len(lines) and not lines[i].strip().startswith("```"):
                code.append(lines[i])
                i += 1
            out.append(("code", lang, "\n".join(code)))
            i += 1
            continue
        if not s:
            flush()
            i += 1
            continue
        m = re.match(r"^(#{1,6})\s+(.*)$", s)
        if m:
            flush()
            out.append(("h", len(m.group(1)), m.group(2).strip().rstrip("#").strip()))
            i += 1
            continue
        if re.fullmatch(r"(-{3,}|\*{3,}|_{3,})", s):
            flush()
            out.append(("hr",))
            i += 1
            continue
        m = _IMG.match(s)
        if m:
            flush()
            out.append(("img", m.group(1), m.group(2)))
            i += 1
            continue
        if s.startswith("|") and i + 1 < len(lines) and re.match(r"^\s*\|?\s*:?-{2,}", lines[i + 1]):
            flush()
            rows = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                r = lines[i].strip().strip("|")
                if not re.fullmatch(r"[\s:|-]+", r):
                    rows.append([c.strip() for c in re.split(r"(?<!\\)\|", r)])
                i += 1
            out.append(("table", rows))
            continue
        if s.startswith(">"):
            flush()
            q = []
            while i < len(lines) and lines[i].strip().startswith(">"):
                q.append(lines[i].strip().lstrip(">").strip())
                i += 1
            out.append(("quote", " ".join(q)))
            continue
        m = _LIST.match(ln)
        if m:
            flush()
            items, n = [], {}
            while i < len(lines):
                m = _LIST.match(lines[i])
                if m:
                    lvl = min(3, len(m.group(1).replace("\t", "    ")) // 2)
                    ordered = m.group(2)[0].isdigit()
                    for k in [k for k in n if k > lvl]:
                        n.pop(k)
                    n[lvl] = n.get(lvl, 0) + 1 if ordered else 0
                    items.append({"lvl": lvl, "ordered": ordered, "num": n[lvl], "text": m.group(3)})
                    i += 1
                elif lines[i].strip() and lines[i].startswith((" ", "\t")) and items:
                    items[-1]["text"] += " " + lines[i].strip()
                    i += 1
                else:
                    break
            out.append(("list", items))
            continue
        para.append(ln)
        i += 1
    flush()
    return out


def inline_runs(text: str) -> list[tuple[str, str]]:
    """-> [(text, kind)] kind in '', 'b', 'i', 'code', 'link'"""
    runs, pos = [], 0
    for m in _INLINE.finditer(text):
        if m.start() > pos:
            runs.append((text[pos:m.start()], ""))
        t = m.group(0)
        if t.startswith(("**", "__")):
            runs.append((t[2:-2], "b"))
        elif t.startswith("`"):
            runs.append((t[1:-1], "code"))
        elif t.startswith("["):
            lm = re.match(r"\[([^\]]+)\]\(([^)]+)\)", t)
            label, url = lm.group(1), lm.group(2)
            runs.append((label if label == url else f"{label} ({url})", "link"))
        else:
            runs.append((t[1:-1], "i"))
        pos = m.end()
    if pos < len(text):
        runs.append((text[pos:], ""))
    return [(t.replace("\\|", "|"), k) for t, k in runs]


def _resolve_img(src: str, frames_dir: Path) -> Path | None:
    if src.startswith("frame:"):
        p = frames_dir / f"{src[6:]}.jpg"
        return p if p.exists() else None
    m = re.search(r"/frames/(F\d+)\.jpg", src)
    if m:
        p = frames_dir / f"{m.group(1)}.jpg"
        return p if p.exists() else None
    return None


# ----------------------------------------------------------------------------- DOCX

def to_docx(md: str, frames_dir: Path, out: Path, title: str = ""):
    from docx import Document
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    from docx.shared import Inches, Pt, RGBColor

    doc = Document()
    sec = doc.sections[0]
    sec.left_margin = sec.right_margin = Inches(0.9)
    st = doc.styles["Normal"]
    st.font.name = "Calibri"
    st.font.size = Pt(10.5)

    def shade(par, color="F2F4F7"):
        ppr = par._p.get_or_add_pPr()
        shd = OxmlElement("w:shd")
        shd.set(qn("w:val"), "clear")
        shd.set(qn("w:color"), "auto")
        shd.set(qn("w:fill"), color)
        ppr.append(shd)

    def add_runs(par, text, bold=False):
        for t, k in inline_runs(text):
            r = par.add_run(t)
            r.bold = bold or k == "b"
            r.italic = k == "i"
            if k == "code":
                r.font.name = "Consolas"
                r.font.size = Pt(9.5)
                r.font.color.rgb = RGBColor(0xB4, 0x2B, 0x51)
            if k == "link":
                r.font.color.rgb = RGBColor(0x1F, 0x5F, 0xBF)

    for b in parse_blocks(md):
        kind = b[0]
        if kind == "h":
            h = doc.add_heading(level=min(b[1], 4) if b[1] > 1 else 0 if not doc.paragraphs else 1)
            add_runs(h, b[2])
        elif kind == "p":
            add_runs(doc.add_paragraph(), b[1])
        elif kind == "quote":
            p = doc.add_paragraph()
            p.paragraph_format.left_indent = Inches(0.3)
            shade(p, "EEF2FF")
            add_runs(p, b[1])
        elif kind == "list":
            for it in b[1]:
                p = doc.add_paragraph()
                p.paragraph_format.left_indent = Inches(0.3 + 0.3 * it["lvl"])
                p.paragraph_format.first_line_indent = Inches(-0.22)
                p.paragraph_format.space_after = Pt(2)
                p.add_run((f"{it['num']}." if it["ordered"] else "•") + "\u00a0\u00a0")
                add_runs(p, it["text"])
        elif kind == "code":
            p = doc.add_paragraph()
            shade(p)
            r = p.add_run(b[2])
            r.font.name = "Consolas"
            r.font.size = Pt(9)
        elif kind == "table":
            rows = b[1]
            if not rows:
                continue
            ncol = max(len(r) for r in rows)
            t = doc.add_table(rows=len(rows), cols=ncol)
            t.style = "Table Grid"
            for ri, row in enumerate(rows):
                for ci in range(ncol):
                    cell = t.cell(ri, ci)
                    cell.text = ""
                    add_runs(cell.paragraphs[0], row[ci] if ci < len(row) else "", bold=ri == 0)
                    if ri == 0:
                        shade(cell.paragraphs[0], "E5E9F0")
            doc.add_paragraph()
        elif kind == "img":
            p = _resolve_img(b[2], frames_dir)
            if p:
                # re-encode: python-docx rejects ffmpeg JPEGs that lack a JFIF header
                import io
                from PIL import Image as PILImage
                buf = io.BytesIO()
                with PILImage.open(p) as im:
                    im.convert("RGB").save(buf, "JPEG", quality=90)
                buf.seek(0)
                doc.add_picture(buf, width=Inches(6.4))
                doc.paragraphs[-1].alignment = WD_ALIGN_PARAGRAPH.CENTER
                if b[1]:
                    c = doc.add_paragraph()
                    c.alignment = WD_ALIGN_PARAGRAPH.CENTER
                    r = c.add_run(b[1])
                    r.italic = True
                    r.font.size = Pt(9)
                    r.font.color.rgb = RGBColor(0x55, 0x5B, 0x66)
        elif kind == "hr":
            doc.add_paragraph("─" * 40).alignment = WD_ALIGN_PARAGRAPH.CENTER
    doc.save(str(out))


# ----------------------------------------------------------------------------- PDF

def _fonts():
    """Register a Unicode TTF family if we can find one (Segoe UI on Windows)."""
    from reportlab.lib.fonts import addMapping
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont

    win = Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts"
    candidates = [
        (win / "segoeui.ttf", win / "segoeuib.ttf", win / "segoeuii.ttf", win / "consola.ttf"),
        (win / "arial.ttf", win / "arialbd.ttf", win / "ariali.ttf", win / "cour.ttf"),
        (Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
         Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
         Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Oblique.ttf"),
         Path("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf")),
    ]
    for reg, bold, ital, mono in candidates:
        if reg.exists() and bold.exists():
            try:
                pdfmetrics.registerFont(TTFont("KT", str(reg)))
                pdfmetrics.registerFont(TTFont("KT-B", str(bold)))
                pdfmetrics.registerFont(TTFont("KT-I", str(ital if ital.exists() else reg)))
                addMapping("KT", 0, 0, "KT")
                addMapping("KT", 1, 0, "KT-B")
                addMapping("KT", 0, 1, "KT-I")
                addMapping("KT", 1, 1, "KT-B")
                mono_name = "Courier"
                if mono.exists():
                    pdfmetrics.registerFont(TTFont("KT-M", str(mono)))
                    mono_name = "KT-M"
                return "KT", "KT-B", mono_name, True
            except Exception:
                continue
    return "Helvetica", "Helvetica-Bold", "Courier", False


def to_pdf(md: str, frames_dir: Path, out: Path, title: str = ""):
    from xml.sax.saxutils import escape

    from reportlab.lib import colors
    from reportlab.lib.enums import TA_CENTER
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import cm
    from reportlab.platypus import (Image, KeepTogether, Paragraph, Preformatted, SimpleDocTemplate,
                                    Spacer, Table, TableStyle)

    base, bold, mono, uni = _fonts()

    def clean(t):
        if uni:
            return t
        return t.encode("latin-1", "replace").decode("latin-1")

    ss = getSampleStyleSheet()
    body = ParagraphStyle("b", parent=ss["Normal"], fontName=base, fontSize=10, leading=14.5, spaceAfter=5)
    small = ParagraphStyle("s", parent=body, fontSize=8.5, leading=11, textColor=colors.HexColor("#555B66"),
                           alignment=TA_CENTER)
    hs = {
        1: ParagraphStyle("h1", parent=body, fontName=bold, fontSize=19, leading=24, spaceBefore=6, spaceAfter=10,
                          textColor=colors.HexColor("#1B2333")),
        2: ParagraphStyle("h2", parent=body, fontName=bold, fontSize=14, leading=18, spaceBefore=12, spaceAfter=6,
                          textColor=colors.HexColor("#2A3A5E")),
        3: ParagraphStyle("h3", parent=body, fontName=bold, fontSize=11.5, leading=15, spaceBefore=8, spaceAfter=4),
    }
    code_st = ParagraphStyle("c", parent=body, fontName=mono, fontSize=8.3, leading=10.5, spaceAfter=0)
    cell = ParagraphStyle("cell", parent=body, fontSize=8.8, leading=11.5, spaceAfter=0)

    def rich(text):
        parts = []
        for t, k in inline_runs(text):
            e = escape(clean(t))
            if k == "b":
                parts.append(f"<b>{e}</b>")
            elif k == "i":
                parts.append(f"<i>{e}</i>")
            elif k == "code":
                parts.append(f'<font face="{mono}" color="#B42B51">{e}</font>')
            elif k == "link":
                parts.append(f'<font color="#1F5FBF">{e}</font>')
            else:
                parts.append(e)
        return "".join(parts)

    W = A4[0] - 4 * cm
    story = []
    for b in parse_blocks(md):
        k = b[0]
        if k == "h":
            story.append(Paragraph(rich(b[2]), hs.get(b[1], hs[3])))
        elif k == "p":
            story.append(Paragraph(rich(b[1]), body))
        elif k == "quote":
            story.append(Paragraph(rich(b[1]), ParagraphStyle("q", parent=body, leftIndent=12,
                                                             backColor=colors.HexColor("#EEF2FF"), borderPadding=5)))
        elif k == "list":
            for it in b[1]:
                st = ParagraphStyle("li", parent=body, leftIndent=16 + 14 * it["lvl"], bulletIndent=4 + 14 * it["lvl"],
                                    spaceAfter=2)
                story.append(Paragraph(rich(it["text"]), st,
                                       bulletText=f"{it['num']}." if it["ordered"] else "•"))
            story.append(Spacer(1, 4))
        elif k == "code":
            box = Table([[Preformatted(clean(b[2]), code_st)]], colWidths=[W])
            box.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#F2F4F7")),
                                     ("BOX", (0, 0), (-1, -1), 0.4, colors.HexColor("#DDE2EA")),
                                     ("LEFTPADDING", (0, 0), (-1, -1), 8), ("TOPPADDING", (0, 0), (-1, -1), 6),
                                     ("BOTTOMPADDING", (0, 0), (-1, -1), 6)]))
            story += [box, Spacer(1, 8)]
        elif k == "table":
            rows = b[1]
            if not rows:
                continue
            ncol = max(len(r) for r in rows)
            data = [[Paragraph(("<b>%s</b>" if ri == 0 else "%s") % rich(r[c] if c < len(r) else ""), cell)
                     for c in range(ncol)] for ri, r in enumerate(rows)]
            t = Table(data, colWidths=[W / ncol] * ncol, repeatRows=1)
            t.setStyle(TableStyle([
                ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#C9CFD8")),
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#E5E9F0")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            ]))
            story += [t, Spacer(1, 8)]
        elif k == "img":
            p = _resolve_img(b[2], frames_dir)
            if p:
                from PIL import Image as PILImage
                with PILImage.open(p) as im:
                    w, h = im.size
                iw = W
                ih = iw * h / w
                if ih > 12 * cm:
                    ih = 12 * cm
                    iw = ih * w / h
                img = Image(str(p), width=iw, height=ih)
                parts = [Spacer(1, 4), img]
                if b[1]:
                    parts.append(Paragraph(escape(clean(b[1])), small))
                parts.append(Spacer(1, 8))
                story.append(KeepTogether(parts))
        elif k == "hr":
            story.append(Spacer(1, 10))

    def footer(canvas, doc_):
        canvas.saveState()
        canvas.setFont(base, 8)
        canvas.setFillColor(colors.HexColor("#8A93A3"))
        canvas.drawString(2 * cm, 1.2 * cm, clean(title)[:90])
        canvas.drawRightString(A4[0] - 2 * cm, 1.2 * cm, f"Page {doc_.page}")
        canvas.restoreState()

    doc = SimpleDocTemplate(str(out), pagesize=A4, leftMargin=2 * cm, rightMargin=2 * cm,
                            topMargin=1.8 * cm, bottomMargin=2 * cm, title=title)
    doc.build(story, onFirstPage=footer, onLaterPages=footer)


# ----------------------------------------------------------------------------- transcript

def srt_time(t: float, sep=",") -> str:
    ms = int(round(t * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}{sep}{ms:03d}"


def transcript_srt(segments) -> str:
    return "\n".join(f"{i + 1}\n{srt_time(s['start'])} --> {srt_time(s['end'])}\n{s['text']}\n"
                     for i, s in enumerate(segments))


def transcript_txt(segments) -> str:
    return "\n\n".join(f"[{prompts.ts(b['start'])}] {b['text']}" for b in prompts.blocks(segments))


def summary_md(summary: dict) -> str:
    if not summary:
        return ""
    out = []
    if summary.get("summary"):
        out += ["## Summary", "", summary["summary"], ""]
    for key, label in (("key_points", "Key points"), ("systems", "Systems & tools mentioned"),
                       ("action_items", "Action items"), ("open_questions", "Open questions")):
        if summary.get(key):
            out += [f"## {label}", ""] + [f"- {x}" for x in summary[key]] + [""]
    if summary.get("chapters"):
        out += ["## Chapters", "", "| Time | Topic | Summary |", "|---|---|---|"]
        out += [f"| {c.get('start', '')} | {c.get('title', '')} | {c.get('summary', '')} |" for c in summary["chapters"]]
        out.append("")
    return "\n".join(out)


def transcript_md(title: str, segments, summary: dict | None, chapters=True) -> str:
    out = [f"# {title}", ""]
    if summary:
        out += [summary_md(summary), "## Transcript", ""]
    chs = []
    if chapters and summary:
        for c in summary.get("chapters") or []:
            try:
                parts = [int(x) for x in str(c.get("start", "")).split(":")]
                sec = parts[-1] + 60 * parts[-2] + (3600 * parts[-3] if len(parts) > 2 else 0)
                chs.append((sec, c.get("title", "")))
            except Exception:
                pass
    ci = 0
    for b in prompts.blocks(segments, breaks=[c[0] for c in chs]):
        while ci < len(chs) and chs[ci][0] <= b["start"] + 1:
            out += [f"### {chs[ci][1]}", ""]
            ci += 1
        out += [f"**[{prompts.ts(b['start'])}]** {b['text']}", ""]
    return "\n".join(out)
