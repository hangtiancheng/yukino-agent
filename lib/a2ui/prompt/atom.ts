/**
 * A2UI Atom inference format system prompt generator.
 *
 * Ported from the A2UI Python agent SDK `AtomPromptGenerator`
 * (`a2ui/inference_formats/experimental/atom/prompt_generator.py`).
 * Note: like the Python implementation, the Atom format does not render
 * uiDescription or examples sections, and does not prune the catalog.
 */

import { CatalogSchemaHelper, findSchemaEnum } from "./schema-helper";
import type {
  A2uiCatalogSchemas,
  PromptGenerator,
  SystemPromptOptions,
} from "./types";

export const ATOM_RULES = `Output the user interface using compact A2UI Atom S-Expression notation.
You MUST surround the entire A2UI Atom block with sentinel tags \`<a2ui>\` and \`</a2ui>\`. Do NOT output raw JSON messages.

## Grammar Rules

1. Every component node is a parenthesized expression starting with the ComponentName:
   (ComponentName :key1 val1 :key2 val2 child1 child2 ...)

2. Primitives:
   - Strings: Double-quoted, e.g., "Hello". Escapes: \\n, \\t, \\\\, \\".
   - Numbers: Integers or decimals, e.g., 42 or 3.14.
   - Booleans: true or false.
   - Null: null.

3. Property Arguments:
   - Tagged attributes: Prefixed with a colon ':', e.g., :attr1 "val1" or :attr2 true. Tagged keys are order-independent.
   - Positional attributes: Can be passed sequentially matching catalog signature order.

4. Child Components & Strict Tree Nesting:
   - You MUST nest child components directly inside their parent container expressions, e.g., (ContainerComponent (ChildComponent (PrimitiveComponent "Hello"))).
   - Do NOT output flat adjacency lists, explicit \`:id\` attributes, or separate component variable IDs. Every UI component must be nested directly within a single root tree expression.

5. Data Bindings:
   - Absolute data model paths start with '$/', e.g., $/user/firstName.
   - Relative template item fields start with '$/item_var/field', e.g. $/item/name.

6. Data Model Population:
   - Initialize data model state using (data $/path1 "val1" $/path2 123) or (data $/map_path (:key1 "val1" :key2 "val2")).

7. Dynamic List Templates:
   - List templates use (template :item item (ChildComponent $/item/name)) or (ListComponent :children (template :item item (ChildComponent $/item/name))).

8. Action Events:
   - Actions use (Event "action_name" :param1 $/value). Interactive controls with action attributes MUST provide an action expression, e.g., (ActionComponent :child (ChildComponent "Text") :action (Event "click_action")).

9. Standalone Operations:
   - Delete surface: (deleteSurface "surface_id")
   - Call RPC function: (callFunction "function_name" :arg1 "value1")

10. Syntax Structure Examples (Abstract Grammar):
   Example 1 (Container with Child Nodes & Actions):
   <a2ui>
   (ContainerComponent
     (ChildComponent :title "Header")
     (InputComponent :label "Input" :value $/form/field)
     (ActionComponent :label "Submit" :action (Event "submit_action" :val $/form/field)))
   </a2ui>

   Example 2 (Root Data State & Dynamic Template):
   <a2ui>
   (ContainerComponent
     (data $/items [(:id 1 :name "Item 1")] $/title "List Title")
     (ListComponent :items $/items :template (template item (ChildComponent :title $/item/name))))
   </a2ui>

11. Strict Catalog Adherence & Conciseness:
   - You MUST ONLY use property names listed in the Component Catalog Signatures below.
   - Do NOT invent CSS or style attributes (e.g. style, padding, margin, backgroundColor, color, fontSize, size, minHeight, borderRadius, spacing, align, justify).
   - Output minimal properties required to satisfy the user request.
`;

/**
 * Generates system prompts, grammar instructions, and component catalog
 * signatures for the Atom format.
 */
export class AtomPromptGenerator implements PromptGenerator {
  private readonly helper: CatalogSchemaHelper;

  constructor(catalog: A2uiCatalogSchemas) {
    this.helper = new CatalogSchemaHelper(catalog.catalogSchema);
  }

  generate(options: SystemPromptOptions): string {
    const parts: string[] = [];
    if (options.roleDescription) {
      parts.push(options.roleDescription);
    }

    let rules = ATOM_RULES;
    if (options.workflowDescription) {
      rules += `\n\n${options.workflowDescription}`;
    }
    parts.push(`## Instructions:\n${rules}`);

    if (options.includeSchema ?? true) {
      const compSigs = this.generateComponentSignatures();
      const funcSigs = this.generateFunctionSignatures();
      if (compSigs) {
        parts.push(`## Component Catalog Signatures:\n${compSigs}`);
      }
      if (funcSigs) {
        parts.push(`## Function Signatures:\n${funcSigs}`);
      }
    }

    return parts.join("\n\n");
  }

  /** Compiles component definitions into S-expression signatures. */
  generateComponentSignatures(): string {
    const signatures: string[] = [];
    for (const name of Object.keys(this.helper.componentProperties).sort()) {
      const props = this.helper.getComponentProperties(name);
      const reqs = this.helper.getComponentRequired(name);
      const compDesc = this.helper.getComponentDescription(name);

      const orderedArgs: string[] = [];
      const propDetails: string[] = [];
      for (const p of props) {
        if (p === "id" || p === "component") continue;
        const optSuffix = reqs.includes(p) ? "" : "?";
        const propSchema = this.helper.getPropertySchema(name, p);

        orderedArgs.push(`:${p}${optSuffix}`);

        const propDesc =
          propSchema && typeof propSchema["description"] === "string"
            ? propSchema["description"]
            : null;
        const enumVals = findSchemaEnum(propSchema ?? undefined);

        if (propDesc || enumVals) {
          const lineParts: string[] = [];
          if (propDesc) lineParts.push(propDesc);
          if (enumVals) {
            const enumValsStr = enumVals
              .map((v) => `'${String(v)}'`)
              .join(", ");
            lineParts.push(`Must be one of: ${enumValsStr}`);
          }
          propDetails.push(`  - :${p}: ${lineParts.join(" ")}`);
        }
      }

      let sig = `- (${name} ${orderedArgs.join(" ")})`;
      if (compDesc) {
        sig += `\n  - ${compDesc}`;
      }
      if (propDetails.length > 0) {
        sig += `\n${propDetails.join("\n")}`;
      }
      signatures.push(sig);
    }
    return signatures.join("\n");
  }

  /** Compiles function definitions into S-expression signatures. */
  generateFunctionSignatures(): string {
    const signatures: string[] = [];
    for (const name of Object.keys(this.helper.functionProperties).sort()) {
      const props = this.helper.getFunctionProperties(name);
      const reqs = this.helper.getFunctionRequired(name);
      const funcDesc = this.helper.getFunctionDescription(name);

      const orderedArgs: string[] = [];
      const propDetails: string[] = [];
      for (const p of props) {
        const optSuffix = reqs.includes(p) ? "" : "?";
        // Mirrors the Python implementation, which resolves function argument
        // schemas through the component property crawler (usually null here).
        const propSchema = this.helper.getPropertySchema(name, p);

        orderedArgs.push(`:${p}${optSuffix}`);

        const propDesc =
          propSchema && typeof propSchema["description"] === "string"
            ? propSchema["description"]
            : null;
        const enumVals = findSchemaEnum(propSchema ?? undefined);

        if (propDesc || enumVals) {
          const lineParts: string[] = [];
          if (propDesc) lineParts.push(propDesc);
          if (enumVals) {
            const enumValsStr = enumVals
              .map((v) => `'${String(v)}'`)
              .join(", ");
            lineParts.push(`Must be one of: ${enumValsStr}`);
          }
          propDetails.push(`  - :${p}: ${lineParts.join(" ")}`);
        }
      }

      let sig = `- (${name} ${orderedArgs.join(" ")})`;
      if (funcDesc) {
        sig += `\n  - ${funcDesc}`;
      }
      if (propDetails.length > 0) {
        sig += `\n${propDetails.join("\n")}`;
      }
      signatures.push(sig);
    }
    return signatures.join("\n");
  }
}
