/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Passes "this page shows a login form" on to the Bitwarden mod in the
// page's window (Bitwarden.offer in mod.js).

const handlers = new Map(); // window -> Bitwarden
export function setHandler(win, h) {
  if (h) {
    handlers.set(win, h);
  } else {
    handlers.delete(win);
  }
}

export class BitwardenParent extends JSWindowActorParent {
  receiveMessage(message) {
    if (message.name == "Bitwarden:LoginForm") {
      let browser = this.browsingContext.top.embedderElement;
      handlers.get(this.browsingContext.topChromeWindow)?.offer(browser, message.data.kind == "password" ? "password" : "form");
    }
    return null;
  }
}
