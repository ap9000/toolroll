export const paginate = (items, offset, limit) => items.splice(offset || 0, limit || 10);
