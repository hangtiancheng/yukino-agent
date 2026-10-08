import type { CSSProperties } from "react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const JUSTIFY_CLASSES: Record<string, string> = {
  start: "justify-start",
  center: "justify-center",
  end: "justify-end",
  spaceBetween: "justify-between",
  spaceAround: "justify-around",
  spaceEvenly: "justify-evenly",
  stretch: "justify-stretch",
};

export const ALIGN_CLASSES: Record<string, string> = {
  start: "items-start",
  center: "items-center",
  end: "items-end",
  stretch: "items-stretch",
};

export const FIT_CLASSES: Record<string, string> = {
  contain: "object-contain",
  cover: "object-cover",
  fill: "object-fill",
  none: "object-none",
  scaleDown: "object-scale-down",
};

export const IMAGE_VARIANT_CLASSES: Record<string, string> = {
  icon: "size-6 rounded-md",
  avatar: "size-10 rounded-full",
  smallFeature: "max-w-24 rounded-lg",
  largeFeature: "max-h-96 rounded-lg",
  header: "h-48 w-full rounded-lg object-cover",
};

export const MARKDOWN_VARIANT_CLASSES: Record<string, string> = {
  h1: "font-heading text-3xl font-semibold tracking-tight",
  h2: "font-heading text-2xl font-semibold tracking-tight",
  h3: "font-heading text-xl font-semibold",
  h4: "font-heading text-lg font-medium",
  h5: "font-heading text-base font-medium",
  caption: "text-xs text-muted-foreground",
};

export const MARKDOWN_CLASSES = cn(
  "min-w-0 text-sm leading-relaxed",
  "[&_a]:underline [&_a]:underline-offset-3",
  "[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_code]:text-xs",
  "[&_ol]:list-decimal [&_ol]:pl-5 [&_p:not(:last-child)]:mb-2 [&_ul]:list-disc [&_ul]:pl-5",
);

export function justifyClass(justify?: string) {
  return (justify && JUSTIFY_CLASSES[justify]) || JUSTIFY_CLASSES.start;
}

export function alignClass(align?: string) {
  return (align && ALIGN_CLASSES[align]) || ALIGN_CLASSES.stretch;
}

// min-width/min-height 0 let weighted children shrink below their intrinsic
// content size, otherwise large content forces the container to overflow.
export function weightStyle(weight?: number): CSSProperties {
  if (typeof weight !== "number") return {};
  return { flex: `${weight}`, minWidth: 0, minHeight: 0 };
}
