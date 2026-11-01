import { createContext, forwardRef, useContext, type FormHTMLAttributes, type ReactNode } from "react";

/** The signed-in session's form token, set once where the workspace mounts. */
export const FormToken = createContext("");

/** Passwordless is on for this signed-in browser (docs/plans/passwordless.md), set once where the workspace mounts. */
export const Passwordless = createContext(false);

/** A ceremony's re-authentication field: shown, or with Passwordless on, left out (the form posts no password). Never
 * for a credential act, a secret or a key. */
export function Reauth({ children }: { children: ReactNode }) {
  return useContext(Passwordless) ? null : <>{children}</>;
}

/** A POST form: the only way the workspace writes one. It carries the session's form token itself. */
export const PostForm = forwardRef<HTMLFormElement, Omit<FormHTMLAttributes<HTMLFormElement>, "method">>(function PostForm({ children, ...props }, ref) {
  const csrf = useContext(FormToken);
  return <form ref={ref} method="post" {...props}><input type="hidden" name="csrf" value={csrf} />{children}</form>;
});
