import { useId } from "react";

import { createComponentImplementation } from "@a2ui/react/v0_9";
import { CheckBoxApi } from "@a2ui/web_core/v0_9/basic_catalog";

import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";

export const CheckBox = createComponentImplementation(
  CheckBoxApi,
  ({ props }) => {
    const id = useId();
    const errors = props.validationErrors;
    const hasError = !!errors && errors.length > 0;

    return (
      <Field data-invalid={hasError || undefined}>
        <Field orientation="horizontal">
          <Checkbox
            id={id}
            checked={!!props.value}
            onCheckedChange={(checked) => props.setValue(checked === true)}
            aria-invalid={hasError || undefined}
          />
          {props.label && <FieldLabel htmlFor={id}>{props.label}</FieldLabel>}
        </Field>
        {hasError && <FieldError>{errors[0]}</FieldError>}
      </Field>
    );
  },
);
