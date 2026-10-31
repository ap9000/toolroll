export const csv = rows => rows.map(r => r.join(',')).join('\n');
