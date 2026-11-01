export const dedupe = rows => Object.values(Object.fromEntries(rows.map(r => [r.id, r])));
