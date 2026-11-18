// Ported from agent-tower public/modules/answer.mjs (commit 3520192).
// Answering a held permission request in the panel: the logic without the DOM.
// Imports nothing.

/** How long the answer controls ignore clicks after they appeared or moved. A click that was
 *  already on its way when the list shifted must not allow a command. */
export const ARM_MS = 500;

/** The requests the server holds for an agent. Older servers and subagent figures have none. */
export function requestsOf(agent) {
  return Array.isArray(agent?.requests) ? agent.requests : [];
}

/**
 * The selection after a click on option `index` of question `q`. `choices` holds one array
 * of option indices per question (undefined: nothing picked yet). A single choice takes the
 * clicked option; a multiple choice adds or removes it and stays sorted.
 */
export function toggleChoice(questions, choices, q, index) {
  const next = questions.map((_, k) => [...(choices?.[k] ?? [])]);
  if (!questions[q].multiSelect) next[q] = [index];
  else if (next[q].includes(index)) next[q] = next[q].filter((i) => i !== index);
  else next[q] = [...next[q], index].sort((a, b) => a - b);
  return next;
}

/** Whether every question has what it needs: exactly one option, or at least one for a
 *  multiple choice. */
export function choicesComplete(questions, choices) {
  return questions.every((question, k) => {
    const picked = choices?.[k] ?? [];
    return question.multiSelect ? picked.length >= 1 : picked.length === 1;
  });
}

/** One string for where the answer controls are: it changes when a block appears, leaves or
 *  moves, when the panel's height changes or it shows another field. */
export function layoutSignature({ hexId, height, blocks }) {
  return JSON.stringify([hexId, height, blocks.map((b) => [b.id, b.top])]);
}
