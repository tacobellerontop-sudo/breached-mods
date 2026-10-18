/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The page's full size, for whole-page screenshots.

export class BreachedScreenshotChild extends JSWindowActorChild {
  receiveMessage({ name }) {
    if (name != "Screenshot:Size") {
      return null;
    }
    let doc = this.document;
    let el = doc.scrollingElement ?? doc.documentElement;
    return {
      width: Math.max(el.scrollWidth, this.contentWindow.innerWidth),
      height: Math.max(el.scrollHeight, this.contentWindow.innerHeight),
    };
  }
}
