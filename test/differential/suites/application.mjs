/**
 * Application Panel tests — DOMStorage, IndexedDB, Cookies
 */

export const suite = {
  name: 'Application',
  setup: async (cdp) => {
    await cdp.send('Runtime.enable').catch(() => {});
    await cdp.send('DOMStorage.enable').catch(() => {});
    await cdp.send('IndexedDB.enable').catch(() => {});
    // Set up test data
    await cdp.send('Runtime.evaluate', {
      expression: `
        localStorage.setItem('__diff_test_key', '__diff_test_value');
        sessionStorage.setItem('__diff_session_key', '__diff_session_value');
      `,
    });
    await new Promise(r => setTimeout(r, 500));
  },
  teardown: async (cdp) => {
    await cdp.send('Runtime.evaluate', {
      expression: `
        localStorage.removeItem('__diff_test_key');
        sessionStorage.removeItem('__diff_session_key');
      `,
    }).catch(() => {});
  },
  tests: [
    {
      id: 'storage-localStorage-get',
      label: 'DOMStorage.getDOMStorageItems (localStorage)',
      run: async (cdp) => {
        try {
          // Get the security origin
          const tree = await cdp.send('Page.getResourceTree').catch(() => null);
          const origin = tree?.frameTree?.frame?.securityOrigin || '';
          const result = await cdp.send('DOMStorage.getDOMStorageItems', {
            storageId: { securityOrigin: origin, isLocalStorage: true },
          });
          const items = result.entries || [];
          const testItem = items.find(([k]) => k === '__diff_test_key');
          return {
            hasItems: items.length > 0,
            count: items.length,
            hasTestItem: !!testItem,
            testValue: testItem?.[1],
          };
        } catch (err) {
          return { hasItems: false, error: err.message };
        }
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'hasTestItem': true, 'testValue': '__diff_test_value' },
      },
    },
    {
      id: 'storage-localStorage-set',
      label: 'DOMStorage.setDOMStorageItem',
      run: async (cdp) => {
        try {
          const tree = await cdp.send('Page.getResourceTree').catch(() => null);
          const origin = tree?.frameTree?.frame?.securityOrigin || '';
          await cdp.send('DOMStorage.setDOMStorageItem', {
            storageId: { securityOrigin: origin, isLocalStorage: true },
            key: '__diff_set_key',
            value: '__diff_set_value',
          });
          // Verify via Runtime
          const check = await cdp.send('Runtime.evaluate', {
            expression: `localStorage.getItem('__diff_set_key')`,
            returnByValue: true,
          });
          // Cleanup
          await cdp.send('Runtime.evaluate', {
            expression: `localStorage.removeItem('__diff_set_key')`,
          });
          return { set: check.result?.value === '__diff_set_value' };
        } catch (err) {
          return { set: false, error: err.message };
        }
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'set': true },
      },
    },
    {
      id: 'storage-localStorage-remove',
      label: 'DOMStorage.removeDOMStorageItem',
      run: async (cdp) => {
        try {
          // Set then remove
          await cdp.send('Runtime.evaluate', {
            expression: `localStorage.setItem('__diff_remove_key', 'val')`,
          });
          const tree = await cdp.send('Page.getResourceTree').catch(() => null);
          const origin = tree?.frameTree?.frame?.securityOrigin || '';
          await cdp.send('DOMStorage.removeDOMStorageItem', {
            storageId: { securityOrigin: origin, isLocalStorage: true },
            key: '__diff_remove_key',
          });
          const check = await cdp.send('Runtime.evaluate', {
            expression: `localStorage.getItem('__diff_remove_key')`,
            returnByValue: true,
          });
          return { removed: check.result?.value === null };
        } catch (err) {
          return { removed: false, error: err.message };
        }
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'removed': true },
      },
    },
    {
      id: 'indexeddb-requestDatabaseNames',
      label: 'IndexedDB.requestDatabaseNames',
      run: async (cdp) => {
        try {
          // Create a test database first
          await cdp.send('Runtime.evaluate', {
            expression: `
              new Promise((resolve) => {
                const req = indexedDB.open('__diff_test_db', 1);
                req.onupgradeneeded = (e) => {
                  e.target.result.createObjectStore('testStore');
                };
                req.onsuccess = () => { req.result.close(); resolve(); };
                req.onerror = () => resolve();
              })
            `,
            awaitPromise: true,
          });
          const tree = await cdp.send('Page.getResourceTree').catch(() => null);
          const origin = tree?.frameTree?.frame?.securityOrigin || '';
          const result = await cdp.send('IndexedDB.requestDatabaseNames', {
            securityOrigin: origin,
          });
          const hasTestDb = (result.databaseNames || []).includes('__diff_test_db');
          // Cleanup
          await cdp.send('Runtime.evaluate', {
            expression: `indexedDB.deleteDatabase('__diff_test_db')`,
          });
          return {
            hasNames: (result.databaseNames?.length || 0) > 0,
            count: result.databaseNames?.length || 0,
            hasTestDb,
          };
        } catch (err) {
          return { hasNames: false, error: err.message };
        }
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'hasTestDb': true },
      },
    },
    {
      id: 'page-getCookies',
      label: 'Page.getCookies',
      run: async (cdp) => {
        try {
          // Set a test cookie
          await cdp.send('Runtime.evaluate', {
            expression: `document.cookie = '__diff_cookie=test_val; path=/'`,
          });
          const result = await cdp.send('Page.getCookies');
          const cookies = result.cookies || [];
          const testCookie = cookies.find(c => c.name === '__diff_cookie');
          return {
            hasCookies: cookies.length > 0,
            count: cookies.length,
            hasTestCookie: !!testCookie,
            testValue: testCookie?.value,
          };
        } catch (err) {
          return { hasCookies: false, error: err.message };
        }
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'hasTestCookie': true },
      },
    },
    {
      id: 'storage-getStorageKey',
      label: 'Storage.getStorageKey',
      run: async (cdp) => {
        try {
          const tree = await cdp.send('Page.getResourceTree').catch(() => null);
          const frameId = tree?.frameTree?.frame?.id;
          if (!frameId) return { hasKey: false, error: 'no frameId' };
          const result = await cdp.send('Storage.getStorageKey', {
            ownerOrigin: tree?.frameTree?.frame?.securityOrigin || '',
          });
          return {
            hasKey: !!result.storageKey,
          };
        } catch (err) {
          return { hasKey: false, error: err.message };
        }
      },
      compare: {
        deepCompare: false,
      },
    },
    {
      id: 'storage-sessionStorage-get',
      label: 'DOMStorage.getDOMStorageItems (sessionStorage)',
      run: async (cdp) => {
        try {
          const tree = await cdp.send('Page.getResourceTree').catch(() => null);
          const origin = tree?.frameTree?.frame?.securityOrigin || '';
          const result = await cdp.send('DOMStorage.getDOMStorageItems', {
            storageId: { securityOrigin: origin, isLocalStorage: false },
          });
          const items = result.entries || [];
          const testItem = items.find(([k]) => k === '__diff_session_key');
          return {
            hasItems: items.length > 0,
            count: items.length,
            hasTestItem: !!testItem,
            testValue: testItem?.[1],
          };
        } catch (err) {
          return { hasItems: false, error: err.message };
        }
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'hasTestItem': true, 'testValue': '__diff_session_value' },
      },
    },
    {
      id: 'storage-sessionStorage-set',
      label: 'DOMStorage.setDOMStorageItem (sessionStorage)',
      run: async (cdp) => {
        try {
          const tree = await cdp.send('Page.getResourceTree').catch(() => null);
          const origin = tree?.frameTree?.frame?.securityOrigin || '';
          await cdp.send('DOMStorage.setDOMStorageItem', {
            storageId: { securityOrigin: origin, isLocalStorage: false },
            key: '__diff_session_set',
            value: '__diff_session_set_val',
          });
          const check = await cdp.send('Runtime.evaluate', {
            expression: `sessionStorage.getItem('__diff_session_set')`,
            returnByValue: true,
          });
          // Cleanup
          await cdp.send('Runtime.evaluate', {
            expression: `sessionStorage.removeItem('__diff_session_set')`,
          });
          return { set: check.result?.value === '__diff_session_set_val' };
        } catch (err) {
          return { set: false, error: err.message };
        }
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'set': true },
      },
    },
    {
      id: 'page-deleteCookie',
      label: 'Page.deleteCookie removes a cookie',
      run: async (cdp) => {
        try {
          // Set a cookie to delete
          await cdp.send('Runtime.evaluate', {
            expression: `document.cookie = '__diff_del_cookie=to_delete; path=/'`,
          });
          await new Promise(r => setTimeout(r, 500));
          // Verify it exists
          const before = await cdp.send('Page.getCookies');
          const existsBefore = (before.cookies || []).some(c => c.name === '__diff_del_cookie');
          // Delete it
          await cdp.send('Page.deleteCookie', {
            cookieName: '__diff_del_cookie',
            url: (await cdp.send('Page.getResourceTree')).frameTree?.frame?.url || '',
          });
          await new Promise(r => setTimeout(r, 500));
          // Verify it's gone
          const after = await cdp.send('Page.getCookies');
          const existsAfter = (after.cookies || []).some(c => c.name === '__diff_del_cookie');
          return {
            existedBefore: existsBefore,
            deletedAfter: !existsAfter,
            success: existsBefore && !existsAfter,
          };
        } catch (err) {
          return { success: false, error: err.message };
        }
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'success': true },
      },
    },
  ],
};
