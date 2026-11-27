// The reference relay lives in the package (src/companion/relay-server.ts) so a Toolroll console can run it in-process;
// this path stays for the Dockerfile and for anyone running the relay on its own.
export * from "../../src/companion/relay-server.js";
