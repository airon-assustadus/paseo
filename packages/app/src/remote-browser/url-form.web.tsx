import { useCallback, type CSSProperties, type FormEvent } from "react";
import type { UrlFormProps } from "./url-form";

const formStyle: CSSProperties = { display: "contents" };

/** Soft-keyboard actions can submit a form without producing a usable Enter keydown. */
export function UrlForm({ children, onSubmit }: UrlFormProps) {
  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      onSubmit();
    },
    [onSubmit],
  );
  return (
    <form noValidate style={formStyle} onSubmit={handleSubmit}>
      {children}
    </form>
  );
}
