// Function-word vocabulary and the a/an rule. Kept separate so the connective
// pattern table reads as grammar, not string soup.

// Words pronounced with an initial *consonant* sound despite a vowel spelling
// ("a university", "a one-eyed cat"). These take "a", not "an".
const A_BEFORE_VOWEL_SPELLING =
  /^(uni|use|user|usab|usur|usu|ubiq|ura|ute|uti|uto|util|euro|euph|eur|eu|ewe|once|one|ufo|uku)/i;

// Words pronounced with an initial *vowel* sound despite a consonant spelling
// ("an hour", "an honest mistake"). These take "an", not "a".
const AN_BEFORE_CONSONANT_SPELLING = /^(hour|honest|honou?r|honora|heir)/i;

// Choose "a" or "an" for the word that follows it, handling the common
// silent-h and "yoo"/"wun" exceptions beyond the naive vowel-letter test.
export function indefiniteArticle(nextWord: string): "a" | "an" {
  const w = nextWord.toLowerCase();
  if (AN_BEFORE_CONSONANT_SPELLING.test(w)) return "an";
  if (A_BEFORE_VOWEL_SPELLING.test(w)) return "a";
  return /^[aeiou]/.test(w) ? "an" : "a";
}

// Pools drawn on by the connective pattern table for surreal-but-readable glue.
export const PREPOSITIONS = [
  "into",
  "through",
  "beneath",
  "beyond",
  "under",
  "across",
  "without",
  "upon",
  "behind",
  "toward",
] as const;

export const CONJUNCTIONS = ["and", "or", "but", "yet", "so"] as const;
