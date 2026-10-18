/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Adds your rules for the site to the page, as a style sheet of their own.

export class BreachedSiteCssChild extends JSWindowActorChild {
  async handleEvent() {
    // Without the port, like the host names the mod keeps.
    let host = this.document?.location?.hostname;
    if (!host) {
      return;
    }
    let css = await this.sendQuery("SiteCss:Get", { host });
    this.apply(css);
  }

  receiveMessage(message) {
    if (message.name == "SiteCss:Apply") {
      this.apply(message.data.css);
    }
  }

  apply(css) {
    let utils = this.contentWindow?.windowUtils;
    if (!utils) {
      return;
    }
    if (this.sheet) {
      utils.removeSheetUsingURIString(this.sheet, utils.AUTHOR_SHEET);
      this.sheet = null;
    }
    if (css) {
      this.sheet = "data:text/css;charset=utf-8," + encodeURIComponent(css);
      utils.loadSheetUsingURIString(this.sheet, utils.AUTHOR_SHEET);
    }
    this.document.documentElement?.toggleAttribute("data-breached-sitecss", !!css);
  }
}
