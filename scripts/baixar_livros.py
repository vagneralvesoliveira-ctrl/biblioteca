"""Monta a Biblioteca pronta da Estante.

Lê livros.txt, encontra cada livro no catálogo oficial do Project Gutenberg
(pg_catalog.csv), baixa o texto para books/<id>.txt e grava catalog.json.
Roda no GitHub Actions (ver .github/workflows/livros.yml).
"""
import csv
import io
import json
import pathlib
import re
import sys
import time
import unicodedata
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
BOOKS = ROOT / "books"
CATALOG_CSV = "https://www.gutenberg.org/cache/epub/feeds/pg_catalog.csv"
UA = {"User-Agent": "Estante/1.0 (leitor pessoal; github pages)"}


def get(url, tries=3, timeout=90):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            if i == tries - 1:
                raise
            print(f"  nova tentativa ({e})")
            time.sleep(4 * (i + 1))


def fold(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9 ]+", " ", s.lower())


def author_name(raw):
    """'Assis, Machado de, 1839-1908; Outro, Fulano' -> ('Machado de Assis', 1908)"""
    first = (raw or "").split(";")[0].strip()
    if not first:
        return "Autor desconhecido", None
    years = re.search(r"(\d{3,4})?\??\s*-\s*(\d{3,4})\??\s*$", first)
    death = int(years.group(2)) if years and years.group(2) else None
    first = re.sub(r",?\s*(BCE?\s*)?\d{3,4}\??\s*-\s*(\d{3,4})?\??\s*(BCE?)?$", "", first)
    first = re.sub(r"\s*\[.*?\]\s*|\s*\(.*?\)\s*", " ", first).strip(" ,")
    parts = [p.strip() for p in first.split(",") if p.strip()]
    name = f"{parts[1]} {parts[0]}" if len(parts) >= 2 else first
    return re.sub(r"\s+", " ", name).strip(), death


def clean_title(t):
    return re.sub(r"\s+", " ", re.split(r"\r?\n|\$", t or "Sem título")[0]).strip()


def load_catalog():
    print("Baixando catálogo do Gutenberg…")
    raw = get(CATALOG_CSV).decode("utf-8")
    rows = [r for r in csv.DictReader(io.StringIO(raw)) if r.get("Type") == "Text"]
    print(f"{len(rows)} livros no catálogo.")
    return {r["Text#"]: r for r in rows}


def find(entry, cat):
    if entry.isdigit():
        return cat.get(entry)
    words = fold(entry).split()
    best = None
    for r in cat.values():
        title, auth = fold(r["Title"]), fold(r["Authors"])
        hay = f" {title} {auth} "
        if not all(f" {w}" in hay for w in words):
            continue
        langs = r["Language"].split(";")
        title_hits = sum(1 for w in words if f" {w}" in f" {title} ")
        # prioriza: em português, mais palavras no título, título mais curto (obra e não coletânea)
        score = (("pt" in langs), title_hits > 0, -len(title))
        if best is None or score > best[0]:
            best = (score, r)
    return best[1] if best else None


def decode(raw):
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("cp1252", errors="replace")


def download(gid):
    for u in (f"https://www.gutenberg.org/cache/epub/{gid}/pg{gid}.txt",
              f"https://www.gutenberg.org/ebooks/{gid}.txt.utf-8"):
        try:
            text = decode(get(u))
            if len(text) > 800:
                return text.replace("\r\n", "\n")
        except Exception as e:  # noqa: BLE001
            print(f"  falhou {u}: {e}")
    return None


def main():
    BOOKS.mkdir(exist_ok=True)
    cat = load_catalog()

    entries = []
    for line in (ROOT / "livros.txt").read_text("utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        if line:
            entries.append(line)

    catalog, seen, missing = [], set(), []
    for entry in entries:
        r = find(entry, cat)
        if not r:
            print(f"> {entry}: não encontrado")
            missing.append(entry)
            continue
        gid = r["Text#"]
        if gid in seen:
            continue
        seen.add(gid)
        path = BOOKS / f"{gid}.txt"
        if not path.exists():
            text = download(gid)
            if not text:
                missing.append(entry)
                continue
            path.write_text(text, "utf-8")
            time.sleep(1)
        author, death = author_name(r["Authors"])
        item = {
            "id": int(gid),
            "title": clean_title(r["Title"]),
            "author": author,
            "lang": r["Language"].split(";")[0].strip(),
            "death_year": death,
            "chars": path.stat().st_size,
            "file": f"books/{gid}.txt",
        }
        print(f"> {entry}: {item['title']} — {item['author']} (#{gid})")
        catalog.append(item)

    keep = {f"{c['id']}.txt" for c in catalog}
    for f in BOOKS.glob("*.txt"):
        if f.name not in keep:
            f.unlink()

    (ROOT / "catalog.json").write_text(json.dumps(catalog, ensure_ascii=False, indent=1), "utf-8")
    print(f"\n{len(catalog)} livros na biblioteca.")
    if missing:
        print("Não encontrados:", "; ".join(missing))
    return 0


if __name__ == "__main__":
    sys.exit(main())
