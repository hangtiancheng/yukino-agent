"use client";

// Markdown renderer for the DevFlow workspace: Streamdown with light/dark
// Shiki themes so code blocks follow the active theme.
import { code } from "@streamdown/code";
import { Streamdown } from "streamdown";

interface DevflowMarkdownProps {
  content: string;
  className?: string;
  streaming?: boolean;
}

export default function DevflowMarkdown({
  content,
  className,
  streaming = false,
}: DevflowMarkdownProps) {
  return (
    <Streamdown
      mode={streaming ? "streaming" : "static"}
      isAnimating={streaming}
      caret="circle"
      plugins={{ code }}
      shikiTheme={["github-light", "github-dark"]}
      className={
        className ??
        "text-foreground max-w-none text-sm leading-relaxed wrap-break-word"
      }
    >
      {content}
    </Streamdown>
  );
}
