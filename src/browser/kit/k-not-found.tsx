/** The not-found page inside the shell. Rules: src/design/KIT.md; same markup as src/server/kit.ts. */
import { NOT_FOUND } from "../../design/kit.js";
import { KActs } from "./k-acts.js";
import { KLinkButton } from "./k-button.js";
import { KEmpty } from "./k-empty.js";
import { KPageHeader } from "./k-page-header.js";

export function KNotFound({ path, title, text }: { path: string; title?: string; text?: string }) {
  return <><KPageHeader title="Not found" /><div className="k-nf"><KEmpty title={title ?? NOT_FOUND.title(path)} text={text ?? NOT_FOUND.text}
    action={<KActs><KLinkButton sm href="/" label="Go to Home" /><KLinkButton sm variant="ghost" href="/tasks" label="Open Tasks" /></KActs>} /></div></>;
}
