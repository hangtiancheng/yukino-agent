import { Fragment, type ReactNode } from "react";

type ChildRef = string | { id: string; basePath: string };

export function ChildList({
  childList,
  buildChild,
}: {
  childList: unknown;
  buildChild: (id: string, basePath?: string) => ReactNode;
}) {
  if (!Array.isArray(childList)) return null;

  return (
    <>
      {(childList as ChildRef[]).map((childRef, index) => {
        if (typeof childRef === "string") {
          return (
            <Fragment key={`${childRef}-${index}`}>
              {buildChild(childRef)}
            </Fragment>
          );
        }
        return (
          <Fragment key={`${childRef.id}-${childRef.basePath}`}>
            {buildChild(childRef.id, childRef.basePath)}
          </Fragment>
        );
      })}
    </>
  );
}
