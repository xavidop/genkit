import { InvalidArgumentError, Command } from 'commander';
import { logger } from '../utils/logger';
import { startRunner, waitForFlowToComplete } from '../utils/runner-utils';
import { FlowInvokeEnvelopeMessage, FlowState } from '../types/flow';
import { writeFile, readFile } from 'fs/promises';
import { SpanData } from '../types/trace';
import { Runner } from '../runner/runner';

// TODO: Support specifying waiting or streaming
interface EvalFlowRunOptions {
  input?: string;
  output?: string;
}
/** Command to run a flow and evaluate the output */
export const evalFlowRun = new Command('eval:flow')
  .argument('<flowName>', 'Name of the flow to run')
  .argument('[data]', 'JSON data to use to start the flow')
  .option('--input <filename>', 'JSON batch data to use to run the flow')
  .option(
    '--output <filename>',
    'Name of the output file to write evaluation results'
  )
  .action(
    async (flowName: string, data: string, options: EvalFlowRunOptions) => {
      const runner = await startRunner();

      try {
        const evaluatorActions = Object.keys(await runner.listActions()).filter(
          (name) => name.startsWith('/evaluator')
        );
        if (!evaluatorActions) {
          logger.error('No evaluators installed');
          return;
        }

        if (!data && !options.input) {
          logger.error(
            'No input data passed. Specify input data using [data] argument or --input <filename> option'
          );
          return;
        }

        const parsedData = await readInputs(data, options.input!);

        const states = await runFlows(runner, flowName, parsedData);

        const errors = states
          .filter((s) => s.operation.result?.error)
          .map((s) => s.operation.result?.error);
        if (errors.length > 0) {
          logger.error('Some flows failed with the following errors');
          logger.error(errors);
          return;
        }

        const dataset = await fetchDataSet(runner, flowName, states);

        const results: Record<string, any> = {};
        await Promise.all(
          evaluatorActions.map(async (e) => {
            logger.info(`Running evaluator '${e}'...`);
            const response = await runner.runAction({
              key: e,
              input: {
                dataset,
              },
            });
            results[e] = response;
          })
        );

        if (options.output) {
          logger.info(`Writing results to '${options.output}'...`);
          await writeFile(
            options.output,
            JSON.stringify(results, undefined, '  ')
          );
        } else {
          console.log(JSON.stringify(results, undefined, '  '));
        }
      } finally {
        await runner.stop();
      }
    }
  );

async function readInputs(data: string, filePath: string): Promise<any[]> {
  const parsedData = JSON.parse(
    data ? data : await readFile(filePath!, 'utf8')
  );
  if (Array.isArray(parsedData)) {
    return parsedData as any[];
  }

  return [parsedData];
}

async function runFlows(
  runner: Runner,
  flowName: string,
  data: any[]
): Promise<FlowState[]> {
  const states: FlowState[] = [];

  for (const d of data) {
    logger.info(`Running '/flow/${flowName}' ...`);
    var state = (await runner.runAction({
      key: `/flow/${flowName}`,
      input: {
        start: {
          input: d,
        },
      } as FlowInvokeEnvelopeMessage,
    })) as FlowState;

    if (!state.operation.done) {
      logger.info('Started flow run, waiting for it to complete...');
      state = await waitForFlowToComplete(runner, flowName, state.flowId);
    }

    logger.info(
      'Flow operation:\n' + JSON.stringify(state.operation, undefined, '  ')
    );

    states.push(state);
  }

  return states;
}

async function fetchDataSet(
  runner: Runner,
  flowName: string,
  states: FlowState[]
) {
  return await Promise.all(
    states.map(async (s) => {
      const traceIds = s.executions.flatMap((e) => e.traceIds);

      const traces = await Promise.all(
        traceIds.map(async (traceId) =>
          runner.getTrace({
            // TODO: We should consider making this a argument and using it to
            // to control which tracestore environment is being used when
            // running a flow.
            env: 'dev',
            traceId,
          })
        )
      );

      var rootSpan: SpanData | undefined = undefined;
      var retrievers: SpanData[] = [];
      for (const trace of traces) {
        const tempRootSpan = Object.values(trace.spans).find(
          (s) =>
            s.attributes['genkit:type'] === 'flow' &&
            s.attributes['genkit:metadata:flow:name'] === flowName &&
            s.attributes['genkit:metadata:flow:state'] === 'done'
        );

        if (tempRootSpan) {
          rootSpan = tempRootSpan;
        }

        retrievers.push(
          ...Object.values(trace.spans).filter(
            (s) => s.attributes['genkit:metadata:subtype'] === 'retriever'
          )
        );
      }

      if (retrievers.length > 1) {
        logger.warn('The flow contains multiple retrieve actions.');
      }

      const context = retrievers.flatMap((s) => {
        const output = JSON.parse(s.attributes['genkit:output'] as string);
        if (!Array.isArray(output)) {
          return [];
        }
        return output.map((d: { content: string }) => d.content);
      });

      if (!rootSpan) {
        // TODO: Handle error case
      }

      return {
        input: rootSpan!.attributes['genkit:input'],
        output: rootSpan!.attributes['genkit:output'],
        context,
      };
    })
  );
}