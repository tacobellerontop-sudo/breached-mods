/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Firefox Sync for Breached: Gecko's own Mozilla account (FxAccounts) and
// Sync (Weave) code, switched on with the settings Firefox ships in its
// front end (firefox.js), which Breached leaves out. Only the engines that
// work without Firefox's own windows are on: history, bookmarks, passwords.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  EnsureFxAccountsWebChannel: "resource://gre/modules/FxAccountsWebChannel.sys.mjs",
  FxAccountsConfig: "resource://gre/modules/FxAccountsConfig.sys.mjs",
  getFxAccountsSingleton: "resource://gre/modules/FxAccounts.sys.mjs",
});
ChromeUtils.defineLazyGetter(lazy, "fxAccounts", () => lazy.getFxAccountsSingleton());
ChromeUtils.defineLazyGetter(lazy, "WeaveService", () =>
  Cc["@mozilla.org/weave/service;1"].getService().wrappedJSObject
);

export const ENGINES_PREF = "breached.mods.sync.engines";
const DEFAULT_ENGINES = "Bookmarks,History,Passwords";

// Firefox's values (browser/app/profile/firefox.js).
const FIREFOX_PREFS = {
  "identity.fxaccounts.enabled": true,
  "identity.fxaccounts.remote.root": "https://accounts.firefox.com/",
  "identity.fxaccounts.contextParam": "oauth_webchannel_v1",
  "identity.fxaccounts.remote.profile.uri": "https://profile.accounts.firefox.com/v1",
  "identity.fxaccounts.remote.oauth.uri": "https://oauth.accounts.firefox.com/v1",
  "identity.fxaccounts.remote.pairing.uri": "wss://channelserver.services.mozilla.com",
  "identity.fxaccounts.pairing.enabled": false,
  "identity.fxaccounts.commands.remoteTabManagement.enabled": false,
  "identity.sync.tokenserver.uri": "https://token.services.mozilla.com/1.0/sync/1.5",
  // Tabs, add-ons, settings and form-fill engines need Firefox's front end.
  "services.sync.engine.tabs": false,
  "services.sync.engine.addons": false,
  "services.sync.engine.prefs": false,
  "services.sync.engine.addresses.available": false,
  "services.sync.engine.creditcards.available": false,
};

function setDefault(name, value) {
  let branch = Services.prefs.getDefaultBranch("");
  switch (typeof value) {
    case "boolean":
      branch.setBoolPref(name, value);
      break;
    case "number":
      branch.setIntPref(name, value);
      break;
    default:
      branch.setStringPref(name, value);
  }
}

let started = false;

/** Turns the account and Sync code on for this session (every window calls it). */
export function start() {
  if (started) {
    return;
  }
  started = true;
  for (let [name, value] of Object.entries(FIREFOX_PREFS)) {
    setDefault(name, value);
  }
  setDefault(ENGINES_PREF, DEFAULT_ENGINES);
  let engines = Services.prefs.getStringPref(ENGINES_PREF, DEFAULT_ENGINES);
  setDefault("services.sync.registerEngines", /^[A-Za-z,]+$/.test(engines) ? engines : DEFAULT_ENGINES);
  // The sign-in pages talk to Gecko through this channel.
  lazy.EnsureFxAccountsWebChannel();
  // Like Firefox: Sync loads a few seconds after startup, only when signed in.
  lazy.WeaveService.init();
  if (lazy.WeaveService.enabled) {
    lazy.WeaveService.whenLoaded().then(() => lazy.WeaveService.Weave.Service.scheduler.autoConnect());
  }
}

/** The mod was removed: sign out and switch the account code off again. */
export async function stop() {
  try {
    if (await lazy.fxAccounts.getSignedInUser()) {
      await lazy.fxAccounts.signOut();
    }
  } catch (e) {
    console.error("Breached Sync: signing out", e);
  }
  setDefault("identity.fxaccounts.enabled", false);
  started = false;
}

export async function user() {
  return lazy.fxAccounts.getSignedInUser();
}

export function signInURL() {
  return lazy.FxAccountsConfig.promiseConnectAccountURI("sync", "breached-command");
}

export function manageURL() {
  return lazy.FxAccountsConfig.promiseManageURI("breached-command");
}

export async function signOut() {
  await lazy.fxAccounts.signOut();
}

export async function syncNow() {
  await lazy.WeaveService.whenLoaded();
  return lazy.WeaveService.Weave.Service.sync({ why: "user" });
}

export function lastSync() {
  let when = Services.prefs.getStringPref("services.sync.lastSync", "");
  return when ? new Date(when) : null;
}

/** What the self-test checks: the pieces load and the sign-in channel listens. */
export async function selfCheck() {
  return {
    accountsEnabled: Services.prefs.getBoolPref("identity.fxaccounts.enabled", false),
    engines: Services.prefs.getStringPref("services.sync.registerEngines", ""),
    signInURL: await signInURL(),
    signedIn: !!(await user()),
  };
}
