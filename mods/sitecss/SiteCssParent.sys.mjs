/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Hands a page the rules for its site (kept in the main process's settings).

export class BreachedSiteCssParent extends JSWindowActorParent {
  receiveMessage(message) {
    if (message.name == "SiteCss:Get") {
      let sites;
      try {
        sites = JSON.parse(Services.prefs.getStringPref("breached.mods.sitecss.sites", "{}"));
      } catch (e) {
        sites = {};
      }
      return sites[message.data.host] ?? "";
    }
    return null;
  }
}
