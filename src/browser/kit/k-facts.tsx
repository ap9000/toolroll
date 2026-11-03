/** Facts: a key/value list. Rules: src/design/KIT.md; same markup as src/server/kit.ts. */
import { Fragment } from "react";
import type { ReactNode } from "react";

export function KFacts({ rows }: { rows: ReadonlyArray<readonly [key: string, value: ReactNode]> }) {
  return <dl className="k-facts">{rows.map(([key, value]) => <Fragment key={key}><dt>{key}</dt><dd>{value}</dd></Fragment>)}</dl>;
}
