/* Vim keys and link hints mod. The keys are read in the page (KeysChild),
 * so they work wherever the page has focus, and never while typing.
 *
 *   :hint      show link hints (same as f on a page)
 *   :hint -t   hints that open in a new tab (same as F)
 */

"use strict";

Services.prefs.getDefaultBranch("").setStringPref("breached.mods.keys.hintChars", "asdfghjkl");

const KEYS = Mod.actor("BreachedKeys", {
  parent: "KeysParent.sys.mjs",
  child: "KeysChild.sys.mjs",
  events: { keydown: { capture: true, mozSystemGroup: false } },
  allFrames: false,
});

Mod.command("hint", {
  usage: "hint [-t]  (letters on links to follow from the keyboard; -t opens in a new tab)",
  run(args) {
    let actor = Mod.getActor(KEYS);
    if (!actor) {
      throw new Error("open a web page first");
    }
    actor.sendAsyncMessage("Keys:Hint", { newTab: args.trim() == "-t" });
  },
});
