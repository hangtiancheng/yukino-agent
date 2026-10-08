import type { CSSProperties } from "react";

import { createComponentImplementation } from "@a2ui/react/v0_9";
import { TextApi } from "@a2ui/web_core/v0_9/basic_catalog";

import {
  cn,
  weightStyle,
  MARKDOWN_VARIANT_CLASSES,
  MARKDOWN_CLASSES,
} from "@/lib/utils";
import { useMarkdown } from "@/catalog/use-markdown";

function MarkdownText({ text, style }: { text: string; style: CSSProperties }) {
  const html = useMarkdown(text);

  if (html === null) {
    return (
      <div className={MARKDOWN_CLASSES} style={style}>
        {text}
      </div>
    );
  }
  return (
    <div
      className={MARKDOWN_CLASSES}
      style={style}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export const Text = createComponentImplementation(TextApi, ({ props }) => {
  const text =
    typeof props.text === "string" ? props.text : String(props.text ?? "");
  const style = weightStyle(props.weight);
  const variantClass = props.variant
    ? MARKDOWN_VARIANT_CLASSES[props.variant]
    : undefined;

  if (variantClass) {
    return (
      <div className={cn("min-w-0", variantClass)} style={style}>
        {text}
      </div>
    );
  }
  return <MarkdownText text={text} style={style} />;
});
