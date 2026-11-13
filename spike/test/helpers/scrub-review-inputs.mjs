// Every input the candidate delta review listed under Major A (parts 1, 2
// and 3) and Minors 2 and 3, one row each, in the review's own shape. The
// values are fake and built at run time from plain pieces, so no file holds
// a secret-shaped literal.
//   [id, kind, input, secret parts that must not survive]
// kind "text" goes through scrubText, kind "value" through scrubValue.
const cat = (...parts) => parts.join("");
const KEY = "4c".repeat(32);
const PW = cat("hun", "ter", "2");
const STRIPE = cat("sk", "_live_", "abcdefghijklmnop");
const GH = cat("gh", "p_", "a1B2c3D4e5F6g7H8i9J0", "k1L2m3N4o5P6q7R8");
const BEARER = cat("eyJ", "hbGciOiJIUzI1NiJ9");
const DBPW = cat("cor", "rect-horse-", "42");
const WORDS = ["abandon", "ability", "able", "about", "above", "absent", "absorb", "abstract", "absurd", "abuse", "access", "accident"];
const cap = (w) => w[0].toUpperCase() + w.slice(1);
const MIXED = WORDS.map((w, i) => (i % 2 ? w.toUpperCase() : w));
const PLAIN = cat("plain", "-value");

export const REVIEW_INPUTS = [
  // Major A, part 1: colon forms in text.
  ["A1 password: value", "text", cat("password: ", PW), [PW]],
  ["A1 api_key: sk_live_…", "text", cat("api_key: ", STRIPE), [STRIPE]],
  ["A1 \"password\": \"x\" in a string body", "text", cat('response {"user":"bob","password": "', "x9", '"}'), ['"x9"']],
  ["A1 Kubernetes stringData YAML", "value", { stringData: { "config.yaml": cat("password: ", PW, "\napiKey: ", STRIPE) } }, [PW, STRIPE]],
  // Major A, part 2: a seed phrase in free text, not all lowercase on spaces.
  ["A2 seed in Title case", "text", cat("words: ", WORDS.map(cap).join(" ")), WORDS.map(cap)],
  ["A2 seed in UPPER case", "text", cat("words: ", WORDS.map((w) => w.toUpperCase()).join(" ")), WORDS.map((w) => w.toUpperCase())],
  ["A2 seed in mixed case", "text", cat("words: ", MIXED.join(" ")), MIXED],
  ["A2 seed with the first word capitalised", "text", [cap(WORDS[0]), ...WORDS.slice(1)].join(" "), WORDS.slice(1)],
  ["A2 seed comma-separated", "text", cat("words: ", WORDS.join(", ")), WORDS],
  ["A2 seed one word per line", "text", cat("words:\n", WORDS.join("\n")), WORDS],
  ["A2 seed as a numbered list", "text", cat("words:\n", WORDS.map((w, i) => `${i + 1}. ${w}`).join("\n")), WORDS],
  // Major A, part 3: a 64-hex key under data, input or a *Hash name.
  ["A3 key under data", "value", { data: `0x${KEY}` }, [KEY]],
  ["A3 key under input", "value", { input: `0x${KEY}` }, [KEY]],
  ["A3 key under txHash", "value", { txHash: `0x${KEY}` }, [KEY]],
  // Minor 2: a secret split by a line break.
  ["m2 Authorization: Bearer, token on the next line", "text", cat("Authorization: Bearer\n", BEARER), [BEARER]],
  ["m2 DB_PASSWORD=, value on the next line", "text", cat("DB_PASSWORD=\n", DBPW), [DBPW]],
  ["m2 a ghp_ token across two lines", "text", cat(GH.slice(0, 22), "\n", GH.slice(22)), [GH.slice(4, 22), GH.slice(22)]],
  // Minor 3: an object under a secret name.
  ["m3 an object under a secret name", "value", { secret: { v: PLAIN } }, [PLAIN]],
];
