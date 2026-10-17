/* Firefox Sync mod (experimental): history, bookmarks and passwords synced
 * through a Mozilla account, with Gecko's own Sync code (Sync.sys.mjs).
 *
 *   :sync          who's signed in and when it last synced
 *   :sync in       open the Mozilla account sign-in page
 *   :sync now      sync now
 *   :sync account  open your account's settings page
 *   :sync out      sign out (the synced data stays here) */

"use strict";

const Sync = ChromeUtils.importESModule(Mod.url + "Sync.sys.mjs");
Sync.start();

const SYNC_TOPICS = {
  "weave:service:sync:finish": () => Breached.showMessage("Synced"),
  "weave:service:sync:error": () => Breached.showMessage("Sync failed; :sync shows the state", "error"),
  "weave:service:login:error": () => Breached.showMessage("Sync couldn't sign in; try :sync in", "error"),
  "fxaccounts:onlogin": () => Breached.showMessage("Signed in to your Mozilla account; syncing…"),
};

// Messages show in the window that asked (the front one), not in every window.
let watching = false;
const observer = {
  observe(subject, topic) {
    if (watching && Services.wm.getMostRecentWindow("breached:main") == window) {
      SYNC_TOPICS[topic]?.();
      if (topic == "weave:service:sync:finish" || topic == "weave:service:sync:error") {
        watching = false;
      }
    }
  },
};
for (let topic of Object.keys(SYNC_TOPICS)) {
  Services.obs.addObserver(observer, topic);
}
Mod.onUnload(() => {
  for (let topic of Object.keys(SYNC_TOPICS)) {
    Services.obs.removeObserver(observer, topic);
  }
});
Mod.onUninstall(() => Sync.stop());

async function run(args) {
  switch (args.trim()) {
    case "": {
      let user = await Sync.user();
      if (!user) {
        Breached.showMessage("Sync: not signed in. :sync in opens the sign-in page");
        return;
      }
      let last = Sync.lastSync();
      Breached.showMessage(
        `Sync: signed in as ${user.email}${user.verified ? "" : " (not verified yet)"}. ` +
          (last ? `Last synced ${last.toLocaleString()}` : "Not synced yet")
      );
      return;
    }
    case "in":
    case "signin":
      watching = true;
      Breached.openTab(await Sync.signInURL());
      return;
    case "account":
      Breached.openTab(await Sync.manageURL());
      return;
    case "now":
      if (!(await Sync.user())) {
        throw new Error("not signed in: :sync in");
      }
      watching = true;
      Breached.showMessage("Syncing…");
      await Sync.syncNow();
      return;
    case "out":
    case "signout":
      await Sync.signOut();
      Breached.showMessage("Signed out of Sync");
      return;
  }
  throw new Error(`unknown: ${args} (try in, now, account, out)`);
}

Mod.command("sync", {
  usage: "sync [in|now|account|out]  (Firefox Sync: history, bookmarks, passwords)",
  run(args) {
    run(args ?? "").catch(e => Breached.showMessage(`sync: ${e.message}`, "error"));
  },
});
