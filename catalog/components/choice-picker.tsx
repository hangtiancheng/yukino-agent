import { useId, useState } from "react";

import { createComponentImplementation } from "@a2ui/react/v0_9";
import { ChoicePickerApi } from "@a2ui/web_core/v0_9/basic_catalog";

import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

// The option type is deeply nested in the ChoicePickerApi schema and does not
// infer cleanly through zod, mirroring the upstream basic catalog implementation.
type Option = { label?: unknown; value?: unknown };

export const ChoicePicker = createComponentImplementation(
  ChoicePickerApi,
  ({ props }) => {
    const id = useId();
    const [filter, setFilter] = useState("");
    const errors = props.validationErrors;
    const hasError = !!errors && errors.length > 0;

    const values: string[] = Array.isArray(props.value)
      ? (props.value as string[])
      : [];
    const exclusive = props.variant === "mutuallyExclusive";

    const toggle = (val: string) => {
      if (exclusive) {
        props.setValue([val]);
        return;
      }
      props.setValue(
        values.includes(val)
          ? values.filter((v) => v !== val)
          : [...values, val],
      );
    };

    const options = ((props.options || []) as Option[]).filter(
      (opt) =>
        !props.filterable ||
        filter === "" ||
        String(opt.label).toLowerCase().includes(filter.toLowerCase()),
    );

    return (
      <Field data-invalid={hasError || undefined}>
        {props.label && <FieldLabel>{props.label}</FieldLabel>}
        {props.filterable && (
          <Input
            placeholder="Filter options..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        )}
        {props.displayStyle === "chips" ? (
          <ToggleGroup
            variant="outline"
            multiple={!exclusive}
            value={values}
            onValueChange={(groupValue) => {
              const next = groupValue as string[];
              // Exclusive chips must keep exactly one selection, matching the
              // radio branch; base-ui would otherwise report [] on deselect.
              if (!exclusive || next.length > 0) props.setValue(next);
            }}
            className="flex-wrap"
          >
            {options.map((opt, i) => (
              <ToggleGroupItem key={i} value={String(opt.value)}>
                {String(opt.label)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        ) : exclusive ? (
          <RadioGroup
            value={values[0] ?? null}
            onValueChange={(v) => props.setValue([String(v)])}
          >
            {options.map((opt, i) => (
              <Field key={i} orientation="horizontal">
                <RadioGroupItem id={`${id}-${i}`} value={String(opt.value)} />
                <Label htmlFor={`${id}-${i}`}>{String(opt.label)}</Label>
              </Field>
            ))}
          </RadioGroup>
        ) : (
          <div className="flex flex-col gap-2">
            {options.map((opt, i) => (
              <Field key={i} orientation="horizontal">
                <Checkbox
                  id={`${id}-${i}`}
                  checked={values.includes(String(opt.value))}
                  onCheckedChange={() => toggle(String(opt.value))}
                />
                <Label htmlFor={`${id}-${i}`}>{String(opt.label)}</Label>
              </Field>
            ))}
          </div>
        )}
        {hasError && <FieldError>{errors[0]}</FieldError>}
      </Field>
    );
  },
);
