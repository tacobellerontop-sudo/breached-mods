/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Darkens a light page that has no dark look of its own: the whole page is
// inverted, then photos, videos and the like are inverted back.

const SHEET =
  "data:text/css," +
  encodeURIComponent(`
html { filter: invert(0.9) hue-rotate(180deg) !important; background: #fff !important; }
img, video, picture, canvas, iframe, embed, object, svg image,
[style*="background-image"] { filter: invert(1) hue-rotate(180deg) !important; }
`);

function brightness(color) {
  let m = color.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/);
  if (!m) {
    return null;
  }
  if (m[4] !== undefined && parseFloat(m[4]) < 0.1) {
    return null; // transparent
  }
  return (0.299 * m[1] + 0.587 * m[2] + 0.114 * m[3]) / 255;
}

export class BreachedDarkChild extends JSWindowActorChild {
  handleEvent() {
    let doc = this.document;
    let win = this.contentWindow;
    if (!doc?.documentElement || doc.contentType == "application/pdf" || !doc.documentElement.namespaceURI?.includes("xhtml")) {
      return;
    }
    let host = doc.location?.host ?? "";
    let off = Services.prefs.getStringPref("breached.mods.dark.offSites", "").split(" ").includes(host);
    let darken = !off && Services.prefs.getStringPref("breached.mods.dark.mode", "all") == "all" && this.isLight();
    let utils = win.windowUtils;
    let uri = Services.io.newURI(SHEET);
    if (darken && !this.applied) {
      utils.loadSheet(uri, utils.AUTHOR_SHEET);
      this.applied = true;
    } else if (!darken && this.applied) {
      utils.removeSheet(uri, utils.AUTHOR_SHEET);
      this.applied = false;
    }
    doc.documentElement.toggleAttribute("data-breached-dark", !!this.applied);
  }

  /** Whether the page shows light (its own colours, before any darkening). */
  isLight() {
    let win = this.contentWindow;
    let doc = this.document;
    if (this.applied) {
      return true;
    }
    for (let el of [doc.body, doc.documentElement]) {
      if (!el) {
        continue;
      }
      let b = brightness(win.getComputedStyle(el).backgroundColor);
      if (b !== null) {
        return b > 0.6;
      }
    }
    // No background colour set anywhere: the canvas colour shows, which is
    // dark when the site follows prefers-color-scheme with color-scheme.
    let scheme = win.getComputedStyle(doc.documentElement).colorScheme;
    return !/dark/.test(scheme);
  }
}
