import { runMaintenanceCli } from '../src/production/maintenance-cli';
process.exitCode = runMaintenanceCli(process.argv.slice(2), {
  stdout: (text) => console.log(text), stderr: (text) => console.error(text),
});
