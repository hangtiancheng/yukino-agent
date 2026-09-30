import { createComponentImplementation } from "@a2ui/react/v0_9";
import { TabsApi } from "@a2ui/web_core/v0_9/basic_catalog";

import {
  Tabs as UITabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";

// The tab item type is deeply nested in the TabsApi schema and does not infer
// cleanly through zod, mirroring the upstream basic catalog implementation.
type Tab = { title?: unknown; child?: unknown };

export const Tabs = createComponentImplementation(
  TabsApi,
  ({ props, buildChild }) => {
    const tabs = (Array.isArray(props.tabs) ? props.tabs : []) as Tab[];
    if (tabs.length === 0) return null;

    return (
      <UITabs defaultValue={0}>
        <TabsList>
          {tabs.map((tab, i) => (
            <TabsTrigger key={i} value={i}>
              {String(tab.title ?? "")}
            </TabsTrigger>
          ))}
        </TabsList>
        {tabs.map((tab, i) => (
          <TabsContent key={i} value={i}>
            {typeof tab.child === "string" ? buildChild(tab.child) : null}
          </TabsContent>
        ))}
      </UITabs>
    );
  },
);
