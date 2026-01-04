"use client";

import { ButtonHTMLAttributes } from "react";

export function Button(props: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" }) {
  const { className, variant = "primary", ...rest } = props;
  const styles =
    variant === "primary"
      ? "bg-ink-950 text-white hover:bg-ink-950/90"
      : "bg-white/70 hover:bg-white border border-black/10";
  return (
    <button
      {...rest}
      className={[
        "rounded-xl px-4 py-2 text-sm font-medium shadow-sm transition disabled:opacity-60 disabled:cursor-not-allowed",
        styles,
        className || ""
      ].join(" ")}
    />
  );
}


