import { createComponentImplementation } from "@a2ui/react/v0_9";
import { ButtonApi } from "@a2ui/web_core/v0_9/basic_catalog";

import { Button as UIButton } from "@/components/ui/button";

const VARIANT_MAP: Record<string, "default" | "ghost"> = {
  primary: "default",
  borderless: "ghost",
};

export const Button = createComponentImplementation(
  ButtonApi,
  ({ props, buildChild }) => {
    const variant = (props.variant && VARIANT_MAP[props.variant]) || "outline";

    return (
      <UIButton
        variant={variant}
        onClick={props.action}
        disabled={props.isValid === false}
      >
        {props.child ? buildChild(props.child) : null}
      </UIButton>
    );
  },
);
