// Run with: node tests/models.cjs
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

let catalog = { models: [{ slug: 'new-model', display_name: 'New Model', supported_reasoning_levels: [{ effort: 'high' }] }, { slug: 'hidden-model', visibility: 'hidden' }] };
let cliError = null;
let calledBinary;
const exportsObject = {};
const source = ts.transpileModule(readFileSync('src/lib/codex-service.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
vm.runInNewContext(source, {
  exports: exportsObject,
  process: { env: { HOME: '/test', PATH: '/test/.local/bin' }, platform: 'linux', arch: 'x64' },
  require(name) {
    if (name === '@vicinae/api') return { environment: { supportPath: '/support' } };
    if (name === 'node:fs/promises') return {
      stat: async () => ({ isFile: () => true }),
      readdir: async () => { throw new Error('Must prefer installed CLI over npm cache'); },
      readFile: async () => JSON.stringify({ models: [{ slug: 'cached-model' }] }),
    };
    if (name === 'node:child_process') return {
      execFile(binary, args, options, callback) {
        calledBinary = binary;
        assert.equal(args.join(' '), 'debug models');
        assert.equal(options.timeout, 15000);
        callback(cliError, JSON.stringify(catalog));
      },
    };
    return require(name);
  },
});
(async () => {
  let models = await exportsObject.getAvailableModels();
  assert.equal(calledBinary, '/test/.local/bin/codex');
  assert.equal(models.length, 1);
  assert.equal(models[0].slug, 'new-model');
  assert.equal(models[0].reasoningLevels[0], 'high');
  catalog = { models: [{ slug: 'another-model' }] };
  assert.equal((await exportsObject.getAvailableModels())[0].slug, 'another-model');
  catalog = { models: [] };
  assert.equal((await exportsObject.getAvailableModels())[0].slug, 'cached-model');
  cliError = new Error('CLI timed out');
  assert.equal((await exportsObject.getAvailableModels())[0].slug, 'cached-model');
  console.log('Model discovery checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
