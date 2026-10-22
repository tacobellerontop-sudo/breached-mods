/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Bitwarden logins through Gecko's own password manager. Gecko already finds
// login forms in pages, fills them when they load and offers logins in a
// dropdown when you click a login box; it asks Services.logins for the
// site's logins. This adds the unlocked vault's logins to those answers, in
// memory only: nothing is written to Gecko's login store, and saving new
// passwords there stays off (signon.storeSignons) unless the Passwords mod
// is installed.

const GUID = "{bitwarden-";

/** Gecko's login manager, the JavaScript object behind Services.logins. */
function manager() {
  return Services.logins.QueryInterface(Ci.nsIInterfaceRequestor).getInterface(Ci.nsIVariant);
}

function loginInfo(origin, login) {
  let info = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(Ci.nsILoginInfo);
  info.init(origin, origin, null, login.username ?? "", login.password ?? "", "", "");
  info.QueryInterface(Ci.nsILoginMetaInfo).guid = GUID + login.id + "}";
  return info;
}

async function search(matchData) {
  let lm = manager();
  let found = await lm._breachedSearch.call(this, matchData);
  let provider = lm._breachedBitwarden;
  if (!provider) {
    return found;
  }
  try {
    let origin = matchData?.origin;
    if (typeof matchData?.guid == "string" && matchData.guid.startsWith(GUID)) {
      let id = matchData.guid.slice(GUID.length, -1);
      let login = provider.loginById(id, origin);
      return login ? [loginInfo(login.origin, login)] : found;
    }
    if (origin && !matchData.httpRealm && /^https?:/.test(origin)) {
      let ours = provider.loginsFor(origin).map(l => loginInfo(origin, l));
      return [...found, ...ours];
    }
  } catch (e) {
    console.error("Bitwarden: logins for Gecko's password manager", e);
  }
  return found;
}

/** The window's provider: { loginsFor(origin) -> [{id, username, password}], loginById(id, origin) }. */
export function start(provider) {
  let lm = manager();
  if (!lm._breachedSearch) {
    lm._breachedSearch = lm.searchLoginsAsync;
    lm.searchLoginsAsync = search;
  }
  lm._breachedBitwarden = provider;
}

export function provider() {
  return manager()._breachedBitwarden ?? null;
}

export function handOver(provider) {
  manager()._breachedBitwarden = provider;
}

export function stop() {
  let lm = manager();
  lm._breachedBitwarden = null;
  if (lm._breachedSearch) {
    lm.searchLoginsAsync = lm._breachedSearch;
    delete lm._breachedSearch;
  }
}
