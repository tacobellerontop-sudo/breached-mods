/* Custom CSS per site mod.
 *
 *   :css            puts this site's rules in the command bar to edit
 *   :css <rules>    sets this site's rules, like :css .banner { display: none }
 *   :css off        removes them
 *   :css list       the sites with rules (picking one opens it)
 *
 * Rules are kept per host name in breached.mods.sitecss.sites (JSON) and go
 * into the site's pages as a style sheet of their own, after the site's. */

"use strict";

const SITES = "breached.mods.sitecss.sites";

function sites() {
  try {
    return JSON.parse(Services.prefs.getStringPref(SITES, "{}"));
  } catch (e) {
    return {};
  }
}

const SITE_CSS = Mod.actor("BreachedSiteCss", {
  parent: "SiteCssParent.sys.mjs",
  child: "SiteCssChild.sys.mjs",
  events: { DOMDocElementInserted: {}, DOMContentLoaded: {} },
  allFrames: true,
  matches: ["http://*/*", "https://*/*"],
});

function host() {
  let uri = Breached.selectedBrowser?.currentURI;
  if (!uri?.schemeIs("http") && !uri?.schemeIs("https")) {
    throw new Error("open a website first");
  }
  return uri.host;
}

/** Applies a host's rules to every open page of it, at once. */
function applyEverywhere(name) {
  let css = sites()[name] ?? "";
  for (let tab of Breached.tabs) {
    let contexts = tab.browser?.browsingContext?.getAllBrowsingContextsInSubtree() ?? [];
    for (let bc of contexts) {
      if (bc.currentWindowGlobal?.documentURI?.host == name) {
        bc.currentWindowGlobal.getActor(SITE_CSS).sendAsyncMessage("SiteCss:Apply", { css });
      }
    }
  }
}

function save(name, css) {
  let all = sites();
  if (css) {
    all[name] = css;
  } else {
    delete all[name];
  }
  Services.prefs.setStringPref(SITES, JSON.stringify(all));
  applyEverywhere(name);
}

Mod.command("css", {
  usage: "css [rules | off | list]  (your own style rules for this site)",
  async run(args = "") {
    args = args.trim();
    if (args == "list") {
      let items = Object.entries(sites()).map(([name, css]) => ({ label: name, detail: css }));
      if (!items.length) {
        Breached.showMessage("No sites have rules yet. Open one and type :css");
        return;
      }
      let item = await Breached.pick("Sites with your own CSS:", items);
      if (item) {
        Breached.selectTab(Breached.openTab("https://" + item.label));
      }
      return;
    }
    let name = host();
    if (!args) {
      // Edit in place: the rules come back through ":css <rules>".
      Breached.openCommandLine("css " + (sites()[name] ?? ""));
      return;
    }
    if (args == "off") {
      save(name, "");
      Breached.showMessage(`Removed your CSS for ${name}`);
      return;
    }
    save(name, args);
    Breached.showMessage(`Your CSS applies to ${name}`);
  },
});

Mod.hook("sitecss", { save, sites });
