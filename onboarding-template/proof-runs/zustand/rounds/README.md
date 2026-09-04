# Adversarial rounds

The top-level `adversarial/` directory holds the verdicts the committed report is built from: the final pass for each module (react-binding: round 3; selectors-rerenders and middleware-and-code: round 4; vanilla-store: round 5). Earlier passes are kept here so the correction loop is inspectable. Each round re-prepped only the modules whose text changed, re-ran a fresh skeptic (and quiz writer) for them, and the course was corrected in `generator/authored/zustand.ts` between rounds.

| round | atomic claims | supported | refuted | unverifiable |
|---|---|---|---|---|
| 1 | 113 | 97 | 13 | 3 |
| 2 | 149 | 142 | 3 | 4 |
| 3 | 152 | 148 | 1 | 3 |
| 4 | 114 | 113 | 1 | 0 |
| final | 155 | 155 | 0 | 0 |

Round 1 is the first adversarial pass on the hand-authored course as published before this release (grounding had passed 17/17). Rounds 2 to 5 attack the corrections themselves; each surviving refutation was a smaller precision error than the one before (an unqualified flag, a universal quantifier, a mis-attributed mechanism, an omitted third closure variable). Claim counts grow between rounds because more precise sentences split into more atomic claims.
