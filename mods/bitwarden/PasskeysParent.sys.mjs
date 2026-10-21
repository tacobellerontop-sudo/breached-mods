/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Hands a page's passkey requests to the Bitwarden mod in its window
// (Passkeys in mod.js). No answer means "let Gecko handle it".

// Shows in the browser console (and the self-test's report).
export function log(text) {
  Services.console.logStringMessage("Breached passkeys: " + text);
}

// The Bitwarden mod's passkey handler (Passkeys in mod.js) of each browser
// window, set while the mod is loaded there. This module is the mod's own,
// so mod.js and the actor share it.
const handlers = new Map(); // window -> handler
export function setHandler(win, h) {
  if (h) {
    handlers.set(win, h);
  } else {
    handlers.delete(win);
  }
}

export class BitwardenPasskeysParent extends JSWindowActorParent {
  receiveMessage(message) {
    if (message.name == "Passkey:Error") {
      log("page side: " + message.data.message);
      if (message.data.show) {
        this.browsingContext.topChromeWindow?.Breached?.showMessage(
          `Bitwarden couldn't read this page's passkey request, so Windows gets it (${message.data.message})`,
          "error"
        );
      }
      return null;
    }
    let browser = this.browsingContext.top.embedderElement;
    let passkeys = handlers.get(this.browsingContext.topChromeWindow) ?? handlers.values().next().value;
    if (!passkeys) {
      log(`${message.name} with the Bitwarden mod not loaded`);
      return null;
    }
    this._passkeys = passkeys;
    let topPrincipal = this.browsingContext.top.currentWindowGlobal?.documentPrincipal;
    let request = {
      ...message.data,
      topOrigin: topPrincipal?.originNoSuffix ?? message.data.origin,
    };
    request.crossOrigin = request.framed && request.topOrigin != request.origin;
    log(`${message.name} from ${request.origin}`);
    let failed = e => {
      log(`${message.name} failed: ${e}\n${e?.stack ?? ""}`);
      return null;
    };
    switch (message.name) {
      case "Passkey:get":
        return passkeys.get(this, browser, request).catch(failed);
      case "Passkey:create":
        return passkeys.create(this, browser, request).catch(failed);
      case "Passkey:Abort":
        passkeys.abort(this, request.id);
        return null;
    }
    return null;
  }

  didDestroy() {
    // The page went away: drop its waiting request, if any.
    this._passkeys?.forget(this);
  }
}
