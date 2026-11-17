/**
 * Subjects on /analytics: the curated topics (same names and slugs as the
 * `topics` seed) each defined by a PUBLIC keyword query in the same grammar as
 * the query box. Coverage is computed live from transcripts and titles, so a
 * subject's count is reproducible by pasting its query into the compare box.
 * No model assigns these; edit a definition here (reviewed in git) to change it.
 */
export interface Subject {
  slug: string;
  name: string;
  /** websearch_to_tsquery syntax: words, "exact phrases", OR, -exclusions. */
  query: string;
  /** Known ambiguity or caption caveat shown next to the count. */
  note?: string;
}

export const SUBJECTS: readonly Subject[] = [
  { slug: "governance", name: "Governance", query: "governance" },
  { slug: "voltaire", name: "Voltaire", query: "voltaire" },
  { slug: "constitution", name: "Constitution", query: "constitution", note: "Stemming also matches “constitutional”." },
  { slug: "dreps", name: "DReps", query: 'drep OR "delegated representative"' },
  { slug: "treasury", name: "Treasury", query: "treasury" },
  { slug: "catalyst", name: "Catalyst", query: "catalyst", note: "Also the ordinary word (“a catalyst for…”)." },
  { slug: "intersect", name: "Intersect", query: "intersect", note: "Also the ordinary verb, especially before 2023." },
  { slug: "midnight", name: "Midnight", query: "midnight", note: "Before 2022 this is almost always the time of day." },
  { slug: "hydra", name: "Hydra", query: "hydra" },
  { slug: "leios", name: "Leios", query: "leios", note: "Caption spellings of “Leios” are not covered." },
  { slug: "ouroboros", name: "Ouroboros", query: "ouroboros OR oroboros", note: "Includes the caption spelling “oroboros”." },
  { slug: "scaling", name: "Scaling", query: "scalability OR scaling", note: "Stemming also matches “scale”." },
  { slug: "mithril", name: "Mithril", query: "mithril" },
  { slug: "partner-chains", name: "Partner Chains", query: '"partner chain" OR sidechain OR "side chain"' },
  { slug: "staking", name: "Staking", query: 'staking OR "stake pool" OR delegation', note: "Stemming also matches “stake”, as in proof of stake." },
  { slug: "tokenomics", name: "Tokenomics", query: 'tokenomics OR inflation OR "monetary policy"' },
  { slug: "roadmap", name: "Roadmap", query: "roadmap" },
  { slug: "regulation", name: "Regulation", query: "regulation OR regulators OR regulatory" },
  { slug: "sec", name: "SEC", query: 'sec OR "securities and exchange commission" OR gensler', note: "Captions can render “sec” for other words." },
  { slug: "etf", name: "ETF", query: "etf" },
  { slug: "bitcoin", name: "Bitcoin", query: "bitcoin" },
  { slug: "ethereum", name: "Ethereum", query: "ethereum OR aetherium", note: "Includes the caption spelling “aetherium”." },
  { slug: "ripple", name: "Ripple", query: "ripple OR xrp", note: "“Ripple” is also the ordinary word." },
  { slug: "stablecoins", name: "Stablecoins", query: 'stablecoin OR "stable coin"' },
  { slug: "defi", name: "DeFi", query: 'defi OR "decentralized finance"' },
  { slug: "realfi", name: "RealFi", query: 'realfi OR "real fi"' },
  { slug: "smart-contracts", name: "Smart Contracts", query: '"smart contract" OR plutus' },
  { slug: "marlowe", name: "Marlowe", query: "marlowe" },
  { slug: "identity", name: "Identity", query: 'identity OR "atala prism"' },
  { slug: "africa", name: "Africa", query: "africa OR african OR ethiopia" },
  { slug: "adoption", name: "Adoption", query: "adoption" },
  { slug: "decentralization", name: "Decentralization", query: "decentralization", note: "Stemming also matches “decentralized”." },
  { slug: "interoperability", name: "Interoperability", query: "interoperability OR interoperable" },
  { slug: "privacy", name: "Privacy", query: 'privacy OR "zero knowledge"' },
  { slug: "quantum", name: "Quantum", query: "quantum" },
  { slug: "wallets", name: "Wallets", query: "wallet OR lace", note: "“Lace” is also the ordinary word." },
  { slug: "node", name: "Node", query: "node" },
  { slug: "education", name: "Education", query: 'education OR "peer review" OR "formal methods"' },
  { slug: "philosophy", name: "Philosophy", query: "philosophy OR philosophical" },
  { slug: "community", name: "Community", query: "community" },
  { slug: "charles-personal", name: "Charles Personal", query: "ranch", note: "Only the ranch; other personal asides have no reliable keyword." },
];

/** The subject whose definition is exactly this query (case/space-insensitive). */
export function subjectForQuery(q: string): Subject | undefined {
  const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  const n = norm(q);
  return SUBJECTS.find((s) => norm(s.query) === n);
}
