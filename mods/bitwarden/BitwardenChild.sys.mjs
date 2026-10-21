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

const isPassword = i => i.type == "password" && !/new-password/.test(i.autocomplete);
// A username field that says so (a page's other text fields could be anything).
const isLoginUser = i => USER_TYPES.has(i.type) && /username|webauthn/.test(i.autocomplete);

/** Whether this element comes before that one in the page. */
const before = (a, b) => !!(a.compareDocumentPosition(b) & a.DOCUMENT_POSITION_FOLLOWING);

export class BitwardenChild extends JSWindowActorChild {
  receiveMessage(message) {
    if (message.name == "Bitwarden:Fill") {
      return this.fill(message.data);
    }
    return undefined;
  }

  handleEvent(event) {
    if (this._told) {
      return;
    }
    if (event.type == "focusin") {
      let target = event.composedTarget ?? event.target;
      if (target?.localName == "input" && (isPassword(target) || isLoginUser(target))) {
        this.tell();
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
    if (this._told || !doc) {
      return;
    }
    let inputs = allInputs(doc).filter(usable);
    if (inputs.some(isPassword) || inputs.some(isLoginUser)) {
      this.tell();
    }
  }

  tell() {
    this._told = true;
    try {
      this.sendAsyncMessage("Bitwarden:LoginForm", {});
    } catch (e) {
      // the page went away
    }
  }

  fill({ username, password }) {
    let doc = this.document;
    if (!doc) {
      return false;
    }
    let inputs = allInputs(doc).filter(usable);
    let passwords = inputs.filter(isPassword);
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
        texts.find(i => /username|email/.test(i.autocomplete)) ??
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
