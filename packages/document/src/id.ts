/**
 * Node ids are `n_` + 6 random base32 chars (`[a-z2-7]`), not sequential —
 * two branches adding nodes must not collide on `n7` and manufacture merge
 * conflicts (ADR-0004 decision 5).
 */
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const ID_LENGTH = 6;

export function generateNodeId(taken?: Iterable<string>): string {
  const used =
    taken instanceof Set ? (taken as Set<string>) : taken !== undefined ? new Set(taken) : undefined;
  for (;;) {
    let id = 'n_';
    for (let i = 0; i < ID_LENGTH; i++) {
      id += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    }
    if (!used?.has(id)) return id;
  }
}
