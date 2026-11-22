// Chat and tag filter for i-Pet Cyber Store 2096.
// Players are likely to include kids, so this errs on the strict side:
//  - swear words and slurs are replaced with ****, including l33t spellings
//    (sh1t, $hit) and spaced-out letters (s h i t),
//  - anything that looks like personal contact info (phone numbers, email
//    addresses, links, @handles) is blanked, so nobody can swap details.
// Add words to BLOCKED (lower case, letters only). It matches whole words and
// words with extra letters on the end (shits, shitty), not words that merely
// contain it (so "class", "assume", "Scunthorpe" are fine).

const BLOCKED = [
  "fuck", "fuk", "fck", "shit", "shite", "bitch", "biatch", "cunt", "dick", "dickhead",
  "cock", "pussy", "asshole", "arsehole", "arse", "ass", "bastard", "bollocks",
  "wanker", "wank", "twat", "prick", "slut", "whore", "piss", "crap", "damn",
  "bullshit", "motherfucker", "jackass", "dumbass", "retard", "retarded", "spastic",
  "nigger", "nigga", "faggot", "fag", "kaffir", "kaffer", "chink", "spic", "kike",
  "tranny", "dyke", "paki", "coon", "gook", "wetback", "porn", "porno", "sex", "sexy",
  "nude", "nudes", "naked", "boobs", "tits", "penis", "vagina", "rape", "rapist",
  "kys", "killyourself", "nazi", "hitler", "poes", "naai", "doos", "fokof", "kak",
];

const LEET = { "0": "o", "1": "i", "!": "i", "3": "e", "4": "a", "@": "a", "5": "s", "$": "s", "7": "t", "8": "b", "+": "t" };

function normalise(word) {
  let out = "";
  for (const ch of word.toLowerCase()) {
    const c = LEET[ch] || ch;
    if (c >= "a" && c <= "z") out += c;
  }
  // "fuuuuck" -> "fuck"
  return out.replace(/(.)\1{2,}/g, "$1");
}

function isBlocked(word) {
  const n = normalise(word);
  if (n.length < 2) return false;
  for (const bad of BLOCKED) {
    if (n === bad) return true;
    if (bad.length >= 4 && n.startsWith(bad) && n.length <= bad.length + 3) return true;
    if (n.replace(/(.)\1+/g, "$1") === bad.replace(/(.)\1+/g, "$1") && bad.length >= 4) return true;
  }
  return false;
}

const CONTACT = [
  /\b[\w.+-]+@[\w-]+\.[\w.]+\b/g,                   // email
  /\bhttps?:\/\/\S+/gi,                             // links
  /\bwww\.\S+/gi,
  /\b[\w-]+\.(com|net|org|io|gg|co|za|me|tv|ly|app|xyz)\b\S*/gi,
  /(?:\+?\d[\s\-().]*){7,}/g,                       // phone numbers (7+ digits)
  /(^|\s)@\w{2,}/g,                                 // @handles
  /\b(discord|snap|snapchat|insta|instagram|tiktok|whatsapp|telegram|kik)\b\S*/gi,
];

function stars(s) {
  return "*".repeat(Math.max(3, Math.min(s.length, 8)));
}

function cleanText(text) {
  let t = String(text || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  for (const re of CONTACT) t = t.replace(re, (m) => (m.startsWith(" ") ? " " : "") + stars(m.trim()));
  // Whole words.
  t = t.replace(/[^\s]+/g, (w) => (isBlocked(w) ? stars(w) : w));
  // Spaced-out words: "s h i t" / "f.u.c.k"
  t = t.replace(/\b(?:[a-z0-9$@!][\s._-]){2,}[a-z0-9$@!]\b/gi, (m) => (isBlocked(m.replace(/[\s._-]/g, "")) ? stars(m) : m));
  return t;
}

// A tag is a name shown above your pet and in the lobby. Letters, digits,
// spaces, _ and -; 3-14 characters; nothing blocked anywhere inside it
// (tags are short and permanent, so substring matches count here).
function cleanTag(tag) {
  let t = String(tag || "").replace(/[^A-Za-z0-9 _-]/g, "").replace(/\s+/g, " ").trim().slice(0, 14);
  if (t.length < 3) return null;
  const n = normalise(t);
  for (const bad of BLOCKED) if (bad.length >= 4 && n.includes(bad)) return null;
  for (const w of t.split(/[\s_-]+/)) if (isBlocked(w)) return null;
  if (/\d{5,}/.test(t)) return null;   // no phone-number tags
  return t;
}

module.exports = { cleanText, cleanTag, isBlocked };
