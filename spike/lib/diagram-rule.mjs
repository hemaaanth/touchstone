// One rule for every agent of a run: the root agent, the fleet coordinator and
// each fleet child (they all start from the same instructions, agent-run.mjs),
// and so also a follow-up, which reopens the same session.
//
// The console draws a fenced `mermaid` block as a diagram
// (app/src/components/mermaid-block.tsx). No tool is needed: the fence is plain
// text, so a record, an export or a replay bundle carries it as text.
export const DIAGRAM_RULE = `

## Diagrams

When a flow is clearer as a picture (requests between hosts, the calls of an exploit, where assets move), you may add one fenced \`mermaid\` block to your answer: a flowchart or a sequenceDiagram. Keep it small, with plain labels and no style or colour lines. Write the normal text as well. A diagram never replaces evidence: the proof and the tool output are the evidence.`;
