# Breached mods

Optional features for [Breached](https://github.com/tacobellerontop-sudo/breached), the lightweight Windows browser. Breached leaves out the big features most browsers ship with; each mod brings one back for the people who want it.

**Install them from the mods site: https://tacobellerontop-sudo.github.io/breached-mods/**

Open that page in Breached and press Install (Breached asks you to confirm). Installed mods show in Settings > Mods, where you change their settings or remove them. In another browser the page offers each mod's zip instead, which Settings > Mods > Add a mod from a .zip installs.

| Mod | What it adds |
| --- | --- |
| Protected video (DRM) | Netflix, Disney+, Spotify and other protected media, through Google's Widevine. Breached offers it by itself the first time a site needs it. |
| Password manager | Saves the passwords you type and fills them in next time (Firefox's password store), asked in the command bar. |
| Bookmarks | Ctrl+D to bookmark a page, Ctrl+B or `:bookmarks` to open one. |
| Firefox Sync (experimental) | History, bookmarks and passwords synced with Firefox through a Mozilla account. |
| Bitwarden | Logins and passkeys from your Bitwarden vault, through the Bitwarden command-line app. |

## Making a mod

A mod is a folder in `mods/` named after its id, with a `mod.json` and a script:

```json
{
  "id": "example",
  "name": "Example",
  "version": "1.0",
  "description": "One or two sentences for the mods page.",
  "script": "mod.js",
  "breached": "0.1.7",
  "commands": ["example"],
  "settings": [{ "pref": "breached.mods.example.on", "label": "...", "hint": "...", "type": "bool" }]
}
```

- `breached` is the oldest Breached version the mod works with.
- `commands` lets Breached say which mod a command needs when it isn't installed.
- `settings` show in Settings > Mods; their prefs must start with `breached.mods.<id>.`. Types: `bool`, `text`, `choice` (with `options: [[value, label], ...]`).
- `experimental: true` marks the mod on the site.

The script runs in each Breached window with a `Mod` object: `Mod.command(name, { usage, run(args) })`, `Mod.key(key, modifiers, fn)`, `Mod.actor(name, { parent, child, events })` for page helpers, `Mod.hook(name, object)`, `Mod.pref(name, fallback)`, `Mod.onUnload(fn)` (window closes or mod removed) and `Mod.onUninstall(fn)` (mod removed). `Mod.url` is the mod folder's `resource://` address, for importing its own `.sys.mjs` modules. Mods run with the browser's full rights.

`python3 scripts/build.py` builds the site into `_site/`; pushing to `main` publishes it with GitHub Pages.
