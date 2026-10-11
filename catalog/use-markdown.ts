import { useMarkdownRenderer } from "@a2ui/react/v0_9";
import { useEffect, useState } from "react";

export function useMarkdown(text: string) {
  const renderer = useMarkdownRenderer();
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    if (!renderer) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setHtml(null);
      return;
    }

    let active = true;
    renderer(text)
      .then((result) => {
        if (active) {
          setHtml(result);
        }
      })
      .catch((err: unknown) => {
        console.error("[useMarkdown] render failed:", err);
      });

    return () => {
      active = false;
    };
  }, [text, renderer]);

  return html;
}
