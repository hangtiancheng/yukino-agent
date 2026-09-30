import { useId } from "react";

import { createComponentImplementation } from "@a2ui/react/v0_9";
import { TextFieldApi } from "@a2ui/web_core/v0_9/basic_catalog";

import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export const TextField = createComponentImplementation(
  TextFieldApi,
  ({ props }) => {
    const id = useId();
    const errors = props.validationErrors;
    const hasError = !!errors && errors.length > 0;
    const type =
      props.variant === "number"
        ? "number"
        : props.variant === "obscured"
          ? "password"
          : "text";

    return (
      <Field data-invalid={hasError || undefined}>
        {props.label && <FieldLabel htmlFor={id}>{props.label}</FieldLabel>}
        {props.variant === "longText" ? (
          <Textarea
            id={id}
            value={props.value || ""}
            onChange={(e) => props.setValue(e.target.value)}
            aria-invalid={hasError || undefined}
          />
        ) : (
          <Input
            id={id}
            type={type}
            value={props.value || ""}
            onChange={(e) => props.setValue(e.target.value)}
            aria-invalid={hasError || undefined}
          />
        )}
        {hasError && <FieldError>{errors[0]}</FieldError>}
      </Field>
    );
  },
);
