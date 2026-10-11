import { createRequire } from 'node:module';

const [, , compiler, filename] = process.argv;
const ts = createRequire(import.meta.url)(compiler);
const host = {
  ...ts.sys,
  onUnRecoverableConfigFileDiagnostic(diagnostic) {
    process.stderr.write(ts.formatDiagnostics([diagnostic], formatHost));
    process.exit(1);
  },
};
const formatHost = { getCanonicalFileName: name => name, getCurrentDirectory: ts.sys.getCurrentDirectory, getNewLine: () => ts.sys.newLine };
const parsed = ts.getParsedCommandLineOfConfigFile(filename, { noEmit: true }, host);
const diagnostics = parsed.errors.length ? parsed.errors : ts.getPreEmitDiagnostics(ts.createProgram({
  rootNames: parsed.fileNames, options: parsed.options, projectReferences: parsed.projectReferences,
}));
if (diagnostics.length) {
  process.stderr.write(ts.formatDiagnostics(diagnostics, formatHost));
  process.exitCode = 1;
}
