/** Wait `ms` milliseconds on the global timer (so fake timers in tests still drive it). */
export const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
