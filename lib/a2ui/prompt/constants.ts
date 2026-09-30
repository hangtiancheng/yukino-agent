/**
 * Constants shared by the A2UI prompt generators.
 *
 * Ported from `a2ui/schema/constants.py` in the A2UI Python agent SDK.
 */

export const A2UI_OPEN_TAG = "<a2ui-json>";
export const A2UI_CLOSE_TAG = "</a2ui-json>";

export const A2UI_INFERENCE_OPEN_TAG = "<a2ui>";
export const A2UI_INFERENCE_CLOSE_TAG = "</a2ui>";

export const A2UI_SCHEMA_BLOCK_START = "---BEGIN A2UI JSON SCHEMA---";
export const A2UI_SCHEMA_BLOCK_END = "---END A2UI JSON SCHEMA---";

export const DEFAULT_WORKFLOW_RULES = `
The generated response MUST follow these rules:
- The response can contain one or more A2UI JSON blocks.
- Each A2UI JSON block MUST be wrapped in \`${A2UI_OPEN_TAG}\` and \`${A2UI_CLOSE_TAG}\` tags.
- Between or around these blocks, you can provide conversational text.
- The JSON part MUST be a single, raw JSON object (usually a list of A2UI messages) and MUST validate against the provided A2UI JSON SCHEMA.
- Top-Down Component Ordering: Within the \`components\` list of a message:
    - The 'root' component MUST be the FIRST element.
    - Parent components MUST appear before their child components.
    This specific ordering allows the streaming parser to yield and render the UI incrementally as it arrives.
`;
