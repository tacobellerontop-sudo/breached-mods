# Breached mods

Optional features for [Breached](https://github.com/tacobellerontop-sudo/breached), the lightweight Windows browser. Breached leaves out the big features most browsers ship with; each mod brings one back for the people who want it.

**Install them from the mods site: https://tacobellerontop-sudo.github.io/breached-mods/**

Open that page in Breached and press Install (Breached asks you to confirm). Installed mods show in Settings > Mods, where you change their settings or remove them. In another browser the page offers each mod's zip instead, which Settings > Mods > Add a mod from a .zip installs.

| Mod | What it adds |
| --- | --- |
| Protected video (DRM) | Netflix, Disney+, Spotify and other protected media, through Google's Widevine (big streaming sites need Breached 0.1.8 or newer). Breached offers it by itself the first time a site needs it. |
| Password manager | Saves the passwords you type and fills them in next time (Firefox's password store), asked in the command bar. |
| Bookmarks | Ctrl+D to bookmark a page, Ctrl+B or `:bookmarks` to open one. |
| Firefox Sync (experimental) | History, bookmarks and passwords synced with Firefox through a Mozilla account. |
| Speed | Trades memory for speed: tabs stay loaded, a spare process waits for new tabs, more page processes, a bigger memory cache, link prefetching. Roughly 150-400 MB more memory. |
| Vim keys and link hints | qutebrowser-style keys on pages: f puts letters on links to follow them, j/k scroll, gg/G, H/L back and forward, J/K switch tabs, d closes, u reopens. |
| Dark pages | Sites with a dark look switch to it, light sites are darkened (photos keep their colours). :dark per site. |
| Screenshots | :screenshot saves a PNG of the page to Downloads; -f for the whole page, -c to copy. Ctrl+Shift+S. |
| Tab groups | Tabs together under a coloured name in the tab bar; click the name to fold the group away. :group, :ungroup, :groups. |
| Picture-in-picture | Videos play in a small window that stays on top, with Firefox's player controls. Point at a video for its button, or `:pip` (Ctrl+Shift+]). Needs Breached 0.1.12. |
| Translate pages | Firefox's private translation: pages are translated on your computer. Breached asks on pages in other languages; `:translate`, `:translate de`, `:translate off`. Each language downloads once (20-40 MB). Needs Breached 0.1.12. |
| Custom CSS per site | Your own style rules per website. `:css` edits the site's rules in the command bar, `:css off` removes them, `:css list` shows the sites. |
| Bitwarden | Fill logins from your Bitwarden vault into login forms, paste or copy them into any login box with Ctrl+Shift+L (or both at once: username, Tab, password), find secure notes, cards and identities, make new passwords and usernames, save new logins, unlock with a PIN, and sign in with passkeys kept there (Breached answers passkey requests itself instead of Windows), through the Bitwarden command-line app. |

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

## Licence

Mozilla Public License 2.0, see [LICENSE](LICENSE).
