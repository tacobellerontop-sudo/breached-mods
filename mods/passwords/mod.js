/* Password manager mod: Firefox's own password store, asked about in the
 * command bar (see Prompter.sys.mjs).
 *
 *   :passwords         fill a saved login into this page (rows to pick from
 *                      when there are several)
 *   :passwords copy    copy one of this site's passwords
 *   :passwords forget  delete one of this site's saved logins
 *   :passwords allow   offer to save passwords on this site again
 *   :passwords count   how many logins are saved
 *
 * Breached keeps signon.rememberSignons off without this mod, so Gecko
 * doesn't look for logins in forms at all. */

"use strict";

const Prompter = ChromeUtils.importESModule(Mod.url + "Prompter.sys.mjs");

const AUTOFILL_PREF = "breached.mods.passwords.autofill";

function syncPrefs() {
  Services.prefs.setBoolPref("signon.rememberSignons", true);
  Services.prefs.setBoolPref("signon.autofillForms", Mod.pref(AUTOFILL_PREF, true));
}

Services.prefs.getDefaultBranch("").setBoolPref(AUTOFILL_PREF, true);
syncPrefs();
Prompter.start();
Services.prefs.addObserver(AUTOFILL_PREF, syncPrefs);
Mod.onUnload(() => {
  Services.prefs.removeObserver(AUTOFILL_PREF, syncPrefs);
  Prompter.stop();
});
Mod.onUninstall(() => {
  Services.prefs.setBoolPref("signon.rememberSignons", false);
});

const FILL = Mod.actor("PasswordsFill", {
  parent: "FillParent.sys.mjs",
  child: "FillChild.sys.mjs",
});

const Passwords = {
  page() {
    let browser = Breached.selectedBrowser;
    let principal = browser?.contentPrincipal;
    if (!principal || !/^https?$/.test(principal.scheme)) {
      throw new Error("open a website first");
    }
    return { browser, origin: principal.originNoSuffix, host: principal.host };
  },

  async logins(origin) {
    return Services.logins.searchLoginsAsync({ origin });
  },

  async choose(label, logins) {
    if (logins.length == 1) {
      return logins[0];
    }
    let picked = await Breached.pick(label, logins.map(login => ({
      label: login.username || "(no username)",
      detail: `saved ${new Date(login.timeCreated).toLocaleDateString()}`,
      login,
    })));
    return picked?.login ?? null;
  },

  async fill(browser, login) {
    let top = browser.browsingContext;
    let filled = false;
    for (let bc of top.getAllBrowsingContextsInSubtree()) {
      let wg = bc.currentWindowGlobal;
      if (!wg || wg.documentPrincipal?.originNoSuffix != login.origin) {
        continue;
      }
      try {
        filled ||= await wg.getActor(FILL).sendQuery("Passwords:Fill", {
          username: login.username,
          password: login.password,
        });
      } catch (e) {
        // the frame went away
      }
    }
    Breached.showMessage(
      filled ? `Filled ${login.username || "the password"}` : "No login form found on this page",
      filled ? "info" : "error"
    );
  },

  async run(args) {
    let sub = args.trim();
    if (sub == "count") {
      let all = await Services.logins.getAllLogins();
      Breached.showMessage(`${all.length} saved login${all.length == 1 ? "" : "s"}`);
      return;
    }
    let { browser, origin, host } = this.page();
    if (sub == "allow") {
      Services.logins.setLoginSavingEnabled(origin, true);
      Breached.showMessage(`Breached will offer to save passwords on ${host} again`);
      return;
    }
    let logins = await this.logins(origin);
    if (!logins.length) {
      Breached.showMessage(`No saved logins for ${host}`, "error");
      return;
    }
    switch (sub) {
      case "": {
        let login = await this.choose(`${host} login:`, logins);
        if (login && Breached.selectedBrowser === browser) {
          await this.fill(browser, login);
        }
        return;
      }
      case "copy": {
        let login = await this.choose(`copy the password of:`, logins);
        if (login) {
          Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString(login.password);
          Breached.showMessage(`Copied the password of ${login.username || "the login"}`);
        }
        return;
      }
      case "forget": {
        let login = await this.choose(`delete the saved login:`, logins);
        if (login) {
          Services.logins.removeLogin(login);
          Breached.showMessage(`Deleted ${login.username || "the login"} on ${host}`);
        }
        return;
      }
    }
    throw new Error(`unknown: ${sub} (try copy, forget, allow, count)`);
  },
};

Mod.command("passwords", {
  usage: "passwords [copy|forget|allow|count]  (fill a saved login into this page)",
  run(args) {
    Passwords.run(args ?? "").catch(e => Breached.showMessage(`passwords: ${e.message}`, "error"));
  },
});
Mod.command("pw", { alias: "passwords" });
