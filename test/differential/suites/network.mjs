/**
 * Network Panel tests
 */

export const suite = {
  name: 'Network',
  setup: async (cdp) => {
    await cdp.send('Network.enable').catch(() => {});
    await cdp.send('Page.enable').catch(() => {});
    await cdp.send('Runtime.enable').catch(() => {});
    await new Promise(r => setTimeout(r, 500));
  },
  tests: [
    {
      id: 'network-requestWillBeSent',
      label: 'Network.requestWillBeSent event on fetch',
      run: async (cdp) => {
        cdp.clearEvents();
        const t = Date.now();
        await cdp.send('Runtime.evaluate', {
          expression: `fetch("/__fixtures/fixture.json?_t=${t}").then(r => r.text())`,
        });
        await new Promise(r => setTimeout(r, 3000));
        const events = cdp.drainEvents('Network.requestWillBeSent')
          .filter(e => e.params?.request?.url?.includes(`_t=${t}`));
        if (events.length === 0) return { received: false };
        const evt = events[0].params;
        return {
          received: true,
          hasRequestId: !!evt.requestId,
          hasUrl: !!evt.request?.url,
          hasMethod: !!evt.request?.method,
          hasTimestamp: typeof evt.timestamp === 'number',
        };
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'received': true, 'hasRequestId': true, 'hasUrl': true },
      },
    },
    {
      id: 'network-responseReceived',
      label: 'Network.responseReceived event',
      run: async (cdp) => {
        cdp.clearEvents();
        const t = Date.now();
        await cdp.send('Runtime.evaluate', {
          expression: `fetch("/__fixtures/fixture.json?_t=${t}").then(r => r.text())`,
        });
        await new Promise(r => setTimeout(r, 3000));
        const events = cdp.drainEvents('Network.responseReceived');
        if (events.length === 0) return { received: false };
        const evt = events[0].params;
        return {
          received: true,
          hasRequestId: !!evt.requestId,
          hasResponse: !!evt.response,
          hasStatus: typeof evt.response?.status === 'number',
          hasHeaders: !!evt.response?.headers,
          hasMimeType: !!evt.response?.mimeType,
        };
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'received': true, 'hasResponse': true, 'hasStatus': true },
      },
    },
    {
      id: 'network-loadingFinished',
      label: 'Network.loadingFinished event',
      run: async (cdp) => {
        cdp.clearEvents();
        const t = Date.now();
        await cdp.send('Runtime.evaluate', {
          expression: `fetch("/__fixtures/fixture.json?_t=${t}").then(r => r.text())`,
        });
        await new Promise(r => setTimeout(r, 3000));
        const events = cdp.drainEvents('Network.loadingFinished');
        if (events.length === 0) return { received: false };
        const evt = events[0].params;
        return {
          received: true,
          hasRequestId: !!evt.requestId,
          hasTimestamp: typeof evt.timestamp === 'number',
          hasEncodedDataLength: typeof evt.encodedDataLength === 'number',
        };
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'received': true, 'hasRequestId': true },
      },
    },
    {
      id: 'network-getResponseBody',
      label: 'Network.getResponseBody returns content',
      run: async (cdp) => {
        cdp.clearEvents();
        const t = Date.now();
        await cdp.send('Runtime.evaluate', {
          expression: `fetch("/__fixtures/fixture.json?_t=${t}").then(r => r.text())`,
        });
        await new Promise(r => setTimeout(r, 3000));
        const finished = cdp.drainEvents('Network.loadingFinished');
        if (finished.length === 0) return { hasBody: false, error: 'no loadingFinished event' };
        try {
          const body = await cdp.send('Network.getResponseBody', { requestId: finished[0].params.requestId });
          return {
            hasBody: !!body.body,
            length: body.body?.length || 0,
            base64Encoded: body.base64Encoded,
          };
        } catch (err) {
          return { hasBody: false, error: err.message };
        }
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'hasBody': true },
      },
    },
    {
      id: 'network-loadingFailed',
      label: 'Network.loadingFailed on 404',
      run: async (cdp) => {
        cdp.clearEvents();
        const t = Date.now();
        await cdp.send('Runtime.evaluate', {
          expression: `fetch("/__nonexistent_${t}").catch(() => {})`,
        });
        await new Promise(r => setTimeout(r, 3000));
        // A 404 might come as responseReceived with 404 status rather than loadingFailed
        const failed = cdp.drainEvents('Network.loadingFailed');
        const responses = cdp.drainEvents('Network.responseReceived')
          .filter(e => e.params?.response?.status === 404);
        return {
          hasFailed: failed.length > 0,
          has404Response: responses.length > 0,
          hasEither: failed.length > 0 || responses.length > 0,
        };
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'hasEither': true },
      },
    },
    {
      id: 'page-getResourceContent',
      label: 'Page.getResourceContent returns page HTML',
      run: async (cdp) => {
        const tree = await cdp.send('Page.getResourceTree');
        const frameId = tree.frameTree?.frame?.id;
        const url = tree.frameTree?.frame?.url;
        if (!frameId || !url) return { hasContent: false, error: 'no frame' };
        try {
          const result = await cdp.send('Page.getResourceContent', { frameId, url });
          return {
            hasContent: !!result.content,
            length: result.content?.length || 0,
            base64Encoded: result.base64Encoded,
          };
        } catch (err) {
          return { hasContent: false, error: err.message };
        }
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'hasContent': true },
      },
    },
    {
      id: 'network-response-headers',
      label: 'Network response has non-empty headers',
      run: async (cdp) => {
        cdp.clearEvents();
        const t = Date.now();
        await cdp.send('Runtime.evaluate', {
          expression: `fetch("/__fixtures/fixture.json?_t=${t}").then(r => r.text())`,
        });
        await new Promise(r => setTimeout(r, 3000));
        const responses = cdp.drainEvents('Network.responseReceived')
          .filter(e => e.params?.response?.url?.includes(`_t=${t}`));
        if (responses.length === 0) return { received: false };
        const resp = responses[0].params.response;
        const headers = resp.headers || {};
        const headerKeys = Object.keys(headers);
        return {
          received: true,
          hasHeaders: headerKeys.length > 0,
          headerCount: headerKeys.length,
          hasContentType: !!headers['content-type'] || !!headers['Content-Type'],
          hasMimeType: !!resp.mimeType,
          statusCode: resp.status,
        };
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'received': true, 'hasHeaders': true, 'statusCode': 200 },
      },
    },
    {
      id: 'network-request-headers',
      label: 'Network request has non-empty headers',
      run: async (cdp) => {
        cdp.clearEvents();
        const t = Date.now();
        await cdp.send('Runtime.evaluate', {
          expression: `fetch("/__fixtures/fixture.json?_t=${t}").then(r => r.text())`,
        });
        await new Promise(r => setTimeout(r, 3000));
        const requests = cdp.drainEvents('Network.requestWillBeSent')
          .filter(e => e.params?.request?.url?.includes(`_t=${t}`));
        if (requests.length === 0) return { received: false };
        const req = requests[0].params.request;
        const headers = req.headers || {};
        const headerKeys = Object.keys(headers);
        return {
          received: true,
          hasHeaders: headerKeys.length > 0,
          headerCount: headerKeys.length,
          method: req.method,
        };
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'received': true, 'hasHeaders': true, 'method': 'GET' },
      },
    },
    {
      id: 'network-timing-data',
      label: 'Network response has timing data',
      run: async (cdp) => {
        cdp.clearEvents();
        const t = Date.now();
        await cdp.send('Runtime.evaluate', {
          expression: `fetch("/__fixtures/fixture.json?_t=${t}").then(r => r.text())`,
        });
        await new Promise(r => setTimeout(r, 3000));
        const responses = cdp.drainEvents('Network.responseReceived')
          .filter(e => e.params?.response?.url?.includes(`_t=${t}`));
        if (responses.length === 0) return { received: false };
        const timing = responses[0].params.response.timing;
        return {
          received: true,
          hasTiming: !!timing,
          hasRequestTime: typeof timing?.requestTime === 'number',
          hasSendStart: typeof timing?.sendStart === 'number',
          hasReceiveHeadersEnd: typeof timing?.receiveHeadersEnd === 'number',
        };
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'received': true, 'hasTiming': true },
      },
    },
    {
      id: 'network-dataReceived',
      label: 'Network.dataReceived event has dataLength',
      run: async (cdp) => {
        cdp.clearEvents();
        const t = Date.now();
        await cdp.send('Runtime.evaluate', {
          expression: `fetch("/__fixtures/fixture.json?_t=${t}").then(r => r.text())`,
        });
        await new Promise(r => setTimeout(r, 3000));
        const dataEvents = cdp.drainEvents('Network.dataReceived');
        if (dataEvents.length === 0) return { received: false };
        const evt = dataEvents[0].params;
        return {
          received: true,
          hasRequestId: !!evt.requestId,
          hasTimestamp: typeof evt.timestamp === 'number',
          hasDataLength: typeof evt.dataLength === 'number',
          dataLengthPositive: (evt.dataLength || 0) > 0,
        };
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'received': true, 'hasRequestId': true, 'hasDataLength': true },
      },
    },
  ],
};
