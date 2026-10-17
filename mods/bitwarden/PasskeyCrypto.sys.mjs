/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The WebAuthn side of Bitwarden passkeys: signing in with a passkey kept in
// the vault, and making a new one to keep there. Plain JavaScript over
// WebCrypto (pass in crypto.subtle), so it also runs under Node for tests.
//
// Bitwarden keeps a passkey as { credentialId (a GUID, or "b64.<base64url>"),
// keyValue (the PKCS#8 private key, base64url), rpId, userHandle (base64url),
// counter, ... } on a login item (see bw get template item.login).

// Bitwarden's authenticator id, so sites see the same as with its extension.
export const AAGUID = "d548826e-79b4-db40-a3d8-11116f7e8349";

const FLAG_UP = 0x01; // user present
const FLAG_UV = 0x04; // user verified (the vault was unlocked with the master password)
const FLAG_BE = 0x08; // backup eligible
const FLAG_BS = 0x10; // backed up (the vault syncs)
const FLAG_AT = 0x40; // attested credential data included

// ------------------------------------------------------------------ bytes

export function toB64url(bytes) {
  bytes = new Uint8Array(bytes);
  let s = "";
  for (let b of bytes) {
    s += String.fromCharCode(b);
  }
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64 or base64url, with or without padding. */
export function fromB64(text) {
  let s = String(text).replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  s += "=".repeat((4 - (s.length % 4)) % 4);
  let bin = atob(s);
  let out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

function concat(...parts) {
  let total = parts.reduce((n, p) => n + p.length, 0);
  let out = new Uint8Array(total);
  let offset = 0;
  for (let p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function guidToBytes(guid) {
  let hex = guid.replace(/-/g, "");
  let out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToGuid(bytes) {
  let hex = [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The credential id a site knows, from how Bitwarden stores it. */
export function credentialIdBytes(stored) {
  if (stored.startsWith("b64.")) {
    return fromB64(stored.slice(4));
  }
  if (GUID.test(stored)) {
    return guidToBytes(stored);
  }
  return fromB64(stored);
}

function uint32(n) {
  return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
}

// ------------------------------------------------------------------- CBOR

function cborHead(major, n) {
  if (n < 24) {
    return new Uint8Array([(major << 5) | n]);
  }
  if (n < 256) {
    return new Uint8Array([(major << 5) | 24, n]);
  }
  if (n < 65536) {
    return new Uint8Array([(major << 5) | 25, n >> 8, n & 255]);
  }
  return concat(new Uint8Array([(major << 5) | 26]), uint32(n));
}

/** CBOR for what WebAuthn needs: integers, text, bytes and maps (Map keeps key order). */
export function cbor(value) {
  if (typeof value == "number") {
    return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  }
  if (typeof value == "string") {
    let bytes = new TextEncoder().encode(value);
    return concat(cborHead(3, bytes.length), bytes);
  }
  if (value instanceof Uint8Array) {
    return concat(cborHead(2, value.length), value);
  }
  if (value instanceof Map) {
    let parts = [cborHead(5, value.size)];
    for (let [k, v] of value) {
      parts.push(cbor(k), cbor(v));
    }
    return concat(...parts);
  }
  throw new Error("cbor: unsupported value");
}

// ---------------------------------------------------------- signatures

/** WebCrypto's ECDSA signature (r and s, 32 bytes each) as DER, like authenticators send. */
export function rawToDer(raw) {
  raw = new Uint8Array(raw);
  let int = bytes => {
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] == 0) {
      i++;
    }
    bytes = bytes.slice(i);
    if (bytes[0] & 0x80) {
      bytes = concat(new Uint8Array([0]), bytes);
    }
    return concat(new Uint8Array([0x02, bytes.length]), bytes);
  };
  let body = concat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return concat(new Uint8Array([0x30, body.length]), body);
}

/** DER back to r and s (for checking a signature with WebCrypto). */
export function derToRaw(der) {
  der = new Uint8Array(der);
  let out = new Uint8Array(64);
  let offset = 2;
  for (let half = 0; half < 2; half++) {
    let length = der[offset + 1];
    let bytes = der.slice(offset + 2, offset + 2 + length);
    bytes = bytes.slice(Math.max(0, bytes.length - 32));
    out.set(bytes, half * 32 + (32 - bytes.length));
    offset += 2 + length;
  }
  return out;
}

async function sha256(subtle, bytes) {
  return new Uint8Array(await subtle.digest("SHA-256", bytes));
}

// ------------------------------------------------------------- the rules

/**
 * Whether a page at origin may use rpId: the page's host is the rpId or
 * under it, over https (or http on this computer).
 */
export function rpIdAllowed(origin, rpId) {
  let url;
  try {
    url = new URL(origin);
  } catch (e) {
    return false;
  }
  let host = url.hostname;
  let local = host == "localhost" || host.endsWith(".localhost");
  if (url.protocol != "https:" && !(url.protocol == "http:" && local)) {
    return false;
  }
  if (!rpId || /^[\d.]+$/.test(rpId) || rpId.includes(":")) {
    return false; // not a domain
  }
  return host == rpId || host.endsWith("." + rpId);
}

function clientData(type, { challenge, origin, topOrigin, crossOrigin }) {
  let data = { type, challenge, origin, crossOrigin: !!crossOrigin };
  if (crossOrigin) {
    data.topOrigin = topOrigin;
  }
  return new TextEncoder().encode(JSON.stringify(data));
}

/**
 * Signs in: returns the assertion's parts as base64url.
 * request: { rpId, challenge (base64url), origin, topOrigin, crossOrigin }
 * passkey: Bitwarden's stored passkey; counter is the value to send.
 */
export async function assert(subtle, request, passkey, counter) {
  let key = await subtle.importKey(
    "pkcs8",
    fromB64(passkey.keyValue),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  let authData = concat(
    await sha256(subtle, new TextEncoder().encode(request.rpId)),
    new Uint8Array([FLAG_UP | FLAG_UV | FLAG_BE | FLAG_BS]),
    uint32(counter)
  );
  let clientDataJSON = clientData("webauthn.get", request);
  let signed = concat(authData, await sha256(subtle, clientDataJSON));
  let raw = await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, signed);
  return {
    id: toB64url(credentialIdBytes(passkey.credentialId)),
    clientDataJSON: toB64url(clientDataJSON),
    authenticatorData: toB64url(authData),
    signature: toB64url(rawToDer(raw)),
    userHandle: passkey.userHandle ? toB64url(fromB64(passkey.userHandle)) : null,
  };
}

/**
 * Makes a new passkey: returns { passkey (to keep in Bitwarden), credential
 * (the parts for the page, base64url) }.
 * request: { rpId, rpName, user: { id, name, displayName }, challenge, origin, topOrigin, crossOrigin }
 */
export async function create(subtle, request, randomUUID) {
  let pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  let point = new Uint8Array(await subtle.exportKey("raw", pair.publicKey)); // 0x04 | x | y
  let guid = randomUUID();
  let credentialId = guidToBytes(guid);
  let coseKey = cbor(
    new Map([
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, point.slice(1, 33)],
      [-3, point.slice(33, 65)],
    ])
  );
  let authData = concat(
    await sha256(subtle, new TextEncoder().encode(request.rpId)),
    new Uint8Array([FLAG_UP | FLAG_UV | FLAG_BE | FLAG_BS | FLAG_AT]),
    uint32(0),
    guidToBytes(AAGUID),
    new Uint8Array([credentialId.length >> 8, credentialId.length & 255]),
    credentialId,
    coseKey
  );
  let attestationObject = cbor(
    new Map([
      ["fmt", "none"],
      ["attStmt", new Map()],
      ["authData", authData],
    ])
  );
  let clientDataJSON = clientData("webauthn.create", request);
  let pkcs8 = new Uint8Array(await subtle.exportKey("pkcs8", pair.privateKey));
  let spki = new Uint8Array(await subtle.exportKey("spki", pair.publicKey));
  return {
    passkey: {
      credentialId: guid,
      keyType: "public-key",
      keyAlgorithm: "ECDSA",
      keyCurve: "P-256",
      keyValue: toB64url(pkcs8),
      rpId: request.rpId,
      rpName: request.rpName || request.rpId,
      userHandle: request.user.id,
      userName: request.user.name,
      userDisplayName: request.user.displayName,
      counter: "0",
      discoverable: "true",
      creationDate: new Date().toISOString(),
    },
    credential: {
      id: toB64url(credentialId),
      clientDataJSON: toB64url(clientDataJSON),
      attestationObject: toB64url(attestationObject),
      authenticatorData: toB64url(authData),
      publicKey: toB64url(spki),
    },
  };
}
