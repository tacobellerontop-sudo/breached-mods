/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Fills a username and password into the login form of one frame, and
// tells the window when a page shows a login form (so the mod can offer
// the vault's logins without :bw.exe).

const { setTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");

const USER_TYPES = new Set(["text", "email", "tel", ""]);
const USER_HINT = /user|email|e-mail|login|account|identifier|name/i;

function usable(input) {
  if (input.disabled || input.readOnly) {
    return false;
  }
  // Hidden decoys (display:none, visibility:hidden, opacity 0) don't count.
  return input.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
}

/** Every input in the document, including inside open shadow roots. */
function allInputs(root, out = []) {
  for (let el of root.querySelectorAll("*")) {
    if (el.localName == "input") {
      out.push(el);
    }
    if (el.shadowRoot) {
      allInputs(el.shadowRoot, out);
    }
  }
  return out;
}

// The page's own autocomplete words (the .autocomplete property comes back
// empty for some, such as Google's "username webauthn").
const hints = i => (i.getAttribute("autocomplete") ?? "").toLowerCase();
const isPassword = i => i.type == "password" && !/new-password/.test(hints(i));
// A password field a person can see and type in: not a page's hidden
// helper field (Google's sign-in keeps one, out of sight, next to the email).
function realPassword(input) {
  if (!isPassword(input) || input.tabIndex < 0 || input.getAttribute("aria-hidden") == "true") {
    return false;
  }
  let r = input.getBoundingClientRect();
  return r.width > 2 && r.height > 2;
}

// A username field that says so (a page's other text fields could be anything).
const isLoginUser = i => USER_TYPES.has(i.type) && /username|webauthn/.test(hints(i));

/** Whether this element comes before that one in the page. */
const before = (a, b) => !!(a.compareDocumentPosition(b) & a.DOCUMENT_POSITION_FOLLOWING);

export class BitwardenChild extends JSWindowActorChild {
  receiveMessage(message) {
    if (message.name == "Bitwarden:Fill") {
      return this.fill(message.data);
    }
    if (message.name == "Bitwarden:Ping") {
      let doc = this.document;
      return {
        module: import.meta.url.replace(/^.*\//, ""),
        url: doc?.documentURI?.replace(/[?#].*/, ""),
        ready: doc?.readyState,
        fields: doc ? allInputs(doc).filter(i => i.type != "hidden").length : 0,
      };
    }
    return undefined;
  }

  handleEvent(event) {
    if (event.type == "pageshow" && event.persisted) {
      // Back on this page from the back-forward cache: offer again.
      this._told = this._toldPassword = false;
      this._fresh = true;
    }
    if (this._toldPassword) {
      return;
    }
    if (event.type == "focusin") {
      let target = event.composedTarget ?? event.target;
      if (target?.localName == "input" && usable(target)) {
        if (realPassword(target)) {
          this.tell("password");
        } else if (isLoginUser(target) && !this._told) {
          this.tell("form");
        }
      }
      return;
    }
    // DOMContentLoaded or pageshow. Some pages draw their form a bit later.
    this.check();
    for (let ms of [1000, 3000]) {
      setTimeout(() => this.check(), ms);
    }
  }

  check() {
    let doc;
    try {
      doc = this.document;
    } catch (e) {
      return; // the actor is gone
    }
    if (this._toldPassword || !doc) {
      return;
    }
    let inputs = allInputs(doc).filter(usable);
    if (inputs.some(realPassword)) {
      this.tell("password");
    } else if (!this._told && inputs.some(isLoginUser)) {
      this.tell("form");
    }
  }

  /** "form": a login form; "password": (now) with a password field, e.g. a sign-in's second step. */
  tell(kind) {
    this._told = true;
    this._toldPassword ||= kind == "password";
    try {
      this.sendAsyncMessage("Bitwarden:LoginForm", { kind, fresh: !!this._fresh });
      this._fresh = false;
    } catch (e) {
      // the page went away
    }
  }

  /** Fills; returns whether it did, and what it saw (for "no login form" messages). */
  fill(data) {
    let doc = this.document;
    let all = doc ? allInputs(doc) : [];
    let filled = doc ? this.fillIn(doc, data) : false;
    let seen = all.filter(i => i.type != "hidden").map(i => {
      let hint = i.getAttribute("autocomplete") || i.name || i.id;
      return `${i.type}${hint ? " " + hint : ""}${usable(i) ? "" : " (hidden)"}`;
    });
    return { filled, seen, url: doc?.documentURI?.replace(/[?#].*/, "") };
  }

  fillIn(doc, { username, password }) {
    let inputs = allInputs(doc).filter(usable);
    let passwords = inputs.filter(realPassword);
    let texts = inputs.filter(i => USER_TYPES.has(i.type));
    let focused = doc.activeElement;
    while (focused?.shadowRoot?.activeElement) {
      focused = focused.shadowRoot.activeElement;
    }
    let pass, user;
    if (passwords.includes(focused)) {
      pass = focused;
    } else if (texts.includes(focused)) {
      user = focused;
      pass = passwords.find(p => before(user, p)) ?? passwords[0];
    } else {
      pass = passwords[0];
    }
    if (!user && pass) {
      // The text field just before the password field, in its form if it has one.
      let earlier = texts.filter(i => before(i, pass));
      user = earlier.filter(i => i.form && i.form == pass.form).at(-1) ?? earlier.at(-1);
    }
    if (!user && !pass) {
      // A username-only first step.
      user =
        texts.find(i => /username|email/.test(hints(i))) ??
        texts.find(i => i.type == "email") ??
        texts.find(i => USER_HINT.test(i.name + " " + i.id));
    }
    let filled = false;
    if (user && username) {
      user.focus();
      user.setUserInput(username);
      filled = true;
    }
    if (pass && password) {
      pass.focus();
      pass.setUserInput(password);
      filled = true;
    }
    return filled;
  }
}
