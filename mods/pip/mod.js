/* Picture-in-picture mod: Firefox's own picture-in-picture player.
 *
 *   :pip   plays the tab's video in a small window on top (again closes it)
 *
 * Videos also get Firefox's picture-in-picture button when you point at them.
 * Gecko's player looks the video's tab up through Breached's gBrowser. */

"use strict";

// [setting, value with the mod]
const SETTINGS = [
  ["media.videocontrols.picture-in-picture.enabled", true],
  ["media.videocontrols.picture-in-picture.video-toggle.enabled", true],
  // Firefox's address bar button; Breached has no address bar.
  ["media.videocontrols.picture-in-picture.urlbar-button.enabled", false],
];

// Gecko's values, kept on the default branch (one for the whole app, gone at
// restart) so every window agrees on them and removing the mod puts them back.
const ORIGINALS = "breached.mods.pip.originals";
const defaults = Services.prefs.getDefaultBranch("");

if (!defaults.getPrefType(ORIGINALS)) {
  let before = {};
  for (let [name] of SETTINGS) {
    before[name] = defaults.getPrefType(name) ? defaults.getBoolPref(name) : null;
  }
  defaults.setStringPref(ORIGINALS, JSON.stringify(before));
}
for (let [name, value] of SETTINGS) {
  defaults.setBoolPref(name, value);
}
Mod.onUninstall(() => {
  let before = JSON.parse(defaults.getStringPref(ORIGINALS, "{}"));
  for (let [name, value] of Object.entries(before)) {
    if (value === null) {
      defaults.deleteBranch(name);
    } else {
      defaults.setBoolPref(name, value);
    }
  }
  defaults.deleteBranch(ORIGINALS);
});

// Firefox marks its address bar button when a video is in the player; there
// is none here, so those steps do nothing.
const { PictureInPicture } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/pictureinpicture/PictureInPicture.sys.mjs"
);
for (let name of ["setUrlbarPipIconActive", "setUrlbarPipIconInactive", "updateUrlbarToggle"]) {
  if (!PictureInPicture[name]?.breachedNoop) {
    let noop = () => {};
    noop.breachedNoop = true;
    PictureInPicture[name] = noop;
  }
}

Mod.command("pip", {
  usage: "pip  (play this tab's video in a small window on top; again to close it)",
  run() {
    let browser = Breached.selectedBrowser;
    let actor = browser?.browsingContext?.currentWindowGlobal?.getActor("PictureInPictureLauncher");
    if (!actor) {
      throw new Error("open a page with a video first");
    }
    // Firefox's Ctrl+Shift+] does the same: the focused video, else the
    // playing one, else the longest. On a video already in the player it
    // closes the player.
    actor.sendAsyncMessage("PictureInPicture:KeyToggle");
  },
});

// Ctrl+Shift+] as in Firefox.
Mod.key("]", "accel,shift", () => Breached.run("pip"));
