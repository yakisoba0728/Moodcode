import { lazy, Suspense, type ComponentProps } from "react";
import type { CodeBlock as LoadedCodeBlock } from "./CodeBlock.js";
import "./conversation.css";

export const DeferredCodeBlock = lazy(() =>
  import("./CodeBlock.js").then((module) => ({ default: module.CodeBlock })),
);

export function CodeBlock(props: ComponentProps<typeof LoadedCodeBlock>) {
  return (
    <Suspense
      fallback={
        <p className="pane-note" role="status">
          코드를 불러오는 중이에요.
        </p>
      }
    >
      <DeferredCodeBlock {...props} />
    </Suspense>
  );
}
