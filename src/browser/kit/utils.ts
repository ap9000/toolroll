/** Class names joined, falsy parts left out. */
export const cn = (...names: Array<string | false | null | undefined>): string => names.filter(Boolean).join(" ");
