/* Screenshots mod.
 *
 *   :screenshot      the part of the page you can see, saved to Downloads
 *   :screenshot -f   the whole page
 *   :screenshot -c   copy it instead of saving (with -f too)
 *   Ctrl+Shift+S     same as :screenshot
 */

"use strict";

const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");

// Gecko can't draw pictures much bigger than this.
const MAX_SIDE = 16384;

const SIZE = Mod.actor("BreachedScreenshot", {
  parent: "ScreenshotParent.sys.mjs",
  child: "ScreenshotChild.sys.mjs",
  allFrames: false,
  matches: ["http://*/*", "https://*/*", "file:///*"],
});

function fileName(browser) {
  let host = browser.currentURI?.host || "page";
  let d = new Date();
  let pad = n => String(n).padStart(2, "0");
  let stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
  return `${host.replace(/[^\w.-]/g, "_")} ${stamp}.png`;
}

async function take({ full = false, copy = false } = {}) {
  let browser = Breached.selectedBrowser;
  let global = browser?.browsingContext?.currentWindowGlobal;
  if (!global) {
    throw new Error("open a page first");
  }
  let rect = null;
  let scale = 1;
  if (full) {
    let size = await Mod.getActor(SIZE)?.sendQuery("Screenshot:Size");
    if (!size) {
      throw new Error("can't take the whole page here; :screenshot takes what you can see");
    }
    scale = Math.min(1, MAX_SIDE / size.height, MAX_SIDE / size.width) * (window.devicePixelRatio || 1);
    rect = new DOMRect(0, 0, size.width, size.height);
  } else {
    scale = window.devicePixelRatio || 1;
  }
  let bitmap = await global.drawSnapshot(rect, scale, "white");
  let canvas = document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  bitmap.close();
  if (copy) {
    let image = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
    let blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
    let bytes = new Uint8Array(await blob.arrayBuffer());
    let container = Cc["@mozilla.org/image/tools;1"].getService(Ci.imgITools).decodeImageFromArrayBuffer(bytes.buffer, "image/png");
    let transferable = Cc["@mozilla.org/widget/transferable;1"].createInstance(Ci.nsITransferable);
    transferable.init(null);
    transferable.addDataFlavor("image/png");
    transferable.setTransferData("image/png", container);
    Services.clipboard.setData(transferable, null, Services.clipboard.kGlobalClipboard);
    Breached.showMessage(`Copied a picture of the page (${image.width} × ${image.height})`);
    return null;
  }
  let blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
  let dir = await Downloads.getPreferredDownloadsDirectory();
  let path = PathUtils.join(dir, fileName(browser));
  await IOUtils.write(path, new Uint8Array(await blob.arrayBuffer()));
  Breached.showMessage(`Saved ${PathUtils.filename(path)} in your Downloads folder`);
  return path;
}

Mod.command("screenshot", {
  usage: "screenshot [-f] [-c]  (-f the whole page, -c copy instead of saving)",
  run(args) {
    let flags = args.split(/\s+/);
    return take({ full: flags.includes("-f"), copy: flags.includes("-c") }).catch(e => {
      Breached.showMessage(`Screenshot failed: ${e.message}`, "error");
    });
  },
});
Mod.key("s", "accel,shift", () => Breached.run("screenshot"));

// For the self-test and other mods.
Mod.hook("screenshot", { take });
