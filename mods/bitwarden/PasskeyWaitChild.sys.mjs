/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// A page that loads while Bitwarden is locked: its passkey requests wait
// for the unlock, then go on to Gecko as they were (Breached's built-in
// authenticator answers them). Without this, Gecko would answer at once
// with "not allowed" (no passkeys loaded yet) and the site would need a
// reload. Pages loaded with the vault's passkeys in get nothing.

const READY = "breached.bitwarden.passkeysReady";

const wrapped = new WeakSet(); // documents done

export class BitwardenWaitChild extends JSWindowActorChild {
  handleEvent(event) {
    if (event.type != "DOMDocElementInserted" && event.type != "DOMWindowCreated") {
      return;
    }
    if (Services.cpmm.sharedData.get(READY) !== false) {
      // Loaded (or Bitwarden isn't answering passkeys): leave the page alone.
      return;
    }
    let win = this.contentWindow;
    let principal = this.document?.nodePrincipal;
    let doc = this.document;
    if (!win?.isSecureContext || !principal?.isContentPrincipal || !/^https?$/.test(principal.scheme) || wrapped.has(doc)) {
      return;
    }
    wrapped.add(doc);
    let container = win.navigator.credentials;
    if (!container) {
      return;
    }
    let proto = win.CredentialsContainer.prototype;
    let nativeGet = proto.get;
    let nativeCreate = proto.create;
    let get = options => wait(options, nativeGet);
    let create = options => wait(options, nativeCreate);
    function wait(options, native) {
      let call = () => native.call(container, options);
      let page = options == null ? null : Cu.waiveXrays(options);
      let passkey = false;
      try {
        // A login box offering passkeys (conditional) waits in Gecko by itself.
        passkey = !!page?.publicKey && page.mediation != "conditional";
      } catch (e) {
        // a getter that throws: Gecko reports it
      }
      if (!passkey || Services.cpmm.sharedData.get(READY) !== false) {
        return call();
      }
      return new win.Promise(
        Cu.exportFunction((resolve, reject) => {
          let go = () => {
            try {
              resolve(call());
            } catch (e) {
              reject(e);
            }
          };
          // This document's actor (the one that wrapped may belong to the
          // blank page the frame started with).
          let actor;
          try {
            actor = win.windowGlobalChild.getActor("BitwardenWait");
          } catch (e) {
            go();
            return;
          }
          actor.sendQuery("Bitwarden:WaitForPasskeys", {}).then(go, go);
        }, win)
      );
    }
    for (let target of [container, proto]) {
      Cu.exportFunction(get, target, { defineAs: "get" });
      Cu.exportFunction(create, target, { defineAs: "create" });
    }
  }
}
