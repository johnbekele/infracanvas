/**
 * The two failures every tool shares.
 *
 * A wrong owner and an unknown id are the same error deliberately: telling the
 * caller apart would confirm that an experiment it cannot read exists, which is
 * the whole of what a guessed UUID would otherwise buy.
 */

export class ExperimentNotFoundError extends Error {
  constructor(experimentId: string) {
    super(`No experiment ${experimentId}`);
    this.name = 'ExperimentNotFoundError';
  }
}

/** The turn's tool call ceiling. Raised by the runtime, never by a tool. */
export class ToolBudgetExceededError extends Error {
  constructor(limit: number) {
    super(`A turn may make at most ${limit} tool calls`);
    this.name = 'ToolBudgetExceededError';
  }
}

/** An argument model rejected its input. Returned to the model as text, not a stack. */
export class ToolArgumentError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'ToolArgumentError';
    this.field = field;
  }
}
