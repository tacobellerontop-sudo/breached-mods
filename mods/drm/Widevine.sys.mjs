/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Google's Widevine, which plays protected video in Firefox's engine. Mozilla's
// update server hands it out; Gecko keeps it in the profile and updates it.

const WIDEVINE = "gmp-widevinecdm";
export const KEY_SYSTEM = "com.widevine.alpha";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  GMPInstallManager: "resource://gre/modules/GMPInstallManager.sys.mjs",
});

export function installed() {
  return !!Services.prefs.getStringPref(`media.${WIDEVINE}.version`, "");
}

export function version() {
  return Services.prefs.getStringPref(`media.${WIDEVINE}.version`, "");
}

/** Lets Gecko use Widevine (Firefox's own switches for it). */
export function allow(on) {
  Services.prefs.setBoolPref("media.eme.enabled", on);
  Services.prefs.setBoolPref(`media.${WIDEVINE}.visible`, on);
  Services.prefs.setBoolPref(`media.${WIDEVINE}.enabled`, on);
}

export function allowed() {
  return Services.prefs.getBoolPref("media.eme.enabled", false);
}

// One download at a time, shared by every window.
let installing = null;

/** Downloads Widevine if it isn't here yet. Resolves true when it's ready. */
export function install() {
  if (installed()) {
    return Promise.resolve(true);
  }
  installing ??= (async () => {
    let manager = new lazy.GMPInstallManager();
    try {
      let { addons } = await manager.checkForAddons();
      let widevine = addons.find(a => a.id == WIDEVINE && a.isValid);
      if (!widevine) {
        throw new Error("Mozilla's update server didn't offer Widevine");
      }
      if (!widevine.isInstalled) {
        await manager.installAddon(widevine);
      }
      return installed();
    } finally {
      manager.uninit();
      installing = null;
    }
  })();
  return installing;
}

export function busy() {
  return !!installing;
}
