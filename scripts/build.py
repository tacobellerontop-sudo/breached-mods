#!/usr/bin/env python3
"""Builds the Breached mods site.

    python3 scripts/build.py [out-dir]     (default: _site)

Each folder in mods/ becomes <out>/mods/<id>.zip, listed in <out>/mods.json
and on <out>/index.html with an Install link Breached recognises. Fails if a
mod's mod.json is missing something Breached needs.
"""
import html
import json
import re
import shutil
import sys
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
VERSION_RE = re.compile(r"^\d+(\.\d+)*$")
# Fixed time stamps keep a zip the same when its mod hasn't changed.
ZIP_TIME = (2026, 1, 1, 0, 0, 0)


def fail(message):
    sys.exit(f"build.py: {message}")


def read_mod(folder):
    try:
        info = json.loads((folder / "mod.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        fail(f"{folder.name}/mod.json: {e}")
    for key in ("id", "name", "version", "description", "script"):
        if not isinstance(info.get(key), str) or not info[key]:
            fail(f"{folder.name}/mod.json needs a {key}")
    if info["id"] != folder.name or not ID_RE.match(info["id"]):
        fail(f"{folder.name}/mod.json: id must be the folder's name (a-z, 0-9, - and _)")
    if not VERSION_RE.match(info["version"]):
        fail(f"{folder.name}/mod.json: version must look like 1.0")
    if not (folder / info["script"]).is_file() or "/" in info["script"]:
        fail(f"{folder.name}/mod.json: script {info['script']} isn't in the folder")
    for setting in info.get("settings", []):
        if not str(setting.get("pref", "")).startswith(f"breached.mods.{info['id']}."):
            fail(f"{folder.name}: setting {setting.get('pref')} must start with breached.mods.{info['id']}.")
    return info


def zip_mod(folder, target):
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as z:
        for path in sorted(folder.rglob("*")):
            if path.is_file():
                entry = zipfile.ZipInfo(f"{folder.name}/{path.relative_to(folder).as_posix()}", ZIP_TIME)
                entry.compress_type = zipfile.ZIP_DEFLATED
                z.writestr(entry, path.read_bytes())


def card(mod):
    e = html.escape
    tags = "".join(
        f'<span class="tag">{e(t)}</span>'
        for t in (["experimental"] if mod.get("experimental") else []) + [f"{mod['size'] // 1024 + 1} KB"]
    )
    commands = ", ".join(f"<code>:{e(c)}</code>" for c in mod.get("commands", []))
    return f"""
    <article class="mod" id="{e(mod['id'])}">
      <div class="text">
        <h2>{e(mod['name'])} <span class="version">{e(mod['version'])}</span></h2>
        <p>{e(mod['description'])}</p>
        <p class="meta">{tags}{f'<span class="commands">{commands}</span>' if commands else ''}</p>
      </div>
      <a class="install" href="mods/{e(mod['id'])}.zip" data-breached-mod="{e(mod['id'])}"
         data-version="{e(mod['version'])}">Install</a>
    </article>"""


def main():
    out = Path(sys.argv[1] if len(sys.argv) > 1 else REPO / "_site").resolve()
    shutil.rmtree(out, ignore_errors=True)
    (out / "mods").mkdir(parents=True)
    mods = []
    for folder in sorted(p for p in (REPO / "mods").iterdir() if p.is_dir()):
        info = read_mod(folder)
        target = out / "mods" / f"{info['id']}.zip"
        zip_mod(folder, target)
        mods.append(
            {
                "id": info["id"],
                "name": info["name"],
                "version": info["version"],
                "description": info["description"],
                "experimental": bool(info.get("experimental")),
                "commands": info.get("commands", []),
                "zip": f"mods/{info['id']}.zip",
                "size": target.stat().st_size,
            }
        )
    mods.sort(key=lambda m: (m["experimental"], m["name"].lower()))
    (out / "mods.json").write_text(json.dumps({"mods": mods}, indent=2) + "\n", encoding="utf-8")
    page = (REPO / "site/index.html").read_text(encoding="utf-8")
    page = page.replace("<!-- mods -->", "".join(card(m) for m in mods))
    (out / "index.html").write_text(page, encoding="utf-8")
    for name in ("style.css", "site.js"):
        shutil.copyfile(REPO / "site" / name, out / name)
    (out / ".nojekyll").write_text("")
    print(f"build.py: {len(mods)} mods in {out}")


if __name__ == "__main__":
    main()
