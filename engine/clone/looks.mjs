// Look rotation: a batch of pieces never shows the same avatar look twice in a row,
// including across the boundary with the previous batch.

/**
 * pieces: ordered piece names. looks: available look names (aliases, not provider ids).
 * previous: the look used last in the previous batch, if known.
 * Picks, for each piece, the least-used look that differs from the one before it.
 */
export function assignLooks(pieces, looks, { previous = null } = {}) {
  if (!Array.isArray(pieces) || !Array.isArray(looks)) throw new Error("Pieces and looks must be lists.");
  if (new Set(pieces).size !== pieces.length) throw new Error("Each piece in a batch needs a unique name.");
  if (new Set(looks).size !== looks.length) throw new Error("Each look needs a unique name.");
  if (!pieces.length) return [];
  if (!looks.length) throw new Error("No looks are available. Add looks to the private config.");
  const before = looks.includes(previous) ? previous : null;
  if (looks.length === 1 && (pieces.length > 1 || before === looks[0])) {
    throw new Error("Back-to-back repeats cannot be avoided with one look. Record or add another look, or split the batch.");
  }
  const uses = new Map(looks.map((look) => [look, 0]));
  const plan = [];
  let last = before;
  for (const piece of pieces) {
    const look = looks
      .filter((candidate) => candidate !== last)
      .sort((x, y) => uses.get(x) - uses.get(y) || looks.indexOf(x) - looks.indexOf(y))[0];
    uses.set(look, uses.get(look) + 1);
    plan.push({ piece, look });
    last = look;
  }
  return plan;
}
