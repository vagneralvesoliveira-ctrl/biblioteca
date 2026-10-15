"""Monta a Biblioteca pronta da Estante.

Lê livros.txt, encontra cada livro no Project Gutenberg (via Gutendex),
baixa o texto para books/<id>.txt e grava catalog.json.
Roda no GitHub Actions (ver .github/workflows/livros.yml).
"""
import json
import pathlib
import re
import sys
import time
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
BOOKS = ROOT / "books"
GUTENDEX = "https://gutendex.com/books/"
UA = {"User-Agent": "Estante/1.0 (leitor pessoal; github pages)"}


def get(url, tries=4):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            if i == tries - 1:
                raise
            print(f"  nova tentativa ({e})")
            time.sleep(3 * (i + 1))


def author_name(raw):
    if not raw:
        return "Autor desconhecido"
    m = re.match(r"^([^,]+),\s*(.+)$", raw)
    name = f"{m.group(2)} {m.group(1)}" if m else raw
    return re.sub(r"\s+", " ", re.sub(r"\s*\(.*?\)\s*", " ", name)).strip()


def clean_title(t):
    return re.sub(r"\s+", " ", re.split(r"\r?\n|\$", t or "Sem título")[0]).strip()


def has_text(b):
    return any(k.startswith("text/plain") for k in b.get("formats", {}))


def find(entry):
    if entry.isdigit():
        data = json.loads(get(f"{GUTENDEX}?ids={entry}"))
    else:
        q = urllib.parse.urlencode({"search": entry, "languages": "pt"})
        data = json.loads(get(f"{GUTENDEX}?{q}"))
        if not data["results"]:
            data = json.loads(get(f"{GUTENDEX}?{urllib.parse.urlencode({'search': entry})}"))
    results = [b for b in data["results"] if has_text(b)]
    return results[0] if results else None


def decode(raw):
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("cp1252", errors="replace")


def download(book):
    gid = book["id"]
    urls = [v for k, v in book["formats"].items() if k.startswith("text/plain") and not v.endswith(".zip")]
    urls.sort(key=lambda u: 0 if "utf-8" in u or u.endswith(".txt.utf-8") else 1)
    urls.append(f"https://www.gutenberg.org/cache/epub/{gid}/pg{gid}.txt")
    for u in urls:
        try:
            text = decode(get(u.replace("http://", "https://")))
            if len(text) > 800:
                return text.replace("\r\n", "\n")
        except Exception as e:  # noqa: BLE001
            print(f"  falhou {u}: {e}")
    return None


def main():
    BOOKS.mkdir(exist_ok=True)
    old = {}
    cat_path = ROOT / "catalog.json"
    if cat_path.exists():
        try:
            old = {str(b["id"]): b for b in json.loads(cat_path.read_text("utf-8"))}
        except Exception:  # noqa: BLE001
            old = {}

    entries = []
    for line in (ROOT / "livros.txt").read_text("utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        if line:
            entries.append(line)

    catalog, seen, missing = [], set(), []
    for entry in entries:
        print(f"> {entry}")
        try:
            b = find(entry)
        except Exception as e:  # noqa: BLE001
            print(f"  erro na busca: {e}")
            b = None
        if not b:
            print("  não encontrado")
            missing.append(entry)
            continue
        gid = str(b["id"])
        if gid in seen:
            continue
        seen.add(gid)
        path = BOOKS / f"{gid}.txt"
        if not path.exists():
            text = download(b)
            if not text:
                missing.append(entry)
                continue
            path.write_text(text, "utf-8")
            time.sleep(1)
        a = (b.get("authors") or [{}])[0]
        item = {
            "id": int(gid),
            "title": clean_title(b.get("title")),
            "author": author_name(a.get("name")),
            "lang": (b.get("languages") or [""])[0],
            "death_year": a.get("death_year"),
            "chars": path.stat().st_size,
            "file": f"books/{gid}.txt",
        }
        print(f"  ok: {item['title']} — {item['author']} (#{gid})")
        catalog.append(item)

    # remove arquivos de livros que saíram da lista
    keep = {f"{c['id']}.txt" for c in catalog}
    for f in BOOKS.glob("*.txt"):
        if f.name not in keep:
            f.unlink()

    cat_path.write_text(json.dumps(catalog, ensure_ascii=False, indent=1), "utf-8")
    print(f"\n{len(catalog)} livros na biblioteca.")
    if missing:
        print("Não encontrados:", "; ".join(missing))
    return 0


if __name__ == "__main__":
    sys.exit(main())
