// Demo application script — external file for Sources panel visibility
'use strict';

function greet(name) {
  console.log(`Hello, ${name}!`);
  return `Hello, ${name}!`;
}

function fibonacci(n) {
  if (n <= 1) return n;
  return fibonacci(n - 1) + fibonacci(n - 2);
}

function processData(items) {
  return items
    .filter(item => item.active)
    .map(item => ({ ...item, processed: true, timestamp: Date.now() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Auto-run on load
console.log('demo-app.js loaded');
greet('DevTools User');
