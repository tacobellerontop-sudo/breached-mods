/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The window side of PasskeyWaitChild: asks the tab's window to unlock
// Bitwarden and answers once its passkeys are loaded (or it gave up).

const log = text => Services.console.logStringMessage("Bitwarden wait: " + text);

export class BitwardenWaitParent extends JSWindowActorParent {
  async receiveMessage(message) {
    if (message.name != "Bitwarden:WaitForPasskeys") {
      return null;
    }
    let browser = this.browsingContext.top.embedderElement;
    let win = browser?.ownerGlobal;
    // The tab's window, else any window running the mod.
    let provider = win?.breachedBitwardenPasskeys;
    if (!provider) {
      for (let other of Services.wm.getEnumerator("breached:main")) {
        provider ??= other.breachedBitwardenPasskeys;
      }
    }
    log(`parent actor: browser ${!!browser}, window ${win?.location?.href}, provider ${!!provider}`);
    if (!provider) {
      return false;
    }
    try {
      return await provider.waitForUnlock(browser, this.manager.documentPrincipal?.originNoSuffix ?? "");
    } catch (e) {
      log("failed: " + e + " " + e?.stack);
      return false;
    }
  }
}
