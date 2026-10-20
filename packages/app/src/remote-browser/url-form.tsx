import type { ReactNode } from "react";

export interface UrlFormProps {
  children: ReactNode;
  onSubmit: () => void;
}

export function UrlForm({ children }: UrlFormProps) {
  return children;
}
