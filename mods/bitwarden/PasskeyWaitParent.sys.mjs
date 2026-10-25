/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The window side of PasskeyWaitChild: asks the tab's window to unlock
// Bitwarden and answers once its passkeys are loaded (or it gave up).

export class BitwardenWaitParent extends JSWindowActorParent {
  async receiveMessage(message) {
    if (message.name != "Bitwarden:WaitForPasskeys") {
      return null;
    }
    let browser = this.browsingContext.top.embedderElement;
    let provider = browser?.ownerGlobal?.breachedBitwardenPasskeys;
    let origin = this.manager.documentPrincipal?.originNoSuffix ?? "";
    if (!provider) {
      return false;
    }
    try {
      return await provider.waitForUnlock(browser, origin);
    } catch (e) {
      console.error("Bitwarden: waiting for the unlock", e);
      return false;
    }
  }
}
