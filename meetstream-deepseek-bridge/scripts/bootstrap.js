// npm start works from an extracted project, without a separate npm install step.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 24 || (major === 24 && minor < 9)) {
  console.error('Install Node.js 24.9 or newer from https://nodejs.org, then reopen Terminal.');
  process.exit(1);
}
const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
const ready = Object.entries(pkg.dependencies).every(([name, version]) => {
  try {
    return (
      JSON.parse(readFileSync(new URL(`../node_modules/${name}/package.json`, import.meta.url)))
        .version === version
    );
  } catch {
    return false;
  }
});
if (!ready) {
  console.log('Preparing the bridge. The first start may take a few minutes.');
  try {
    execFileSync(
      process.execPath,
      [process.env.npm_execpath, 'ci', '--ignore-scripts', '--no-fund', '--no-audit'],
      {
        cwd: root,
        stdio: 'inherit',
        // npm 11 forwards this CLI-only option to lifecycle scripts, but rejects it on local installs.
        // Our dependencies need no install hooks; --ignore-scripts keeps those disabled.
        env: Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => key.toLowerCase() !== 'npm_config_allow_scripts',
          ),
        ),
      },
    );
  } catch {
    console.error('Setup did not finish. Check your internet connection and run npm start again.');
    process.exit(1);
  }
}
