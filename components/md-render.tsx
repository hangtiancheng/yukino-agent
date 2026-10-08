"use client";
import { code } from "@streamdown/code";
import { Streamdown } from "streamdown";

interface MdRenderProps {
  content: string;
  className?: string;
  /** True while the content is still being streamed in. */
  streaming?: boolean;
}

// Markdown renderer built on Streamdown (streaming-native react-markdown
// replacement): repairs unterminated markdown mid-stream, memoizes settled
// blocks, and syntax-highlights code with Shiki.
export default function MdRender({
  content,
  className,
  streaming = false,
}: MdRenderProps) {
  return (
    <Streamdown
      mode={streaming ? "streaming" : "static"}
      isAnimating={streaming}
      caret="circle"
      plugins={{ code }}
      shikiTheme={["github-light", "github-light"]}
      className={
        className ??
        "text-foreground max-w-none text-sm leading-relaxed wrap-break-word"
      }
    >
      {content}
    </Streamdown>
  );
}
