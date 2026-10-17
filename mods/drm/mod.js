/* Protected video mod: Netflix, Disney+, Spotify and the like play through
 * Google's Widevine, which this mod turns on and downloads.
 *
 *   :drm    says whether Widevine is ready (and its version)
 *
 * Without this mod Breached keeps protected video off and, the first time a
 * site asks for it, offers to install this mod (see ModHost.protectedVideo).
 * Removing the mod turns protected video off again. */

"use strict";

const Widevine = ChromeUtils.importESModule(Mod.url + "Widevine.sys.mjs");

const ProtectedVideo = {
  /** Turns protected video on and gets Widevine; true when it's ready. */
  async enable() {
    Widevine.allow(true);
    if (Widevine.installed()) {
      return true;
    }
    let first = !Widevine.busy();
    if (first) {
      Breached.showMessage("Getting Widevine for protected video…");
    }
    try {
      let ready = await Widevine.install();
      if (first && ready) {
        Breached.showMessage("Protected video is ready");
      }
      return ready;
    } catch (e) {
      console.error("Breached DRM:", e);
      Breached.showMessage(`Couldn't get Widevine: ${e.message ?? e.type ?? e}`, "error");
      return false;
    }
  },

  /** Called by Breached when a page asks for protected video. */
  async request(browser, host, { keySystem, status }) {
    if (!keySystem?.startsWith(Widevine.KEY_SYSTEM)) {
      return;
    }
    if (!["api-disabled", "cdm-disabled", "cdm-not-installed"].includes(status)) {
      return;
    }
    if (await this.enable()) {
      // The page asked before Widevine was ready: it tries again after a reload.
      if (browser.isConnected) {
        browser.reload();
      }
    }
  },
};

Mod.hook("protectedVideo", ProtectedVideo);
ProtectedVideo.enable();

Mod.command("drm", {
  usage: "drm  (protected video: is Widevine ready?)",
  run() {
    if (Widevine.installed()) {
      Breached.showMessage(`Protected video is on (Widevine ${Widevine.version()}). Remove the mod in settings > mods to turn it off`);
    } else {
      ProtectedVideo.enable();
    }
  },
});

Mod.onUninstall(() => Widevine.allow(false));
