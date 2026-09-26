"use client";

/*
 * Client-only anonymous identity for the sidebar.
 *
 * There is no auth in this project — this is a per-tab display codename,
 * nothing more. No network, no persistence beyond sessionStorage, and no
 * dependency on the relay/WebSocket/order-book layers.
 */

const ADJECTIVES = [
  "Quantum",
  "Crimson",
  "Neon",
  "Velvet",
  "Obsidian",
  "Phantom",
  "Solar",
  "Arctic",
  "Rogue",
  "Cobalt",
] as const;

const NOUNS = [
  "Falcon",
  "Otter",
  "Wolf",
  "Comet",
  "Raven",
  "Lynx",
  "Nova",
  "Ember",
  "Drift",
  "Vector",
] as const;

const STORAGE_KEY = "anon-codename";

// Avatar gradients. The palette for a given codename is picked by hashing
// the name, so the same name always renders the same avatar.
export const AVATAR_PALETTE = [
  { from: "#5b9bf7", to: "#a78bfa" },
  { from: "#2dd4bf", to: "#5b9bf7" },
  { from: "#a78bfa", to: "#f472b6" },
  { from: "#f0a83d", to: "#f0546b" },
  { from: "#2fcf74", to: "#2dd4bf" },
] as const;

export function randomCodename(): string {
  const adjective = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]!;
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)]!;
  return `${adjective} ${noun}`;
}

// Deterministic, order-dependent string hash (djb2-style). Only ever used to
// index the palette above — not security-relevant.
export function hashName(name: string): number {
  let hash = 5381;
  for (let i = 0; i < name.length; i += 1) {
    hash = ((hash << 5) + hash + name.charCodeAt(i)) >>> 0;
  }
  return hash;
}

export function paletteFor(name: string): (typeof AVATAR_PALETTE)[number] {
  return AVATAR_PALETTE[hashName(name) % AVATAR_PALETTE.length]!;
}

/*
 * Reads the stored codename, generating (and storing) one only when there
 * isn't one yet — so a codename survives client-side navigation and remounts
 * within the tab, and regenerates only on an explicit shuffle.
 *
 * sessionStorage can throw in some private-browsing modes; in that case the
 * caller still gets a usable name, it just won't persist.
 */
export function loadOrCreateCodename(): string {
  if (typeof window === "undefined") return "";

  try {
    const stored = window.sessionStorage.getItem(STORAGE_KEY);
    if (stored) return stored;
  } catch {
    return randomCodename();
  }

  const created = randomCodename();
  try {
    window.sessionStorage.setItem(STORAGE_KEY, created);
  } catch {
    // Non-persistent fallback — still fine for this session.
  }
  return created;
}

/** Generates a fresh codename and stores it, replacing any existing one. */
export function shuffleCodename(): string {
  const next = randomCodename();
  try {
    window.sessionStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Same non-persistent fallback as above.
  }
  return next;
}

/*
 * Avatar face art: Microsoft's Fluent Emoji ("3D" style), MIT-licensed,
 * bundled locally under public/avatars/ (github.com/microsoft/fluentui-emoji
 * — assets/<Name>/3D/<slug>_3d.png). A curated set of expressive faces, not
 * the full emoji set, so every one reads as a plausible "person" reacting —
 * the small entrance/idle motion is applied in the component (Sidebar.tsx),
 * this just picks a face deterministically from the codename's hash so the
 * same name always gets the same face, same as the background palette.
 */
export interface AvatarFace {
  file: string;
  label: string;
}

export const AVATAR_FACES: readonly AvatarFace[] = [
  { file: "grinning_face_3d.png", label: "grinning face" },
  { file: "grinning_face_with_smiling_eyes_3d.png", label: "grinning face with smiling eyes" },
  { file: "beaming_face_with_smiling_eyes_3d.png", label: "beaming face with smiling eyes" },
  { file: "winking_face_3d.png", label: "winking face" },
  { file: "star-struck_3d.png", label: "star-struck face" },
  { file: "smiling_face_with_heart-eyes_3d.png", label: "smiling face with heart-eyes" },
  { file: "smiling_face_with_sunglasses_3d.png", label: "smiling face with sunglasses" },
  { file: "partying_face_3d.png", label: "partying face" },
  { file: "hugging_face_3d.png", label: "hugging face" },
  { file: "nerd_face_3d.png", label: "nerd face" },
  { file: "zany_face_3d.png", label: "zany face" },
  { file: "relieved_face_3d.png", label: "relieved face" },
  { file: "thinking_face_3d.png", label: "thinking face" },
  { file: "money-mouth_face_3d.png", label: "money-mouth face" },
] as const;

export function faceFor(name: string): AvatarFace {
  return AVATAR_FACES[hashName(name) % AVATAR_FACES.length]!;
}
