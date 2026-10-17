/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Firefox's password manager (LoginManager) finds the logins in forms and
// keeps them, but asks "save this password?" with Firefox's doorhanger
// panels, which Breached doesn't have. While the mod is on, it asks in
// Breached's command bar instead (Breached.pickForTab in the tab's window).

import { LoginManagerParent } from "resource://gre/modules/LoginManagerParent.sys.mjs";

const original = LoginManagerParent.prototype._getPrompter;
let users = 0;

function hostOf(origin) {
  try {
    return Services.io.newURI(origin).displayHostPort;
  } catch (e) {
    return origin;
  }
}

function shellFor(browser) {
  return browser?.ownerGlobal?.Breached ?? null;
}

function who(login) {
  return login.username ? login.username : "(no username)";
}

async function ask(browser, label, items) {
  let shell = shellFor(browser);
  if (!shell) {
    return null;
  }
  return (await shell.pickForTab(browser, label, items))?.answer ?? null;
}

function say(browser, text) {
  shellFor(browser)?.showMessage(text);
}

/** Copies the new login's fields onto a saved one. */
async function update(oldLogin, newLogin) {
  let bag = Cc["@mozilla.org/hash-property-bag;1"].createInstance(Ci.nsIWritablePropertyBag);
  bag.setProperty("password", newLogin.password);
  if (newLogin.username) {
    bag.setProperty("username", newLogin.username);
  }
  bag.setProperty("timePasswordChanged", Date.now());
  Services.logins.modifyLogin(oldLogin, bag);
}

export const prompter = {
  QueryInterface: ChromeUtils.generateQI(["nsILoginManagerPrompter"]),

  async promptToSavePassword(browser, login, dismissed, notifySaved) {
    let host = hostOf(login.origin);
    if (notifySaved) {
      return null;
    }
    let answer = await ask(browser, `Save the password for ${who(login)} on ${host}?`, [
      { label: "save", detail: "keep it in Breached's password store", answer: "save" },
      { label: "not now", detail: "ask again next time", answer: "later" },
      { label: "never", detail: `never save passwords for ${host}`, answer: "never" },
    ]);
    if (answer == "save") {
      await Services.logins.addLoginAsync(login);
      say(browser, `Saved the password for ${who(login)} on ${host}`);
    } else if (answer == "never") {
      Services.logins.setLoginSavingEnabled(login.origin, false);
      say(browser, `Breached won't offer to save passwords for ${host}. :passwords allow turns it back on`);
    }
    return null;
  },

  async promptToChangePassword(browser, oldLogin, newLogin, dismissed, notifySaved) {
    if (notifySaved) {
      return null;
    }
    let host = hostOf(newLogin.origin);
    let answer = await ask(browser, `Update the saved password for ${who(oldLogin)} on ${host}?`, [
      { label: "update", detail: "replace the saved password with the new one", answer: "update" },
      { label: "not now", detail: "keep the old one", answer: "later" },
    ]);
    if (answer == "update") {
      await update(oldLogin, newLogin);
      say(browser, `Updated the password for ${who(oldLogin)} on ${host}`);
    }
    return null;
  },

  async promptToChangePasswordWithUsernames(browser, logins, newLogin) {
    let host = hostOf(newLogin.origin);
    let answer = await ask(browser, `Which saved login on ${host} gets the new password?`, [
      ...logins.map(login => ({ label: who(login), detail: "update its password", answer: login })),
      { label: "none", detail: "keep the saved passwords as they are", answer: null },
    ]);
    if (answer) {
      await update(answer, newLogin);
      say(browser, `Updated the password for ${who(answer)} on ${host}`);
    }
  },
};

/** Called once per window that loads the mod; the last one out restores Firefox's. */
export function start() {
  if (users++ == 0) {
    LoginManagerParent.prototype._getPrompter = () => prompter;
  }
}

export function stop() {
  if (--users == 0) {
    LoginManagerParent.prototype._getPrompter = original;
  }
}
