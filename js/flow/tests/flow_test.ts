/**
 * Copyright 2024 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { FlowState } from '@genkit-ai/common';
import { __hardResetConfigForTesting } from '@genkit-ai/common/config';
import { __hardResetRegistryForTesting } from '@genkit-ai/common/registry';
import assert from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import { z } from 'zod';
import { flow, runFlow } from '../src/flow';
import { configureInMemoryStateStore } from './testUtil';

function createTestFlow() {
  return flow(
    {
      name: 'testFlow',
      input: z.string(),
      output: z.string(),
    },
    async (input) => {
      return `bar ${input}`;
    }
  );
}

describe('flow', () => {
  beforeEach(__hardResetRegistryForTesting);
  beforeEach(() => {
    __hardResetConfigForTesting();
    delete process.env.GENKIT_ENV;
  });

  describe('runFlow', () => {
    it('should run the flow', async () => {
      configureInMemoryStateStore('prod');
      const testFlow = createTestFlow();

      const result = await runFlow(testFlow, 'foo');

      assert.equal(result, 'bar foo');
    });

    it('should rethrow the error', async () => {
      configureInMemoryStateStore('prod');
      const testFlow = flow(
        {
          name: 'throwing',
          input: z.string(),
          output: z.string(),
        },
        async (input) => {
          throw new Error(`bad happened: ${input}`);
        }
      );

      await assert.rejects(async () => await runFlow(testFlow, 'foo'), {
        name: 'Error',
        message: 'bad happened: foo',
      });
    });

    it('should validate input', async () => {
      configureInMemoryStateStore('prod');
      const testFlow = flow(
        {
          name: 'validating',
          input: z.object({ foo: z.string(), bar: z.number() }),
          output: z.string(),
        },
        async (input) => {
          return `ok ${input}`;
        }
      );

      await assert.rejects(
        async () => await runFlow(testFlow, { foo: 'foo', bar: 'bar' } as any),
        (err: Error) => {
          assert.strictEqual(err.name, 'ZodError');
          assert.equal(
            err.message.includes('Expected number, received string'),
            true
          );
          return true;
        }
      );
    });
  });

  describe('stateStore', () => {
    describe('dev', () => {
      beforeEach(() => {
        process.env.GENKIT_ENV = 'dev';
      });

      it('should persist state in dev', async () => {
        const stateStore = configureInMemoryStateStore('dev');
        const testFlow = createTestFlow();

        const result = await runFlow(testFlow, 'foo');

        assert.equal(result, 'bar foo');
        assert.equal(Object.keys(stateStore.state).length, 1);

        // do some asserting on the state... TODO: make this better.
        const state = JSON.parse(
          Object.values(stateStore.state)[0]
        ) as FlowState;
        assert.equal(state.executions.length, 1);
        assert.equal(state.operation.done, true);
        assert.deepEqual(state.operation.result, {
          response: 'bar foo',
        });
        assert.equal(state.blockedOnStep, null);
        assert.deepEqual(state.eventsTriggered, {});
        assert.deepEqual(state.cache, {});
        assert.equal(state.input, 'foo');
        assert.equal(state.name, 'testFlow');
      });
    });

    describe('prod', () => {
      it('should not persist the state for non-durable flow', async () => {
        const stateStore = configureInMemoryStateStore('prod');
        const testFlow = createTestFlow();

        const result = await runFlow(testFlow, 'foo');

        assert.equal(result, 'bar foo');
        assert.equal(Object.keys(stateStore.state).length, 0);
      });
    });
  });
});