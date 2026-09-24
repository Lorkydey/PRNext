import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../../../', import.meta.url));

test('Flight decoders follow the encoded mode across host environment changes with production React', async () => {
  const encoder = `import React from 'react';import {renderToReadableStream} from 'react-server-dom-webpack/server.node';
    function Child(){return React.createElement('h1',null,'FLIGHT_TREE_OK')};function Root(){return React.createElement(Child)};
    const success=await new Response(renderToReadableStream(React.createElement(Root),{})).text();
    const error=await new Response(renderToReadableStream(React.createElement(function Broken(){throw new Error('DEVELOPMENT_ERROR_MARKER')}),{},{onError:()=> 'known-digest'})).text();
    process.stdout.write(JSON.stringify({success,error}));`;
  const payloads = {};
  for (const mode of ['development', 'production']) {
    const result = await execute(process.execPath, ['--conditions=react-server', '--input-type=module', '-e', encoder], { cwd: root, env: { ...process.env, NODE_ENV: mode } });
    payloads[mode] = JSON.parse(result.stdout);
  }
  const child = `import assert from 'node:assert/strict';import React from 'react';import {renderToString} from 'react-dom/server';
    import {createRequire} from 'node:module';import path from 'node:path';
    import {decodeFlight} from './packages/rustyx/runtime/app-render.mjs';
    const payloads=${JSON.stringify(payloads)};const require=createRequire(import.meta.url);
    // Exercise a guarded module cached empty before Rustyx chooses its mode.
    const developmentFile=path.join(path.dirname(require.resolve('react-server-dom-webpack/client.node')),'cjs/react-server-dom-webpack-client.node.development.js');
    assert.equal(require(developmentFile).createFromNodeStream,undefined);
    assert.equal(typeof React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.getCurrentStack,'undefined');
    for(const [mode,host] of [['development','production'],['production','development'],['development',undefined],['production','test']]){
      if(host===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=host;
      const production=mode==='production';const payload=payloads[mode];
      const promise=decodeFlight(Buffer.from(payload.success),{},process.cwd(),{production});
      assert.equal(process.env.NODE_ENV,host,'decoder loading must restore NODE_ENV synchronously');
      assert.equal(renderToString(await promise),'<h1>FLIGHT_TREE_OK</h1>');
      await assert.rejects(decodeFlight(Buffer.from(payload.error),{},process.cwd(),{production}),error=>{
        assert.equal(error.digest,'known-digest');
        if(production)assert.doesNotMatch(error.message,/DEVELOPMENT_ERROR_MARKER/);else assert.match(error.message,/DEVELOPMENT_ERROR_MARKER/);
        return true;
      });
      assert.equal(process.env.NODE_ENV,host);
    }
    process.stdout.write('matched all modes');`;
  const result = await execute(process.execPath, ['--input-type=module', '-e', child], { cwd: root, env: { ...process.env, NODE_ENV: 'production' } });
  assert.equal(result.stdout, 'matched all modes');
});
