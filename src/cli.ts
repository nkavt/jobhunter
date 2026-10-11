import { warnAboutInsecureSecretFiles } from './config/index.js';
import { createProgram } from './program.js';

await warnAboutInsecureSecretFiles();
await createProgram().parseAsync(process.argv);
