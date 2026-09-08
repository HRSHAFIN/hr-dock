'use strict';
/** Minimal test harness — no dependencies, honest output, non-zero on failure. */
const results = { pass: 0, fail: 0, failures: [] };

function check(label, condition, detail) {
  if (condition) {
    results.pass++;
    console.log(`  \u2713 ${label}`);
  } else {
    results.fail++;
    results.failures.push(label);
    console.log(`  \u2717 ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function equal(label, actual, expected) {
  check(label, actual === expected, `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

function suite(name, fn) {
  console.log(`\n${name}`);
  fn({ check, equal });
}

function report() {
  console.log(`\n${results.pass} passed, ${results.fail} failed`);
  return results.fail === 0;
}

/** Let modules that require('electron') run under plain Node. */
function stubElectron() {
  const Module = require('module');
  const realLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') {
      return {
        Notification: class {
          static isSupported() { return false; }
          on() {}
          show() {}
        }
      };
    }
    return realLoad(request, parent, isMain);
  };
}

module.exports = { check, equal, suite, report, results, stubElectron };
