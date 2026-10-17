/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Lets Bitwarden answer a page's passkey requests. Before the page's own
// scripts run, navigator.credentials.get() and .create() are wrapped: a
// passkey request goes to the browser window first (mod.js), which signs
// in with a passkey from the vault, saves a new one there, or hands the
// request back to Gecko for Windows Hello or a security key.
//
// Everything crossing to the window is plain data, binary as base64url.

const enc = data => ChromeUtils.base64URLEncode(data, { pad: false });
const dec = text => ChromeUtils.base64URLDecode(text, { padding: "ignore" });

/** A BufferSource from the page, as base64url (null if missing). */
function b64(source) {
  if (source == null) {
    return null;
  }
  return enc(source);
}

/** A sequence from the page (through Xray wrappers) as a plain array. */
function listOf(sequence) {
  let out = [];
  for (let i = 0; i < (sequence?.length ?? 0); i++) {
    out.push(sequence[i]);
  }
  return out;
}

function originOf(principal) {
  return principal.originNoSuffix;
}

export class BitwardenPasskeysChild extends JSWindowActorChild {
  handleEvent(event) {
    if (event.type != "DOMDocElementInserted") {
      return;
    }
    if (Services.prefs.getStringPref("breached.mods.bitwarden.passkeys", "ask") == "off") {
      return;
    }
    let win = this.contentWindow;
    if (!win?.isSecureContext || !/^https?:$/.test(win.location.protocol)) {
      return;
    }
    let container = win.navigator.credentials;
    if (!container) {
      return;
    }
    let proto = win.CredentialsContainer.prototype;
    let nativeGet = proto.get;
    let nativeCreate = proto.create;
    Cu.exportFunction(options => this.ask(win, "get", options, () => nativeGet.call(container, options)), container, {
      defineAs: "get",
    });
    Cu.exportFunction(
      options => this.ask(win, "create", options, () => nativeCreate.call(container, options)),
      container,
      { defineAs: "create" }
    );
  }

  /** Answers get() or create(); native() hands it back to Gecko. */
  ask(win, kind, options, native) {
    let publicKey = options?.publicKey;
    if (!publicKey) {
      return native();
    }
    let request;
    try {
      request = kind == "get" ? this.readGet(win, options) : this.readCreate(win, options);
    } catch (e) {
      // Something we don't understand: Gecko checks it and says what's wrong.
      this.sendAsyncMessage("Passkey:Error", { message: `reading the ${kind} request: ${e}` });
      return native();
    }
    let signal = options.signal;
    return new win.Promise(
      Cu.exportFunction((resolve, reject) => {
        let fail = (name, message) => reject(new win.DOMException(message, name));
        if (signal?.aborted) {
          fail("AbortError", "The operation was aborted.");
          return;
        }
        let id = Math.random().toString(36).slice(2);
        let onAbort = () => {
          this.sendAsyncMessage("Passkey:Abort", { id });
          fail("AbortError", "The operation was aborted.");
        };
        signal?.addEventListener("abort", onAbort);
        this.sendQuery("Passkey:" + kind, { id, ...request }).then(
          answer => {
            signal?.removeEventListener("abort", onAbort);
            if (signal?.aborted) {
              return;
            }
            if (answer?.credential) {
              resolve(this.credentialFor(win, kind, answer.credential, request));
            } else if (answer?.error) {
              fail(answer.error, answer.message ?? "The request was not allowed.");
            } else {
              this.sendAsyncMessage("Passkey:Error", { message: `no answer for ${kind}, handing it to Gecko` });
              resolve(native());
            }
          },
          e => {
            this.sendAsyncMessage("Passkey:Error", { message: `asking the window: ${e}` });
            resolve(native());
          }
        );
      }, win)
    );
  }

  frameInfo() {
    // The window side adds the top page's origin, which it can always see.
    let principal = this.document.nodePrincipal;
    return { origin: originOf(principal), host: principal.host, framed: !!this.browsingContext.parent };
  }

  readGet(win, options) {
    let pk = options.publicKey;
    return {
      ...this.frameInfo(),
      mediation: String(options.mediation ?? "optional"),
      rpId: pk.rpId != null ? String(pk.rpId) : null,
      challenge: b64(pk.challenge),
      allowCredentials: listOf(pk.allowCredentials).map(c => b64(c.id)),
      userVerification: String(pk.userVerification ?? "preferred"),
    };
  }

  readCreate(win, options) {
    let pk = options.publicKey;
    return {
      ...this.frameInfo(),
      rp: { id: pk.rp?.id != null ? String(pk.rp.id) : null, name: String(pk.rp?.name ?? "") },
      user: {
        id: b64(pk.user.id),
        name: String(pk.user.name ?? ""),
        displayName: String(pk.user.displayName ?? ""),
      },
      challenge: b64(pk.challenge),
      algorithms: listOf(pk.pubKeyCredParams).map(p => Number(p.alg)),
      excludeCredentials: listOf(pk.excludeCredentials).map(c => b64(c.id)),
      residentKey: String(pk.authenticatorSelection?.residentKey ?? ""),
      credProps: !!pk.extensions?.credProps,
    };
  }

  /** Builds the PublicKeyCredential the page gets back. */
  credentialFor(win, kind, c, request) {
    let buffer = text => Cu.cloneInto(dec(text), win);
    let response;
    if (kind == "get") {
      response = Cu.cloneInto(
        {
          clientDataJSON: buffer(c.clientDataJSON),
          authenticatorData: buffer(c.authenticatorData),
          signature: buffer(c.signature),
          userHandle: c.userHandle ? buffer(c.userHandle) : null,
        },
        win
      );
      Object.setPrototypeOf(Cu.waiveXrays(response), Cu.waiveXrays(win.AuthenticatorAssertionResponse.prototype));
    } else {
      response = Cu.cloneInto(
        { clientDataJSON: buffer(c.clientDataJSON), attestationObject: buffer(c.attestationObject) },
        win
      );
      let methods = {
        getTransports: () => Cu.cloneInto(["internal", "hybrid"], win),
        getAuthenticatorData: () => buffer(c.authenticatorData),
        getPublicKey: () => buffer(c.publicKey),
        getPublicKeyAlgorithm: () => -7,
      };
      for (let [name, fn] of Object.entries(methods)) {
        Cu.exportFunction(fn, response, { defineAs: name });
      }
      Object.setPrototypeOf(Cu.waiveXrays(response), Cu.waiveXrays(win.AuthenticatorAttestationResponse.prototype));
    }
    let credential = Cu.cloneInto(
      { id: c.id, rawId: buffer(c.id), type: "public-key", authenticatorAttachment: "platform" },
      win
    );
    Cu.waiveXrays(credential).response = response;
    let extensions = kind == "create" && request.credProps ? { credProps: { rk: true } } : {};
    Cu.exportFunction(() => Cu.cloneInto(extensions, win), credential, { defineAs: "getClientExtensionResults" });
    Cu.exportFunction(
      () => {
        let json = { id: c.id, rawId: c.id, type: "public-key", authenticatorAttachment: "platform", clientExtensionResults: extensions };
        json.response =
          kind == "get"
            ? {
                clientDataJSON: c.clientDataJSON,
                authenticatorData: c.authenticatorData,
                signature: c.signature,
                userHandle: c.userHandle ?? null,
              }
            : {
                clientDataJSON: c.clientDataJSON,
                attestationObject: c.attestationObject,
                authenticatorData: c.authenticatorData,
                publicKey: c.publicKey,
                publicKeyAlgorithm: -7,
                transports: ["internal", "hybrid"],
              };
        return Cu.cloneInto(json, win);
      },
      credential,
      { defineAs: "toJSON" }
    );
    Object.setPrototypeOf(Cu.waiveXrays(credential), Cu.waiveXrays(win.PublicKeyCredential.prototype));
    return credential;
  }
}
