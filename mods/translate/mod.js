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

// Firefox looks at each page's language when its address changes (that
// starts the page's translation helper, which offers to translate).
const progress = {
  onLocationChange(browser, webProgress, request, location, flags) {
    if (webProgress.isTopLevel) {
      TranslationsParent.onLocationChange(window, location, webProgress, flags);
    }
  },
};
Breached.tabsProgressListeners.add(progress);
Mod.onUnload(() => Breached.tabsProgressListeners.delete(progress));

// Firefox opens its translation panel on this; Breached asks in the command bar.
function onOffer(event) {
  let browser = event.target;
  if (!Services.prefs.getBoolPref(OFFER, true) || !Breached.tabs.some(t => t.browser === browser)) {
    return;
  }
  let actor;
  try {
    actor = actorFor(browser);
  } catch (e) {
    return;
  }
  actor.getLangTags().then(async tags => {
    if (!tags?.docLangTag) {
      return;
    }
    let from = languageName(tags.docLangTag);
    let item = await Breached.pickForTab(browser, `This page is in ${from}. Translate it?`, [
      { label: "yes", detail: "translate it on this computer", answer: "yes" },
      { label: "no", detail: "not now", answer: "no" },
      { label: "never", detail: `don't ask for ${from}`, answer: "never" },
    ]);
    if (item?.answer == "yes") {
      await translate(browser, "");
    } else if (item?.answer == "never") {
      TranslationsParent.addLangTagToPref(tags.docLangTag, "browser.translations.neverTranslateLanguages");
    }
  }).catch(e => Breached.showMessage(`Translation: ${e.message}`, "error"));
}
window.addEventListener("TranslationsParent:OfferTranslation", onOffer);
Mod.onUnload(() => window.removeEventListener("TranslationsParent:OfferTranslation", onOffer));
