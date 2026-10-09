import { createContext, forwardRef, useContext, type FormHTMLAttributes } from "react";

/** The signed-in session's form token, set once where the workspace mounts. */
export const FormToken = createContext("");

/** A POST form: the only way the workspace writes one. It carries the session's form token itself. */
export const PostForm = forwardRef<HTMLFormElement, Omit<FormHTMLAttributes<HTMLFormElement>, "method">>(function PostForm({ children, ...props }, ref) {
  const csrf = useContext(FormToken);
  return <form ref={ref} method="post" {...props}><input type="hidden" name="csrf" value={csrf} />{children}</form>;
});
