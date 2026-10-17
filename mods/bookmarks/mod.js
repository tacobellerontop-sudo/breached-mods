/* Bookmarks mod: Firefox's bookmarks (Places), driven from the command bar.
 *
 *   :bookmark [title]   bookmark this page (again: remove it)   Ctrl+D
 *   :bookmarks [words]  pick a bookmark to open here            Ctrl+B
 *   :bookmarks -t [words]  ... in a new tab
 *   :bookmark-del       pick a bookmark to delete
 *
 * New bookmarks go to "Other bookmarks", like Firefox's unsorted ones. */

"use strict";

const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");

const Bookmarks = {
  async all() {
    let tree = await PlacesUtils.promiseBookmarksTree(PlacesUtils.bookmarks.rootGuid);
    let found = [];
    let walk = (node, path) => {
      if (node.uri && /^(https?|file|about):/.test(node.uri)) {
        found.push({ guid: node.guid, url: node.uri, title: node.title || node.uri, folder: path.join(" / "), added: node.dateAdded });
      }
      for (let child of node.children ?? []) {
        walk(child, node.guid == PlacesUtils.bookmarks.rootGuid || !node.title ? path : [...path, node.title]);
      }
    };
    walk(tree, []);
    return found.sort((a, b) => b.added - a.added);
  },

  async toggle(title) {
    let browser = Breached.selectedBrowser;
    let url = browser?.currentURI?.spec;
    if (!url || !/^(https?|file):/.test(url)) {
      throw new Error("open a website first");
    }
    let existing = [];
    await PlacesUtils.bookmarks.fetch({ url }, b => existing.push(b));
    if (existing.length && !title) {
      let answer = await Breached.pick("This page is bookmarked:", [
        { label: "remove", detail: "delete the bookmark", answer: "remove" },
        { label: "keep", detail: "leave it", answer: "keep" },
      ]);
      if (answer?.answer == "remove") {
        for (let b of existing) {
          await PlacesUtils.bookmarks.remove(b.guid);
        }
        Breached.showMessage("Bookmark removed");
      }
      return;
    }
    await PlacesUtils.bookmarks.insert({
      parentGuid: PlacesUtils.bookmarks.unfiledGuid,
      url,
      title: title || Breached.selected?.title || url,
    });
    Breached.showMessage(`Bookmarked ${title || Breached.selected?.title || url}`);
  },

  async pick(label, filter) {
    let all = await this.all();
    if (!all.length) {
      throw new Error("no bookmarks yet: Ctrl+D or :bookmark saves this page");
    }
    let words = (filter ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    let rows = all
      .filter(b => words.every(w => `${b.title} ${b.url} ${b.folder}`.toLowerCase().includes(w)))
      .map(b => ({ label: b.title, detail: b.folder ? `${b.folder} · ${b.url}` : b.url, bookmark: b }));
    if (rows.length == 1 && words.length) {
      return rows[0].bookmark;
    }
    return (await Breached.pick(label, rows))?.bookmark ?? null;
  },

  async open(filter, newTab) {
    let bookmark = await this.pick(newTab ? "open in a new tab:" : "open bookmark:", filter);
    if (!bookmark) {
      return;
    }
    Breached.run(`open ${newTab ? "-t " : ""}${bookmark.url}`);
  },

  async remove() {
    let bookmark = await this.pick("delete bookmark:");
    if (bookmark) {
      await PlacesUtils.bookmarks.remove(bookmark.guid);
      Breached.showMessage(`Deleted ${bookmark.title}`);
    }
  },
};

const fail = e => Breached.showMessage(`bookmarks: ${e.message}`, "error");

Mod.command("bookmark", {
  usage: "bookmark [title]  (bookmark this page; again removes it)",
  run(args) {
    Bookmarks.toggle((args ?? "").trim()).catch(fail);
  },
});
Mod.command("bookmarks", {
  usage: "bookmarks [-t] [words]  (open a bookmark; -t in a new tab)",
  run(args) {
    let m = (args ?? "").match(/^-t\b\s*(.*)$/);
    Bookmarks.open(m ? m[1] : args, !!m).catch(fail);
  },
});
Mod.command("bookmark-del", {
  usage: "bookmark-del  (delete a bookmark)",
  run() {
    Bookmarks.remove().catch(fail);
  },
});
Mod.key("d", "accel", () => Bookmarks.toggle("").catch(fail));
Mod.key("b", "accel", () => Bookmarks.open("", false).catch(fail));
