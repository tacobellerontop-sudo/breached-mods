/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Runs what a key pressed in the page asks for, in its Breached window.

const COMMANDS = new Set(["back", "forward", "tab-next", "tab-prev", "close", "undo", "reload"]);

export class BreachedKeysParent extends JSWindowActorParent {
  receiveMessage({ name, data }) {
    let shell = this.browsingContext.topChromeWindow?.Breached;
    if (!shell) {
      return;
    }
    if (name == "Keys:Command" && COMMANDS.has(data.command)) {
      shell.run(data.command);
    } else if (name == "Keys:CommandLine") {
      shell.openCommandLine(data.text ?? "");
    } else if (name == "Keys:OpenTab" && /^https?:/.test(data.url)) {
      shell.openTab(data.url, { background: true, afterCurrent: true, triggeringPrincipal: this.manager.documentPrincipal });
    }
  }
}
