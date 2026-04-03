/**
 * Console Panel tests — Runtime.evaluate, console events
 */

export const suite = {
  name: 'Console',
  setup: async (cdp) => {
    await cdp.send('Runtime.enable').catch(() => {});
    await cdp.send('Console.enable').catch(() => {});
    await new Promise(r => setTimeout(r, 500));
  },
  tests: [
    {
      id: 'runtime-evaluate-primitive',
      label: 'Runtime.evaluate returns primitive',
      run: async (cdp) => {
        const result = await cdp.send('Runtime.evaluate', {
          expression: '2 + 2',
          returnByValue: true,
        });
        return {
          type: result.result?.type,
          value: result.result?.value,
        };
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'type': 'number', 'value': 4 },
      },
    },
    {
      id: 'runtime-evaluate-string',
      label: 'Runtime.evaluate returns string',
      run: async (cdp) => {
        const result = await cdp.send('Runtime.evaluate', {
          expression: '"hello" + " world"',
          returnByValue: true,
        });
        return {
          type: result.result?.type,
          value: result.result?.value,
        };
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'type': 'string', 'value': 'hello world' },
      },
    },
    {
      id: 'runtime-evaluate-object',
      label: 'Runtime.evaluate returns object with objectId',
      run: async (cdp) => {
        const result = await cdp.send('Runtime.evaluate', {
          expression: '({foo: "bar", num: 42})',
        });
        return {
          type: result.result?.type,
          hasObjectId: !!result.result?.objectId,
          subtype: result.result?.subtype || 'none',
          className: result.result?.className,
        };
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'type': 'object', 'hasObjectId': true },
      },
    },
    {
      id: 'runtime-evaluate-error',
      label: 'Runtime.evaluate returns exception details',
      run: async (cdp) => {
        const result = await cdp.send('Runtime.evaluate', {
          expression: 'throw new Error("test error")',
        });
        return {
          hasException: !!result.exceptionDetails,
          hasText: !!result.exceptionDetails?.text,
        };
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'hasException': true },
      },
    },
    {
      id: 'runtime-getProperties',
      label: 'Runtime.getProperties returns own properties',
      run: async (cdp) => {
        const obj = await cdp.send('Runtime.evaluate', {
          expression: '({a: 1, b: "hello", c: [1,2,3]})',
        });
        const props = await cdp.send('Runtime.getProperties', {
          objectId: obj.result.objectId,
          ownProperties: true,
        });
        const names = (props.result || []).map(p => p.name).filter(n => !n.startsWith('__'));
        const hasA = (props.result || []).find(p => p.name === 'a');
        return {
          count: props.result?.length || 0,
          names: names.sort(),
          aType: hasA?.value?.type,
          aValue: hasA?.value?.value,
        };
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'aType': 'number', 'aValue': 1 },
      },
    },
    {
      id: 'runtime-getProperties-deep',
      label: 'Runtime.getProperties deep nesting',
      run: async (cdp) => {
        const obj = await cdp.send('Runtime.evaluate', {
          expression: '({nested: {deep: {value: 42}}})',
        });
        const level1 = await cdp.send('Runtime.getProperties', {
          objectId: obj.result.objectId,
          ownProperties: true,
        });
        const nested = level1.result?.find(p => p.name === 'nested');
        if (!nested?.value?.objectId) return { canExpand: false };
        const level2 = await cdp.send('Runtime.getProperties', {
          objectId: nested.value.objectId,
          ownProperties: true,
        });
        const deep = level2.result?.find(p => p.name === 'deep');
        if (!deep?.value?.objectId) return { canExpand: false, level2: true };
        const level3 = await cdp.send('Runtime.getProperties', {
          objectId: deep.value.objectId,
          ownProperties: true,
        });
        const valueP = level3.result?.find(p => p.name === 'value');
        return {
          canExpand: true,
          finalValue: valueP?.value?.value,
        };
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'canExpand': true, 'finalValue': 42 },
      },
    },
    {
      id: 'runtime-callFunctionOn',
      label: 'Runtime.callFunctionOn works',
      run: async (cdp) => {
        const obj = await cdp.send('Runtime.evaluate', {
          expression: '({x: 10, y: 20})',
        });
        const result = await cdp.send('Runtime.callFunctionOn', {
          objectId: obj.result.objectId,
          functionDeclaration: 'function() { return this.x + this.y; }',
          returnByValue: true,
        });
        return {
          type: result.result?.type,
          value: result.result?.value,
        };
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'type': 'number', 'value': 30 },
      },
    },
    {
      id: 'console-log-event',
      label: 'console.log → Runtime.consoleAPICalled',
      run: async (cdp) => {
        cdp.clearEvents();
        const marker = `__diff_log_${Date.now()}`;
        await cdp.send('Runtime.evaluate', {
          expression: `console.log("${marker}")`,
        });
        await new Promise(r => setTimeout(r, 2000));
        const events = cdp.drainEvents('Runtime.consoleAPICalled')
          .filter(e => JSON.stringify(e.params).includes(marker));
        if (events.length === 0) return { received: false };
        return {
          received: true,
          type: events[0].params.type,
          hasArgs: (events[0].params.args?.length || 0) > 0,
        };
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'received': true, 'type': 'log' },
      },
    },
    {
      id: 'console-warn-event',
      label: 'console.warn type correctness',
      run: async (cdp) => {
        cdp.clearEvents();
        const marker = `__diff_warn_${Date.now()}`;
        await cdp.send('Runtime.evaluate', {
          expression: `console.warn("${marker}")`,
        });
        await new Promise(r => setTimeout(r, 2000));
        const events = cdp.drainEvents('Runtime.consoleAPICalled')
          .filter(e => JSON.stringify(e.params).includes(marker));
        return {
          received: events.length > 0,
          type: events[0]?.params?.type,
        };
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'received': true, 'type': 'warning' },
      },
    },
    {
      id: 'console-error-event',
      label: 'console.error type correctness',
      run: async (cdp) => {
        cdp.clearEvents();
        const marker = `__diff_err_${Date.now()}`;
        await cdp.send('Runtime.evaluate', {
          expression: `console.error("${marker}")`,
        });
        await new Promise(r => setTimeout(r, 2000));
        const events = cdp.drainEvents('Runtime.consoleAPICalled')
          .filter(e => JSON.stringify(e.params).includes(marker));
        return {
          received: events.length > 0,
          type: events[0]?.params?.type,
        };
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'received': true, 'type': 'error' },
      },
    },
    {
      id: 'runtime-evaluate-awaitPromise',
      label: 'Runtime.evaluate with awaitPromise resolves async',
      run: async (cdp) => {
        const result = await cdp.send('Runtime.evaluate', {
          expression: `new Promise(resolve => setTimeout(() => resolve(42), 100))`,
          awaitPromise: true,
          returnByValue: true,
        });
        return {
          type: result.result?.type,
          value: result.result?.value,
          noException: !result.exceptionDetails,
        };
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'type': 'number', 'value': 42, 'noException': true },
      },
    },
    {
      id: 'runtime-evaluate-array',
      label: 'Runtime.evaluate returns array with objectId',
      run: async (cdp) => {
        const result = await cdp.send('Runtime.evaluate', {
          expression: `[1, "two", 3, {four: 4}]`,
        });
        return {
          type: result.result?.type,
          subtype: result.result?.subtype,
          hasObjectId: !!result.result?.objectId,
          className: result.result?.className,
          description: result.result?.description,
        };
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'type': 'object', 'subtype': 'array', 'hasObjectId': true },
      },
    },
    {
      id: 'runtime-getProperties-array',
      label: 'Runtime.getProperties returns array index properties',
      run: async (cdp) => {
        const arr = await cdp.send('Runtime.evaluate', {
          expression: `["apple", "banana", "cherry"]`,
        });
        const props = await cdp.send('Runtime.getProperties', {
          objectId: arr.result.objectId,
          ownProperties: true,
        });
        const indexProps = (props.result || []).filter(p => /^\d+$/.test(p.name));
        const lengthProp = (props.result || []).find(p => p.name === 'length');
        const firstItem = indexProps.find(p => p.name === '0');
        return {
          hasIndexProps: indexProps.length > 0,
          indexCount: indexProps.length,
          hasLength: !!lengthProp,
          lengthValue: lengthProp?.value?.value,
          firstValue: firstItem?.value?.value,
        };
      },
      compare: {
        deepCompare: false,
        valueAssertions: {
          'hasIndexProps': true,
          'indexCount': 3,
          'hasLength': true,
          'lengthValue': 3,
          'firstValue': 'apple',
        },
      },
    },
    {
      id: 'runtime-evaluate-returnByValue-nested',
      label: 'Runtime.evaluate returnByValue with nested objects',
      run: async (cdp) => {
        const result = await cdp.send('Runtime.evaluate', {
          expression: `({a: {b: {c: "deep"}}, arr: [1, {x: 2}]})`,
          returnByValue: true,
        });
        const val = result.result?.value;
        return {
          type: result.result?.type,
          hasValue: !!val,
          deepValue: val?.a?.b?.c,
          arrLength: val?.arr?.length,
          nestedInArr: val?.arr?.[1]?.x,
        };
      },
      compare: {
        deepCompare: false,
        valueAssertions: {
          'type': 'object',
          'hasValue': true,
          'deepValue': 'deep',
          'arrLength': 2,
          'nestedInArr': 2,
        },
      },
    },
  ],
};
