/* Speed mod: puts back the speed helpers Breached turns down to stay light.
 * Each one is a Gecko or Breached setting changed on the default branch, so
 * anything you set yourself (settings page, :set) still wins, and removing
 * the mod puts Breached's own values back.
 *
 *   :speed   lists what the mod changed and what each one does
 */

"use strict";

const KEEP_LOADED = "breached.mods.speed.keepTabsLoaded";

// [setting, value with the mod, what it does]
const SETTINGS = [
  ["dom.ipc.processPrelaunch.enabled", true, "a spare page process waits, so a new tab or site skips starting one"],
  ["dom.ipc.processCount", 8, "up to 8 shared page processes instead of 4, so busy tabs share less"],
  ["browser.cache.memory.capacity", 262144, "256 MB memory cache for images and scripts (Gecko picks about 32 MB)"],
  ["network.prefetch-next", true, "fetches pages a site marks as likely next"],
  ["browser.places.speculativeConnect.enabled", true, "connects early to history and bookmark sites you pick"],
  ["gfx.webrender.precache-shaders", true, "prepares graphics shaders at start, so first paints don't stall"],
];

// Breached's own default values, kept on the default branch (one for the
// whole app, gone at restart) so that every window agrees on them and
// removing the mod puts them back.
const ORIGINALS = "breached.mods.speed.originals";
const TABS = "breached.tabs.unloadAfterMinutes";
const defaults = Services.prefs.getDefaultBranch("");

function get(name) {
  switch (defaults.getPrefType(name)) {
    case defaults.PREF_BOOL:
      return defaults.getBoolPref(name);
    case defaults.PREF_INT:
      return defaults.getIntPref(name);
    case defaults.PREF_STRING:
      return defaults.getStringPref(name);
  }
  return null;
}

function set(name, value) {
  if (value === null) {
    defaults.deleteBranch(name);
  } else if (typeof value == "boolean") {
    defaults.setBoolPref(name, value);
  } else if (typeof value == "number") {
    defaults.setIntPref(name, value);
  } else {
    defaults.setStringPref(name, value);
  }
}

function originals() {
  try {
    return JSON.parse(defaults.getStringPref(ORIGINALS));
  } catch (e) {
    return null;
  }
}

function applyTabs() {
  set(TABS, Mod.pref(KEEP_LOADED, true) ? 0 : originals()?.[TABS] ?? 15);
}

if (!originals()) {
  let before = {};
  for (let name of [...SETTINGS.map(s => s[0]), TABS]) {
    before[name] = get(name);
  }
  defaults.setStringPref(ORIGINALS, JSON.stringify(before));
}
defaults.setBoolPref(KEEP_LOADED, true);
for (let [name, value] of SETTINGS) {
  set(name, value);
}
applyTabs();
Services.prefs.addObserver(KEEP_LOADED, applyTabs);
Mod.onUnload(() => Services.prefs.removeObserver(KEEP_LOADED, applyTabs));
Mod.onUninstall(() => {
  // The first window to hear of it puts everything back.
  let before = originals();
  if (!before) {
    return;
  }
  for (let [name, value] of Object.entries(before)) {
    set(name, value);
  }
  defaults.deleteBranch(ORIGINALS);
});

Mod.command("speed", {
  usage: "speed  (what the Speed mod changed)",
  run() {
    let rows = SETTINGS.map(([name, value, what]) => {
      let yours = Services.prefs.prefHasUserValue(name);
      return {
        label: what,
        detail: yours ? `${name}: you set ${Mod.pref(name)} yourself, so that stays` : `${name} = ${value}`,
      };
    });
    rows.unshift({
      label: Mod.pref(KEEP_LOADED, true) ? "tabs stay loaded (no sleeping after 15 minutes)" : "tabs sleep as usual (settings > Mods)",
      detail: `breached.tabs.unloadAfterMinutes = ${Mod.pref("breached.tabs.unloadAfterMinutes", 15)}`,
    });
    Breached.pick("The Speed mod changed these. Remove it in settings > Mods to put them back:", rows);
  },
});
