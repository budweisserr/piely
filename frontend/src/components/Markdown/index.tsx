import React from "react";
import { Streamdown } from "streamdown";
import { openUrl } from "@tauri-apps/plugin-opener";

interface MarkdownRendererProps {
  children: string;
  isStreaming?: boolean;
}

export function Markdown({
  children,
  isStreaming = false,
}: MarkdownRendererProps) {
  return (
    <div className="markdown-body">
      <Streamdown
        isAnimating={isStreaming}
        shikiTheme={["github-light", "github-dark"]}
        components={COMPONENTS as any}
        controls={{
          table: true,
          code: true,
          mermaid: {
            download: true,
            copy: true,
            fullscreen: false,
            panZoom: false,
          },
        }}
      >
        {children}
      </Streamdown>
    </div>
  );
}

const COMPONENTS = {
  a: ({ children, href, ...props }: any) => {
    const handleClick = async (e: React.MouseEvent) => {
      e.preventDefault();
      if (!href) return;
      try {
        const parsed = new URL(href);
        if (
          parsed.protocol === "http:" ||
          parsed.protocol === "https:" ||
          parsed.protocol === "mailto:"
        ) {
          await openUrl(href);
        } else {
          console.warn("Blocked opening untrusted URL scheme:", parsed.protocol);
        }
      } catch (error) {
        console.error("Invalid URL clicked:", error);
      }
    };

    return (
      <a
        href={href}
        className="text-gray-600 underline underline-offset-2 hover:text-gray-800 dark:text-gray-300 dark:hover:text-gray-100 cursor-pointer"
        onClick={handleClick}
        {...props}
      >
        {children}
      </a>
    );
  },
};
