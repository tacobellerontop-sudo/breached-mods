/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Vim-style keys and link hints in a web page.

const SCROLL = 60;
const CLICKABLE =
  "a[href], button, input:not([type=hidden]), select, textarea, summary, label[for], [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [onclick], [tabindex]:not([tabindex='-1']), [contenteditable=''], [contenteditable=true]";

// Keys that ask Breached for something.
const COMMAND_KEYS = {
  H: "back",
  L: "forward",
  J: "tab-next",
  K: "tab-prev",
  d: "close",
  u: "undo",
  r: "reload",
};

function editable(el) {
  if (!el) {
    return false;
  }
  if (el.isContentEditable) {
    return true;
  }
  let tag = el.localName;
  if (tag == "textarea" || tag == "select") {
    return true;
  }
  if (tag == "input") {
    return !["button", "submit", "reset", "checkbox", "radio", "image", "range", "color", "file"].includes(el.type);
  }
  return false;
}

/** Labels like a, s, d … then aa, as, … for n links. */
function labels(chars, n) {
  let out = [""];
  while (out.length < n || out[0] == "") {
    let next = [];
    for (let prefix of out) {
      for (let c of chars) {
        next.push(prefix + c);
      }
    }
    // Keep the shortest labels: replace one prefix with its children at a time.
    out = out[0] == "" ? [...chars] : next;
    if (out.length >= n) {
      break;
    }
  }
  return out.slice(0, n);
}

export class BreachedKeysChild extends JSWindowActorChild {
  constructor() {
    super();
    this.pending = "";
    this.hints = null;
  }

  receiveMessage({ name, data }) {
    if (name == "Keys:Hint") {
      this.showHints(data.newTab);
    }
  }

  handleEvent(event) {
    if (event.type != "keydown" || event.defaultPrevented || event.isComposing) {
      return;
    }
    if (this.hints) {
      this.hintKey(event);
      return;
    }
    if (event.ctrlKey || event.altKey || event.metaKey) {
      return;
    }
    let doc = this.document;
    let active = doc.activeElement;
    while (active?.shadowRoot?.activeElement) {
      active = active.shadowRoot.activeElement;
    }
    if (editable(active) || doc.designMode == "on") {
      if (event.key == "Escape") {
        active.blur();
      }
      return;
    }
    let key = event.key;
    let win = this.contentWindow;
    let handled = true;
    let combo = this.pending + key;
    this.pending = "";
    if (combo == "gg") {
      win.scrollTo({ top: 0 });
    } else if (key == "g") {
      this.pending = "g";
    } else if (key == "G") {
      win.scrollTo({ top: doc.documentElement.scrollHeight });
    } else if (key == "j") {
      win.scrollBy({ top: SCROLL });
    } else if (key == "k") {
      win.scrollBy({ top: -SCROLL });
    } else if (key == "h") {
      win.scrollBy({ left: -SCROLL });
    } else if (key == "l") {
      win.scrollBy({ left: SCROLL });
    } else if (key == "f" || key == "F") {
      this.showHints(key == "F");
    } else if (key == "o") {
      this.sendAsyncMessage("Keys:CommandLine", { text: "open " });
    } else if (COMMAND_KEYS[key]) {
      this.sendAsyncMessage("Keys:Command", { command: COMMAND_KEYS[key] });
    } else {
      handled = false;
    }
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  // ------------------------------------------------------------ hints

  showHints(newTab) {
    this.hideHints();
    let doc = this.document;
    let win = this.contentWindow;
    let targets = [];
    for (let el of doc.querySelectorAll(CLICKABLE)) {
      let rect = [...el.getClientRects()].find(r => r.width > 0 && r.height > 0);
      if (!rect || rect.bottom < 0 || rect.right < 0 || rect.top > win.innerHeight || rect.left > win.innerWidth) {
        continue;
      }
      let style = win.getComputedStyle(el);
      if (style.visibility != "visible" || style.opacity == "0") {
        continue;
      }
      // Skip what's covered by something else (menus, banners).
      let x = Math.min(Math.max(rect.left + 2, 0), win.innerWidth - 1);
      let y = Math.min(Math.max(rect.top + rect.height / 2, 0), win.innerHeight - 1);
      let top = doc.elementFromPoint(x, y);
      if (top && top != el && !el.contains(top) && !top.contains(el)) {
        continue;
      }
      targets.push({ el, rect });
    }
    if (!targets.length) {
      return;
    }
    let chars = Services.prefs.getStringPref("breached.mods.keys.hintChars", "asdfghjkl").replace(/(.)(?=.*\1)/g, "") || "asdfghjkl";
    let names = labels([...chars], targets.length);
    let layer = doc.createElement("div");
    layer.setAttribute("style", "all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;");
    layer.setAttribute("data-breached-hints", targets.length);
    let root = layer.attachShadow({ mode: "closed" });
    let style = doc.createElement("style");
    style.textContent =
      ".hint { position: fixed; font: bold 12px/1 Consolas, monospace; padding: 2px 3px; background: #f5d76e; color: #000; border: 1px solid #8a6d00; border-radius: 2px; text-transform: uppercase; }" +
      ".hint b { color: #a23; }";
    root.append(style);
    this.hints = { layer, newTab, typed: "", items: [] };
    targets.forEach(({ el, rect }, i) => {
      let span = doc.createElement("span");
      span.className = "hint";
      span.textContent = names[i];
      span.style.left = Math.max(0, rect.left) + "px";
      span.style.top = Math.max(0, rect.top) + "px";
      root.append(span);
      this.hints.items.push({ el, name: names[i], span });
    });
    (doc.body ?? doc.documentElement).append(layer);
    win.addEventListener("scroll", this.hideHintsOnScroll ??= () => this.hideHints(), { once: true });
  }

  hideHints() {
    if (this.hints) {
      this.hints.layer.remove();
      this.hints = null;
    }
  }

  hintKey(event) {
    event.preventDefault();
    event.stopPropagation();
    if (event.key == "Escape") {
      this.hideHints();
      return;
    }
    let h = this.hints;
    if (event.key == "Backspace") {
      h.typed = h.typed.slice(0, -1);
    } else if (event.key.length == 1) {
      h.typed += event.key.toLowerCase();
    } else {
      return;
    }
    let matches = h.items.filter(item => item.name.startsWith(h.typed));
    for (let item of h.items) {
      let on = item.name.startsWith(h.typed);
      item.span.style.display = on ? "" : "none";
      if (on) {
        item.span.textContent = "";
        let typed = this.document.createElement("b");
        typed.textContent = item.name.slice(0, h.typed.length);
        item.span.append(typed, item.name.slice(h.typed.length));
      }
    }
    if (!matches.length) {
      this.hideHints();
    } else if (matches.length == 1 && matches[0].name == h.typed) {
      let { newTab } = h;
      this.hideHints();
      this.follow(matches[0].el, newTab);
    }
  }

  follow(el, newTab) {
    if (newTab && el.localName == "a" && el.href) {
      this.sendAsyncMessage("Keys:OpenTab", { url: el.href });
      return;
    }
    if (editable(el)) {
      el.focus();
      return;
    }
    el.focus?.();
    el.click();
  }
}
