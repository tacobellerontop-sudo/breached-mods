/* Translate mod: Firefox's offline page translation.
 *
 *   :translate        translates the page into your language
 *   :translate de     into another language (a language code)
 *   :translate off    puts the original back
 *
 * The translation runs on this computer; each language's model downloads
 * from Mozilla the first time. Pages in other languages get a question in
 * the command bar (a setting). */

"use strict";

const ENABLE = "browser.translations.enable";
const TO = "breached.mods.translate.to";
const OFFER = "breached.mods.translate.offer";

const defaults = Services.prefs.getDefaultBranch("");
defaults.setStringPref(TO, "");
defaults.setBoolPref(OFFER, true);
// Breached turns translation off; the mod turns it on on the default branch,
// so removing the mod (or a restart without it) turns it off again.
defaults.setBoolPref(ENABLE, true);
// Firefox's own default (its translation panel opens by itself); here it
// lets Breached ask.
defaults.setBoolPref("browser.translations.automaticallyPopup", true);
Mod.onUninstall(() => defaults.setBoolPref(ENABLE, false));

const { TranslationsParent } = ChromeUtils.importESModule("resource://gre/actors/TranslationsParent.sys.mjs");

const names = new Intl.DisplayNames(undefined, { type: "language" });
function languageName(tag) {
  try {
    return names.of(tag);
  } catch (e) {
    return tag;
  }
}

function actorFor(browser) {
  if (!browser?.currentURI?.schemeIs("http") && !browser?.currentURI?.schemeIs("https") && !browser?.currentURI?.schemeIs("file")) {
    throw new Error("only web pages can be translated");
  }
  return TranslationsParent.getTranslationsActor(browser);
}

async function translate(browser, to) {
  let actor = actorFor(browser);
  let tags = await actor.getLangTags();
  let from = tags?.docLangTag;
  if (!from) {
    throw new Error("couldn't tell which language this page is in");
  }
  to ||= Services.prefs.getStringPref(TO, "") || tags.userLangTag || Services.locale.appLocaleAsBCP47.split("-")[0];
  if (from.split("-")[0] == to.split("-")[0]) {
    throw new Error(`this page is already in ${languageName(to)}`);
  }
  Breached.showMessage(`Translating from ${languageName(from)} into ${languageName(to)}…`);
  await actor.translate({ sourceLanguage: from, targetLanguage: to }, false);
}

Mod.command("translate", {
  usage: "translate [language code | off]  (translate the page; off puts the original back)",
  async run(args = "") {
    args = args.trim();
    let browser = Breached.selectedBrowser;
    if (args == "off") {
      actorFor(browser).restorePage();
      return;
    }
    await translate(browser, args);
  },
});

// Firefox offers from its own front end, which Breached doesn't have, so
// Breached checks each page it finishes loading in the tab you're on.
const asked = new Set();
async function maybeOffer(browser) {
  if (!Services.prefs.getBoolPref(OFFER, true) || browser !== Breached.selectedBrowser) {
    return;
  }
  let actor;
  try {
    actor = actorFor(browser);
  } catch (e) {
    return;
  }
  let tags = await actor.getLangTags();
  let from = tags?.docLangTag;
  let host = browser.currentURI?.host;
  if (!from || !tags.isDocLangTagSupported || !host || asked.has(host) || actor.languageState?.requestedLanguagePair) {
    return;
  }
  let to = Services.prefs.getStringPref(TO, "") || tags.userLangTag;
  if (!to || from.split("-")[0] == to.split("-")[0] || TranslationsParent.shouldNeverTranslateLanguage(from)) {
    return;
  }
  // Once per site each time Breached runs, like Firefox.
  asked.add(host);
  let name = languageName(from);
  let item = await Breached.pickForTab(browser, `This page is in ${name}. Translate it?`, [
    { label: "yes", detail: `into ${languageName(to)}, on this computer`, answer: "yes" },
    { label: "no", detail: "not now", answer: "no" },
    { label: "never", detail: `don't ask for ${name}`, answer: "never" },
  ]);
  if (item?.answer == "yes") {
    await translate(browser, to);
  } else if (item?.answer == "never") {
    TranslationsParent.addLangTagToPref(from, "browser.translations.neverTranslateLanguages");
  }
}

const progress = {
  onLocationChange(browser, webProgress, request, location, flags) {
    // Keeps Firefox's translation state in step with the page.
    if (webProgress.isTopLevel) {
      TranslationsParent.onLocationChange(window, location, webProgress, flags);
    }
  },
  onStateChange(browser, webProgress, request, flags) {
    let { STATE_STOP, STATE_IS_WINDOW } = Ci.nsIWebProgressListener;
    if (webProgress.isTopLevel && flags & STATE_STOP && flags & STATE_IS_WINDOW) {
      maybeOffer(browser).catch(e => Breached.showMessage(`Translation: ${e.message}`, "error"));
    }
  },
};
Breached.tabsProgressListeners.add(progress);
Mod.onUnload(() => Breached.tabsProgressListeners.delete(progress));
