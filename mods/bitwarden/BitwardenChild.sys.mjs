/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Fills a username and password into the login form of one frame.

const USER_TYPES = new Set(["text", "email", "tel", ""]);
const USER_HINT = /user|email|e-mail|login|account|identifier|name/i;

function visible(input) {
  return !input.disabled && !input.readOnly && input.getClientRects().length > 0;
}

export class BitwardenChild extends JSWindowActorChild {
  receiveMessage(message) {
    if (message.name == "Bitwarden:Fill") {
      return this.fill(message.data);
    }
    return undefined;
  }

  fill({ username, password }) {
    let doc = this.document;
    if (!doc) {
      return false;
    }
    let inputs = [...doc.querySelectorAll("input")].filter(visible);
    let pass = inputs.find(i => i.type == "password" && !/new-password/.test(i.autocomplete));
    let candidates = inputs.filter(i => USER_TYPES.has(i.type));
    let user;
    if (pass) {
      // The text field just before the password field.
      let before = candidates.filter(
        i => i.compareDocumentPosition(pass) & i.DOCUMENT_POSITION_FOLLOWING
      );
      user = before.at(-1);
    } else {
      // A username-only first step.
      user =
        candidates.find(i => /username|email/.test(i.autocomplete)) ??
        candidates.find(i => i.type == "email") ??
        candidates.find(i => USER_HINT.test(i.name + " " + i.id));
    }
    let filled = false;
    if (user && username) {
      user.setUserInput(username);
      filled = true;
    }
    if (pass && password) {
      pass.setUserInput(password);
      pass.focus();
      filled = true;
    }
    return filled;
  }
}
