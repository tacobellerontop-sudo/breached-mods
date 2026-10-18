/* Dark pages mod.
 *
 *   :dark   stops darkening the site you're on (or starts again)
 *
 * Sites with their own dark look get it through prefers-color-scheme. Light
 * sites without one get a darkening style sheet (DarkChild). */

"use strict";

const MODE = "breached.mods.dark.mode";
const OFF_SITES = "breached.mods.dark.offSites";
const SCHEME = "layout.css.prefers-color-scheme.content-override";

let defaults = Services.prefs.getDefaultBranch("");
defaults.setStringPref(MODE, "all");
defaults.setStringPref(OFF_SITES, "");
// 0 is dark. Kept on the default branch so removing the mod (or a restart
// without it) puts Gecko's own value back.
// The first window keeps Gecko's value for all of them.
const ORIGINAL = "breached.mods.dark.originalScheme";
if (!defaults.getPrefType(ORIGINAL)) {
  defaults.setIntPref(ORIGINAL, defaults.getPrefType(SCHEME) ? defaults.getIntPref(SCHEME) : 2);
}
defaults.setIntPref(SCHEME, 0);
Mod.onUninstall(() => {
  if (defaults.getPrefType(ORIGINAL)) {
    defaults.setIntPref(SCHEME, defaults.getIntPref(ORIGINAL));
    defaults.deleteBranch(ORIGINAL);
  }
});

const DARK = Mod.actor("BreachedDark", {
  parent: "DarkParent.sys.mjs",
  child: "DarkChild.sys.mjs",
  events: { DOMContentLoaded: {}, pageshow: {} },
  allFrames: false,
  matches: ["http://*/*", "https://*/*", "file:///*"],
});

function offSites() {
  return new Set(Services.prefs.getStringPref(OFF_SITES, "").split(" ").filter(Boolean));
}

Mod.command("dark", {
  usage: "dark  (stop darkening this site, or start again)",
  run() {
    let browser = Breached.selectedBrowser;
    let host = browser?.currentURI?.host;
    if (!host) {
      throw new Error("open a website first");
    }
    let sites = offSites();
    let off = !sites.delete(host);
    if (off) {
      sites.add(host);
    }
    Services.prefs.setStringPref(OFF_SITES, [...sites].join(" "));
    Breached.showMessage(off ? `Not darkening ${host} any more` : `Darkening ${host} again`);
    browser.reload();
  },
});
